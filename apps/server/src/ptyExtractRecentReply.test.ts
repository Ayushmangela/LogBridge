import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Before this, a locally-delivered task's completion was detected but its
 * actual answer never reached the room: "@cat hi" got exactly "On it —
 * hi" and then silence, because nothing ever looked at what the agent
 * said. extractRecentReply renders the session's raw scrollback through
 * the real xterm engine (@xterm/headless, version-pinned to match
 * apps/web's @xterm/xterm) and reads back the plain text — the same
 * approach watchForCompletion's own design notes settled on after a naive
 * substring search on raw bytes proved unworkable (see that file's
 * comment): the CLI redraws via cursor-addressed cell writes
 * (`\x1b[13;6H`), not full repaints, so a real terminal buffer is what's
 * needed to reconstruct what actually ended up on screen, in the right
 * order, regardless of what order the bytes arrived in.
 */
let listeners: Array<(data: string) => void>;
const fakeProc = {
  write: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    listeners.push(cb);
    return { dispose: vi.fn() };
  }),
  onExit: vi.fn(() => ({ dispose: () => {} })),
  kill: vi.fn(),
  resize: vi.fn(),
};

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => fakeProc),
}));

// 100 cols matches production's spawnOrGetPtySession default. A narrower
// terminal was wrapping the (test-only) fallback-shell banner's long path
// line across rows — the wrapped continuation doesn't start with a border
// character, so it slipped past isChromeLine. That banner only appears
// when no real CLI binary resolves (a genuine, separately-covered code
// path); widening the terminal avoids exercising it here by accident.
async function liveSession(agentId: string, cols = 100, rows = 30) {
  const { spawnOrGetPtySession } = await import("./ptyGateway.js");
  const { openDb } = await import("./db.js");
  const db = openDb(":memory:");
  spawnOrGetPtySession(db, `pty-test-${agentId}`, agentId, cols, rows);
  return db;
}

function emit(data: string) {
  for (const l of listeners) l(data);
}

