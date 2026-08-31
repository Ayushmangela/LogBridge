import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Identity freshness and write serialisation — AGENT-PROMPTING.md §3.2, §3.4.
 *
 * Two problems that shared a cause: nothing tracked what a live session had
 * already been told, and nothing sequenced who was allowed to type into it.
 *
 *  - RESTART re-sent the whole ~900-token identity into a session that already
 *    had it. Because the duplicate landed AFTER real work, the newest
 *    instruction the model saw became "you are an agent, read your inbox" —
 *    which is why a restarted agent abandoned whatever it was doing.
 *
 *  - The human's keystrokes, router wake notices and task submissions all
 *    wrote straight to the same pipe. A wake arriving mid-sentence interleaved
 *    with what was being typed.
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

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function seedAgent(db: any, id: string, provider = "claude", model = "sonnet") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_i", "t/r", "t/r", "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)")
    .run("usr_i", "i", "i", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)")
    .run("node_i", "usr_i", "m", new Date().toISOString(), 1);
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role,
       capabilities, concurrency, status, provider, model)
     VALUES (?,?,?,?,?,?,?,1,'idle',?,?)`
  ).run(id, "node_i", "usr_i", "prj_i", "dev-i", "developer", "[]", provider, model);
}

describe("identity is re-sent only when it is actually needed", () => {
  beforeEach(() => { writeMock.mockClear(); dataHandler = null; });

  test("a cold start needs identity", async () => {
    const { needsIdentity } = await import("./ptyGateway.js");
    // No session at all — there is nothing that could remember it.
    expect(needsIdentity("agt_never_spawned", "IDENTITY TEXT", "claude:sonnet")).toBe(true);
  });

  test("a live session that already has it does NOT", async () => {
    const { spawnOrGetPtySession, needsIdentity } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    seedAgent(db, "agt_id_1");

    spawnOrGetPtySession(db, "pty-devi-agt_id_1", "agt_id_1");
    // The identity this session was actually seeded with.
    const { buildEmployeeHivePrompt } = await import("./hivePrompt.js");
    const identity = buildEmployeeHivePrompt({
      agentId: "agt_id_1", agentName: "dev-i", folder: process.cwd(), role: "developer",
    });

    // This is the restart case: same prompt, same engine, live session.
    expect(needsIdentity("agt_id_1", identity, "claude:sonnet")).toBe(false);
  });

  test("a CHANGED MODEL needs identity — the new model has none of the context", async () => {
    const { spawnOrGetPtySession, needsIdentity } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    seedAgent(db, "agt_id_2", "claude", "sonnet");
    spawnOrGetPtySession(db, "pty-devi-agt_id_2", "agt_id_2");

    const { buildEmployeeHivePrompt } = await import("./hivePrompt.js");
    const identity = buildEmployeeHivePrompt({
      agentId: "agt_id_2", agentName: "dev-i", folder: process.cwd(), role: "developer",
    });

    expect(needsIdentity("agt_id_2", identity, "claude:sonnet")).toBe(false);
    expect(needsIdentity("agt_id_2", identity, "opencode:qwen")).toBe(true);
  });

  test("an EDITED prompt needs identity — otherwise live agents keep the old rules", async () => {
    const { spawnOrGetPtySession, needsIdentity } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    seedAgent(db, "agt_id_3");
    spawnOrGetPtySession(db, "pty-devi-agt_id_3", "agt_id_3");

    expect(needsIdentity("agt_id_3", "COMPLETELY DIFFERENT PROMPT TEXT", "claude:sonnet")).toBe(true);
  });

  test("force overrides everything, for an operator who wants a full re-introduction", async () => {
    const { spawnOrGetPtySession, needsIdentity } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    seedAgent(db, "agt_id_4");
    spawnOrGetPtySession(db, "pty-devi-agt_id_4", "agt_id_4");

    const { buildEmployeeHivePrompt } = await import("./hivePrompt.js");
    const identity = buildEmployeeHivePrompt({
      agentId: "agt_id_4", agentName: "dev-i", folder: process.cwd(), role: "developer",
    });
    expect(needsIdentity("agt_id_4", identity, "claude:sonnet", { force: true })).toBe(true);
  });
});

describe("writes to one PTY are serialised", () => {
  beforeEach(() => { writeMock.mockClear(); dataHandler = null; });

  test("concurrent submissions arrive whole and in order, never interleaved", async () => {
    const { spawnOrGetPtySession, submitPromptToAgent } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    seedAgent(db, "agt_w_1");
    spawnOrGetPtySession(db, "pty-devi-agt_w_1", "agt_w_1");
    writeMock.mockClear();

    // Three writers racing for one pipe: a task submission, a router wake and
    // a human. Fired in the same tick, which is exactly when they collided.
    submitPromptToAgent("agt_w_1", "first");
    submitPromptToAgent("agt_w_1", "second");
    submitPromptToAgent("agt_w_1", "third");
    await flush();

    const payloads = writeMock.mock.calls.map((c) => c[0]).filter((p) => p !== "\r");
    expect(payloads).toEqual(["first", "second", "third"]);
  });

  test("a write to a dead process cannot break the queue for later writes", async () => {
    const { spawnOrGetPtySession, submitPromptToAgent } = await import("./ptyGateway.js");
    const { openDb } = await import("./db.js");
    const db = openDb(":memory:");
    seedAgent(db, "agt_w_2");
    spawnOrGetPtySession(db, "pty-devi-agt_w_2", "agt_w_2");
    writeMock.mockClear();

    // One write throws, as it would against an exited process.
    writeMock.mockImplementationOnce(() => { throw new Error("EIO: process gone"); });
    submitPromptToAgent("agt_w_2", "boom");
    submitPromptToAgent("agt_w_2", "after");
    await flush();

    // The chain survives — a rejected link used to poison every later write.
    expect(writeMock.mock.calls.map((c) => c[0])).toContain("after");
  });
});
