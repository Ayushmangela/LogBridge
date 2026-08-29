import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createTask } from "./db.js";

/**
 * "@cat hi" got exactly "On it — hi" back and then silence forever — the
 * task machinery detected completion (once watchForCompletion existed) but
 * nothing ever looked at what the agent actually said and put it where the
 * human was looking. This tests deliverTaskLocally's own orchestration —
 * that a completion callback correctly chains extractRecentReply -> postChat
 * -> completeLocalTask, in that order, with the right arguments — using
 * mocks for the underlying mechanisms, each of which has its own direct
 * tests: ptySpawnAndSubmit.test.ts, ptyWatchForCompletion.test.ts,
 * ptyExtractRecentReply.test.ts.
 */
let submittedCallback: (() => void) | null = null;
let completionCallback: (() => void) | null = null;

vi.mock("./ptyGateway.js", () => ({
  spawnAndSubmit: vi.fn((_db, _agentId, _agentName, _prompt, _hive, onSubmitted) => {
    submittedCallback = onSubmitted ?? null;
    return true;
  }),
  watchForCompletion: vi.fn((_agentId, onDone) => {
    completionCallback = onDone;
    return () => {};
  }),
  extractRecentReply: vi.fn(async () => "Hi! What can I help you build today?"),
}));

describe("deliverTaskLocally posts the agent's actual reply to chat", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "logbridge-reply-chain-"));
    submittedCallback = null;
    completionCallback = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  async function setup() {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T', ?)").run(dir);
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_cat','m1','u1','prj_t','cat','review', ?, 'idle', 0)`
    ).run(dir);
    const taskId = createTask(db, {
      projectId: "prj_t", title: "hi", spec: "hi",
      creatorId: "you", agentId: "agt_cat",
    });
    return { db, taskId };
  }

  test("postChat receives the agent id, name, and extracted reply text once the task completes", async () => {
    const { extractRecentReply } = await import("./ptyGateway.js");
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");
    const { db, taskId } = await setup();

    const postChat = vi.fn();
    deliverTaskLocally(db, new Map(), taskId, undefined, postChat);

    // Simulate spawnAndSubmit's own async delivery, then watchForCompletion
    // deciding the CLI has gone quiet.
    submittedCallback!();
    expect(completionCallback).toBeTruthy();
    completionCallback!();

    // extractRecentReply is itself async — let its promise settle.
    await vi.waitFor(() => expect(postChat).toHaveBeenCalled());

    expect(extractRecentReply).toHaveBeenCalledWith("agt_cat");
    expect(postChat).toHaveBeenCalledWith("agt_cat", "cat", "Hi! What can I help you build today?");
  });

  test("the task is marked completed only after the reply was posted, not before", async () => {
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");
    const { db, taskId } = await setup();

    const order: string[] = [];
    const postChat = vi.fn(() => order.push("postChat"));
    deliverTaskLocally(db, new Map(), taskId, undefined, postChat);

    submittedCallback!();
    completionCallback!();

    await vi.waitFor(() => {
      const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
      order.push(task.state === "completed" ? "completed" : "not-yet");
      expect(task.state).toBe("completed");
    });

    expect(order.indexOf("postChat")).toBeLessThan(order.lastIndexOf("completed"));
  });

  // A null reply used to mean total silence — the task completed, the
  // agent went idle, and the human never saw anything at all. That is the
  // exact same dead end "@cat hi" -> "On it" -> nothing was, just reached
  // by a different path (extraction filtering everything out instead of
  // never running at all). A short, honest fallback closes it instead.
  test("no readable reply text still posts an honest fallback note, not silence", async () => {
    const ptyGateway = await import("./ptyGateway.js");
    (ptyGateway.extractRecentReply as any).mockResolvedValueOnce(null);
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");
    const { db, taskId } = await setup();

    const postChat = vi.fn();
    deliverTaskLocally(db, new Map(), taskId, undefined, postChat);
    submittedCallback!();
    completionCallback!();

    await vi.waitFor(() => {
      const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
      expect(task.state).toBe("completed");
    });
    expect(postChat).toHaveBeenCalledTimes(1);
    const [agentId, agentName, text] = postChat.mock.calls[0];
    expect(agentId).toBe("agt_cat");
    expect(agentName).toBe("cat");
    // The message must be honest about what happened — it must not read as
    // if the agent said nothing, or as if it were the agent's real answer.
    expect(text.toLowerCase()).toMatch(/terminal|nothing readable/);
  });

  test("without a postChat callback, a null reply still completes cleanly (nothing to call)", async () => {
    const ptyGateway = await import("./ptyGateway.js");
    (ptyGateway.extractRecentReply as any).mockResolvedValueOnce(null);
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");
    const { db, taskId } = await setup();

    deliverTaskLocally(db, new Map(), taskId); // no postChat arg at all
    submittedCallback!();
    completionCallback!();

    await vi.waitFor(() => {
      const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
      expect(task.state).toBe("completed");
    });
  });

  test("without a postChat callback, completion still happens (the caller just doesn't want the reply posted)", async () => {
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");
    const { db, taskId } = await setup();

    deliverTaskLocally(db, new Map(), taskId); // no postChat arg at all
    submittedCallback!();
    completionCallback!();

    await vi.waitFor(() => {
      const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
      expect(task.state).toBe("completed");
    });
  });
});
