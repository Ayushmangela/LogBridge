import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * A TUI CLI (OpenCode, Claude Code) switches the terminal into raw mode as
 * part of its own boot. Three call sites used to spawn a PTY and write into it
 * in the same breath — deliverTaskLocally and both of index.ts's hive-wake
 * spawn callbacks — and each independently lost the write on a cold boot: the
 * welcome screen sat there forever with nothing typed into it, no error.
 * spawnAndSubmit is the one place that fix lives.
 *
 * HOW THE FIX CHANGED. It was `setTimeout(..., 6000)` — a guess that was wrong
 * in both directions: a slow cold start still swallowed the prompt, and a fast
 * one wasted five seconds. These tests used to assert the timer itself
 * ("advance 6.5s, expect a write"), which pinned the guess rather than the
 * requirement. What actually matters is:
 *
 *   never write before the CLI can accept input;
 *   write as soon as it can;
 *   never write at all if it never comes up.
 *
 * So they now drive the CLI's own readiness banner instead of the clock.
 */
const writeMock = vi.fn();
let dataHandler: ((d: string) => void) | null = null;

const fakeProc = {
  write: writeMock,
  onData: vi.fn((cb: (d: string) => void) => { dataHandler = cb; }),
  onExit: vi.fn(),
  kill: vi.fn(),
  resize: vi.fn(),
};

vi.mock("node-pty", () => ({ spawn: vi.fn(() => fakeProc) }));

/** One of READY_MARKERS — what a real CLI prints when it wants input. */
const READY_BANNER = "Ask anything";

/** Let queued writes (a promise chain) and any resolved awaits actually run. */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("spawnAndSubmit waits for the CLI to be ready, not for a timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeMock.mockClear();
    dataHandler = null;
  });
  afterEach(() => { vi.useRealTimers(); });

  test("nothing is written while the CLI is still booting", async () => {
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");

    const ok = spawnAndSubmit(openDb(":memory:"), "agt_cold_1", "commando", "develop the samsung website");
    expect(ok).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();

    // Well past the old 6s guess. Still booting, so still nothing — the old
    // code would have typed into a dead terminal here.
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("the prompt is written the moment the CLI signals readiness", async () => {
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");

    spawnAndSubmit(openDb(":memory:"), "agt_cold_2", "commando", "develop the samsung website");
    expect(writeMock).not.toHaveBeenCalled();

    // The CLI prints its prompt banner — this is the real signal.
    expect(dataHandler).toBeTypeOf("function");
    dataHandler!(READY_BANNER);
    await flush();

    expect(writeMock).toHaveBeenCalledWith("develop the samsung website");
  });

  test("a CLI that never becomes ready is never written to", async () => {
    // Silently typing into a CLI that never came up is how a message gets
    // swallowed. Past the 45s ceiling it must simply not be sent, leaving
    // retry/dead-letter to see an undelivered message.
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");

    spawnAndSubmit(openDb(":memory:"), "agt_cold_3", "commando", "never lands");
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(writeMock).not.toHaveBeenCalledWith("never lands");
  });

  test("an already-live session is written to without waiting", async () => {
    const { spawnAndSubmit, isPtySessionLive } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");

    // First call creates the session; readiness lets its prompt through.
    spawnAndSubmit(db, "agt_live_1", "commando", "first");
    dataHandler!(READY_BANNER);
    await flush();
    expect(isPtySessionLive("agt_live_1")).toBe(true);
    writeMock.mockClear();

    // Second call finds it live: no readiness wait at all.
    spawnAndSubmit(db, "agt_live_1", "commando", "second");
    await flush();
    expect(writeMock).toHaveBeenCalledWith("second");
  });
});
