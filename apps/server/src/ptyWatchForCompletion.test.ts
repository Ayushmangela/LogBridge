import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Before this, a locally-delivered task (deliverTaskLocally, task-offers.ts)
 * had no completion signal at all: it stayed `working` — and the agent
 * stayed "busy" — until a human noticed and called
 * POST /api/tasks/:id/complete by hand.
 *
 * The first design here matched PTY output against the same "ready for
 * input" banner text doSeed() uses for a fresh boot. Verified against a
 * real OpenCode session mid-task (raw capture over /pty-ws): after the
 * initial boot paint, all further screen updates are cursor-addressed cell
 * writes (`\x1b[13;6H`, one write per changed region) — the literal
 * substring "Ask anything" never reappears, so that design would simply
 * never fire past the first prompt. watchForCompletion instead treats
 * sustained silence after a task was submitted as completion — verified,
 * on that same capture, that real output actually stops once a turn
 * finishes (no blink-loop or periodic redraw filling the gap).
 */
type Listener = (data: string) => void;
let listeners: Listener[];
const fakeProc = {
  write: vi.fn(),
  onData: vi.fn((cb: Listener) => {
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

function emit(data: string) {
  for (const l of listeners) l(data);
}

describe("watchForCompletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    fakeProc.write.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function liveSession(agentId: string) {
    const { spawnOrGetPtySession } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    spawnOrGetPtySession(db, `pty-test-${agentId}`, agentId, 80, 24);
    return db;
  }

  test("fires onDone once output has been quiet for quietMs", async () => {
    const { watchForCompletion } = await import("./ptyGateway.js");
    await liveSession("agt_x");

    const onDone = vi.fn();
    watchForCompletion("agt_x", onDone, { graceMs: 1000, quietMs: 2000 });

    // Real, ongoing work — cursor-addressed cell writes, no readable banner.
    await vi.advanceTimersByTimeAsync(1200); // past graceMs
    emit("\x1b[13;6Hbuilding the product grid\x1b[0m");
    expect(onDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500); // under quietMs since last chunk
    expect(onDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600); // now past quietMs of silence
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("does not fire during graceMs even if output goes quiet immediately", async () => {
    const { watchForCompletion } = await import("./ptyGateway.js");
    await liveSession("agt_boot");

    const onDone = vi.fn();
    watchForCompletion("agt_boot", onDone, { graceMs: 4000, quietMs: 1000 });

    // No output at all — still shouldn't fire before grace elapses, since
    // the quiet clock only starts once real output is observed post-grace.
    await vi.advanceTimersByTimeAsync(3000);
    expect(onDone).not.toHaveBeenCalled();
  });

  test("new output resets the quiet timer — work continuing does not fire early", async () => {
    const { watchForCompletion } = await import("./ptyGateway.js");
    await liveSession("agt_flash");

    const onDone = vi.fn();
    watchForCompletion("agt_flash", onDone, { graceMs: 0, quietMs: 1000 });

    emit("\x1b[13;6Hpart one\x1b[0m");
    await vi.advanceTimersByTimeAsync(700); // under quietMs
    emit("\x1b[13;20Hpart two — still working\x1b[0m");
    await vi.advanceTimersByTimeAsync(700); // would have fired if not reset
    expect(onDone).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400); // now past quietMs since part two
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("fires only once even if more output arrives after firing", async () => {
    const { watchForCompletion } = await import("./ptyGateway.js");
    await liveSession("agt_once");

    const onDone = vi.fn();
    watchForCompletion("agt_once", onDone, { graceMs: 0, quietMs: 200 });

    emit("\x1b[13;6Hdone building\x1b[0m");
    await vi.advanceTimersByTimeAsync(300);
    expect(onDone).toHaveBeenCalledTimes(1);

    // The unsubscribe already disposed the listener, so a later emit is a
    // no-op here in the test too — this proves onDone is not called twice.
    emit("\x1b[13;6Hmore text somehow\x1b[0m");
    await vi.advanceTimersByTimeAsync(300);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("the unsubscribe function stops future firing", async () => {
    const { watchForCompletion } = await import("./ptyGateway.js");
    await liveSession("agt_unsub");

    const onDone = vi.fn();
    const unsubscribe = watchForCompletion("agt_unsub", onDone, { graceMs: 0, quietMs: 200 });
    unsubscribe();

    emit("\x1b[13;6Hsome output\x1b[0m");
    await vi.advanceTimersByTimeAsync(300);
    expect(onDone).not.toHaveBeenCalled();
  });

  test("an agent with no live session is a harmless no-op", async () => {
    const { watchForCompletion } = await import("./ptyGateway.js");
    const onDone = vi.fn();
    const unsubscribe = watchForCompletion("agt_never_spawned", onDone);
    expect(() => unsubscribe()).not.toThrow();
  });
});
