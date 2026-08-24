// The orchestrator's routing rules (ORCHESTRATOR.md). pickAgent() is pure, so
// the decision logic is tested directly; assignPendingTasks() is tested against
// a real database because the parts that actually break are the ones that
// involve state — double-assignment, capacity accounting, and queue drain.
import { describe, expect, test } from "vitest";
import {
  activeTaskCountsByAgent, assignTaskToAgent, candidateAgents, createTask,
  openDb, pendingUnassignedTasks, type Db,
} from "./db.js";
import { assignPendingTasks, pickAgent, type AgentCandidate } from "./orchestrator.js";

const agent = (over: Partial<AgentCandidate> = {}): AgentCandidate => ({
  id: "agt_a", name: "dev-a", capabilities: ["run_tests"], concurrency: 1, machineOnline: true, ...over,
});

describe("pickAgent", () => {
  test("requires the capability when one is asked for", () => {
    const cands = [agent({ id: "agt_a", capabilities: ["docs"] }), agent({ id: "agt_b", capabilities: ["run_tests"] })];
    expect(pickAgent(cands, new Map(), "run_tests")?.id).toBe("agt_b");
    expect(pickAgent([agent({ capabilities: ["docs"] })], new Map(), "run_tests")).toBeNull();
  });

  test("with no capability required, anyone free will do", () => {
    expect(pickAgent([agent({ capabilities: [] })], new Map(), null)).not.toBeNull();
  });

  test("never picks an agent whose machine is offline", () => {
    expect(pickAgent([agent({ machineOnline: false })], new Map(), null)).toBeNull();
    const cands = [agent({ id: "agt_off", machineOnline: false }), agent({ id: "agt_on" })];
    expect(pickAgent(cands, new Map(), null)?.id).toBe("agt_on");
  });

  test("respects concurrency — a full agent is not eligible", () => {
    expect(pickAgent([agent({ id: "agt_a", concurrency: 1 })], new Map([["agt_a", 1]]), null)).toBeNull();
    expect(pickAgent([agent({ id: "agt_a", concurrency: 3 })], new Map([["agt_a", 2]]), null)?.id).toBe("agt_a");
  });

  test("prefers the least loaded, and breaks ties deterministically", () => {
    const cands = [agent({ id: "agt_c", concurrency: 5 }), agent({ id: "agt_a", concurrency: 5 }), agent({ id: "agt_b", concurrency: 5 })];
    expect(pickAgent(cands, new Map([["agt_c", 0], ["agt_a", 2], ["agt_b", 1]]), null)?.id).toBe("agt_c");
    // all equal -> lowest id, every time (same input, same answer)
    const flat = new Map([["agt_a", 1], ["agt_b", 1], ["agt_c", 1]]);
    for (let i = 0; i < 5; i++) expect(pickAgent(cands, flat, null)?.id).toBe("agt_a");
  });

  test("no candidates at all is null, not a crash", () => {
    expect(pickAgent([], new Map(), null)).toBeNull();
  });
});

// ---- against a real database ----

function seed(db: Db, opts: { online?: boolean; concurrency?: number } = {}) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run("prj_a", "a/a", "a/a", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, 0)").run("usr_1", "sam", "sam");
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)")
    .run("node_1", "usr_1", "mbp", new Date().toISOString(), opts.online === false ? 0 : 1);
  db.prepare(
    "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')"
  ).run("agt_a", "node_1", "usr_1", "prj_a", "dev-a", "developer", JSON.stringify(["run_tests"]), opts.concurrency ?? 1);
}

const submit = (db: Db, title: string, cap: string | null = null) =>
  createTask(db, { projectId: "prj_a", title, creatorId: "you", agentId: null, requiredCapability: cap });

const taskAgent = (db: Db, id: string) =>
  (db.prepare("SELECT agent_id FROM tasks WHERE id = ?").get(id) as any)?.agent_id ?? null;