describe("extractRecentReply", () => {
  beforeEach(() => {
    listeners = [];
    fakeProc.write.mockClear();
  });

  test("reconstructs correctly-ordered text from cursor-addressed writes, not raw byte order", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    await liveSession("agt_cursor");

    // Mirrors the real capture: the SECOND line is written to the screen
    // first, then the cursor jumps up to fill in the first — exactly the
    // out-of-order pattern that broke a naive substring/byte-order read.
    // \x1b[2K clears each line before writing it (matches real output) so
    // leftover characters from the session's own startup banner, sitting
    // on these same rows from the earlier full-buffer write, don't bleed
    // through past the end of the new, shorter text.
    emit("\x1b[2;1H\x1b[2KSecond line of the reply");
    emit("\x1b[1;1H\x1b[2KFirst line of the reply");

    const text = await extractRecentReply("agt_cursor");
    expect(text).toBe("First line of the reply\nSecond line of the reply");
  });

  // A live "@cat hi" once posted the reply "╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  // ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"
  // straight into the chat room — a leftover progress-bar row, not text —
  // because the individual box/block characters it used weren't on the
  // hand-picked exclusion list. Fixed by matching whole Unicode blocks
  // (Box Drawing, Block Elements, Braille) instead of enumerating
  // characters; this reproduces the exact bytes from that incident.
  test("drops a stray progress-bar row (the exact bytes from a real incident), keeps the real answer", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    await liveSession("agt_progressbar");

    emit("\x1b[1;1HHi there! How can I help with the Samsung site today?\r\n");
    emit("\x1b[3;1H╹" + "▀".repeat(95) + "\r\n");

    const text = await extractRecentReply("agt_progressbar");
    expect(text).toContain("Hi there!");
    expect(text).not.toMatch(/[─-◿⠀-⣿]/);
  });

  test("drops CLI chrome (input placeholder, footer hints) but keeps the real answer", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    await liveSession("agt_chrome");

    emit("\x1b[1;1HHello! I'm doing well, thanks for asking.\r\n");
    emit("\x1b[3;1HAsk anything... \"Fix a TODO in the codebase\"\r\n");
    emit("\x1b[4;1Htab agents  ctrl+p commands\r\n");

    const text = await extractRecentReply("agt_chrome");
    expect(text).toContain("Hello! I'm doing well");
    expect(text).not.toContain("Ask anything");
    expect(text).not.toContain("ctrl+p");
  });

  test("returns null for an agent with no live session", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    expect(await extractRecentReply("agt_never_spawned")).toBeNull();
  });

  test("returns null when the screen has nothing but chrome", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    await liveSession("agt_empty");

    emit("\x1b[1;1HAsk anything...\r\n");

    expect(await extractRecentReply("agt_empty")).toBeNull();
  });

  test("truncates a very long reply rather than flooding the chat room", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    await liveSession("agt_long", 200, 40);

    for (let i = 0; i < 30; i++) {
      emit(`\x1b[${i + 1};1HLine ${i}: ${"x".repeat(120)}\r\n`);
    }

    const text = (await extractRecentReply("agt_long", 500))!;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith("…")).toBe(true);
  });

  // Live, from "@cat hi": the reply that reached chat was just "mmands" —
  // the tail of the CLI's footer hint ("tab agents  ctrl+p commands")
  // after it soft-wrapped across two terminal columns. isChromeLine
  // correctly dropped the row carrying "tab agents  ctrl+p co", but the
  // wrapped remainder landed on its own row with no border character and
  // no CHROME_LINE_MARKERS substring left in it — nothing marked it as
  // chrome, so it was posted as if it were cat's actual answer.
  //
  // The first fix here was a text-shape guess: reject anything opening
  // lowercase, on the theory that a real reply always opens with a capital
  // letter. Also caught live, on the very next real exchange: "@bob say hi
  // back to me" got the correct, genuine reply "hi" — which that guess
  // rejected too, for the identical reason. A real one-word answer and a
  // wrapped mid-word fragment are indistinguishable by shape alone. The
  // actual fix uses xterm's own isWrapped flag on the buffer line: it is
  // the terminal's own record of "this row does not start a new line, it
  // continues the row above" — precise where a shape guess can only
  // approximate, and approximated wrongly in both directions.
  describe("wrapped chrome vs. a genuine short reply", () => {
    test("the exact live incident: a chrome line's real soft-wrap continuation is dropped", async () => {
      const { extractRecentReply } = await import("./ptyGateway.js");
      // 22 cols is the real capture's exact wrap point: "tab agents  ctrl+p
      // co" (22 chars) on row 1, "mmands" continuing on row 2. No manual
      // cursor jump — writing it as one continuous string lets xterm wrap
      // it itself and set isWrapped on row 2, exactly as it would for a
      // real CLI's continuous footer-hint output.
      await liveSession("agt_fragment", 22, 10);

      emit("tab agents  ctrl+p commands");

      expect(await extractRecentReply("agt_fragment")).toBeNull();
    });

    test("a genuine short lowercase reply is posted as-is — the false positive from the first fix", async () => {
      const { extractRecentReply } = await import("./ptyGateway.js");
      await liveSession("agt_hi");

      emit("\x1b[1;1Hhi\r\n");

      expect(await extractRecentReply("agt_hi")).toBe("hi");
    });

    test("a genuine reply that happens to start with a capital letter is unaffected", async () => {
      const { extractRecentReply } = await import("./ptyGateway.js");
      await liveSession("agt_real");

      emit("\x1b[1;1HYes, I'm online and standing by for review work.\r\n");

      expect(await extractRecentReply("agt_real")).toBe("Yes, I'm online and standing by for review work.");
    });

    test("a reply opening with a digit, quote, or bullet is unaffected", async () => {
      const { extractRecentReply } = await import("./ptyGateway.js");
      await liveSession("agt_bullet");

      emit('\x1b[1;1H"Done — see faq.json for the full list."\r\n');

      expect(await extractRecentReply("agt_bullet")).toContain("Done");
    });
  });
});
