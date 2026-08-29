import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * A TUI CLI (OpenCode, Claude Code) switches the terminal into raw mode as
 * part of its own boot. Three call sites used to spawn a PTY and write into
 * it in the same breath — deliverTaskLocally (task-offers.ts) and both of
 * index.ts's hive-wake spawn callbacks — and each independently lost the
 * write on a cold boot: the CLI's welcome screen would sit there forever
 * with nothing actually typed into it, no error, no signal anything went
 * wrong. spawnAndSubmit is the one place that fix now lives; this tests it
 * directly rather than through each of its three callers.
 */
const writeMock = vi.fn();
const fakeProc = { write: writeMock, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn() };

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => fakeProc),
}));

describe("spawnAndSubmit waits out a cold PTY boot before writing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a freshly spawned session is not written to until the CLI has had time to boot", async () => {
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");

    const db = openDb(":memory:");
    const ok = spawnAndSubmit(db, "agt_cold_1", "commando", "develop the samsung website");
    expect(ok).toBe(true);

    // Nothing written yet — the CLI is still "booting".
    expect(writeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(writeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(writeMock).toHaveBeenCalledWith("develop the samsung website");
  });

  test("an already-live session is written to immediately, no delay", async () => {
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");

    const db = openDb(":memory:");
    // First call establishes the session (cold — its own write is delayed).
    spawnAndSubmit(db, "agt_warm_1", "alex", "first message");
    await vi.advanceTimersByTimeAsync(6500);
    writeMock.mockClear();

    // Second call re-uses the now-live session.
    const ok = spawnAndSubmit(db, "agt_warm_1", "alex", "second message");
    expect(ok).toBe(true);
    expect(writeMock).toHaveBeenCalledWith("second message");
  });
});
