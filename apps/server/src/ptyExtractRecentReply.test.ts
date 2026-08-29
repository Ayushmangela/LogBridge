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
    emit("\x1b[2;1H\x1b[2Ksecond line of the reply");
    emit("\x1b[1;1H\x1b[2Kfirst line of the reply");

    const text = await extractRecentReply("agt_cursor");
    expect(text).toBe("first line of the reply\nsecond line of the reply");
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
      emit(`\x1b[${i + 1};1Hline ${i}: ${"x".repeat(120)}\r\n`);
    }

    const text = (await extractRecentReply("agt_long", 500))!;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith("…")).toBe(true);
  });
});