describe("assignPendingTasks", () => {
  test("assigns an unassigned task to a capable agent and logs why", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = submit(db, "run the suite", "run_tests");

    expect(assignPendingTasks(db)).toEqual([{ taskId: t, agentId: "agt_a" }]);
    expect(taskAgent(db, t)).toBe("agt_a");

    const ev = db.prepare("SELECT * FROM events WHERE type = 'task.assigned'").get() as any;
    expect(JSON.parse(ev.body)).toMatchObject({ agentId: "agt_a", by: "orchestrator" });
  });

  test("a task nobody is capable of stays queued rather than failing", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = submit(db, "design the logo", "graphic_design");

    expect(assignPendingTasks(db)).toEqual([]);
    expect(taskAgent(db, t)).toBeNull();
    // Still submitted — "nobody is free" is a queue, not an error.
    expect((db.prepare("SELECT state FROM tasks WHERE id = ?").get(t) as any).state).toBe("submitted");
  });

  test("nothing is assigned while the only machine is offline, then it drains when it returns", () => {
    const db = openDb(":memory:");
    seed(db, { online: false });
    const t = submit(db, "run the suite", "run_tests");
    expect(assignPendingTasks(db)).toEqual([]);

    db.prepare("UPDATE machines SET online = 1 WHERE id = 'node_1'").run();
    expect(assignPendingTasks(db)).toEqual([{ taskId: t, agentId: "agt_a" }]);
  });

  test("does not overfill an agent within a single pass", () => {
    const db = openDb(":memory:");
    seed(db, { concurrency: 2 });
    const t1 = submit(db, "one");
    const t2 = submit(db, "two");
    const t3 = submit(db, "three");

    // concurrency 2 -> exactly two get assigned now, the third waits
    const assigned = assignPendingTasks(db);
    expect(assigned).toHaveLength(2);
    expect(taskAgent(db, t3)).toBeNull();
    expect(activeTaskCountsByAgent(db).get("agt_a")).toBe(2);

    // finishing one frees exactly one slot
    db.prepare("UPDATE tasks SET state = 'completed' WHERE id = ?").run(t1);
    expect(assignPendingTasks(db)).toEqual([{ taskId: t3, agentId: "agt_a" }]);
    expect([t1, t2, t3].map((t) => taskAgent(db, t))).toEqual(["agt_a", "agt_a", "agt_a"]);
  });

  test("queue is drained oldest-first", () => {
    const db = openDb(":memory:");
    seed(db, { concurrency: 1 });
    const first = createTask(db, { projectId: "prj_a", title: "older", creatorId: "you", agentId: null });
    db.prepare("UPDATE tasks SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(first);
    const second = createTask(db, { projectId: "prj_a", title: "newer", creatorId: "you", agentId: null });
    db.prepare("UPDATE tasks SET created_at = '2030-01-01T00:00:00.000Z' WHERE id = ?").run(second);

    expect(assignPendingTasks(db)[0].taskId).toBe(first);
  });

  test("tasks submitted within the same millisecond still drain in submission order", () => {
    // created_at is millisecond-resolution, so a burst of submissions shares
    // a timestamp. Ordering must fall back to insertion order (rowid), not to
    // a random UUID — otherwise the queue is arbitrary rather than FIFO.
    const db = openDb(":memory:");
    seed(db, { concurrency: 1 });
    const ids = ["first", "second", "third", "fourth"].map((t) => submit(db, t));
    const stamp = new Date().toISOString();
    db.prepare("UPDATE tasks SET created_at = ?").run(stamp); // force an exact tie

    const drained: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const got = assignPendingTasks(db);
      expect(got).toHaveLength(1);
      drained.push(got[0].taskId);
      db.prepare("UPDATE tasks SET state = 'completed' WHERE id = ?").run(got[0].taskId);
    }
    expect(drained).toEqual(ids);
  });

  test("running it twice does not double-assign or duplicate the event", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = submit(db, "run the suite", "run_tests");
    assignPendingTasks(db);
    expect(assignPendingTasks(db)).toEqual([]); // nothing left pending
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task.assigned'").get() as any).n
    ).toBe(1);
  });

  test("a task already assigned by hand is left alone", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = createTask(db, { projectId: "prj_a", title: "hand-picked", creatorId: "you", agentId: "agt_a" });
    expect(pendingUnassignedTasks(db).map((p) => p.id)).not.toContain(t);
    expect(assignPendingTasks(db)).toEqual([]);
  });

  test("assignTaskToAgent refuses to steal a task that is already claimed", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = submit(db, "run the suite");
    expect(assignTaskToAgent(db, t, "agt_a")).toBe(true);
    expect(assignTaskToAgent(db, t, "agt_other")).toBe(false); // guard holds
    expect(taskAgent(db, t)).toBe("agt_a");
  });

  test("only agents in the task's own project are candidates", () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run("prj_b", "b/b", "b/b", "office");
    expect(candidateAgents(db, "prj_b")).toHaveLength(0);
    const t = createTask(db, { projectId: "prj_b", title: "other room", creatorId: "you", agentId: null });
    expect(assignPendingTasks(db)).toEqual([]);
    expect(taskAgent(db, t)).toBeNull();
  });
});
