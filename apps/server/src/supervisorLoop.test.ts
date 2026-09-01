// evaluateWorkflowHealth() and executeSupervisorAction() could always pause,
// cancel, reassign and retry — but only through an HTTP route a human clicked.
// Nothing watched, so a workflow could sit BLOCKED indefinitely while the code
// that knew it was blocked stayed silent.
//
// The load-bearing test here is the one asserting what the loop REFUSES to do
// on its own.
import { describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { superviseOnce } from "./supervisorLoop.js";

function seed(db: Db, opts: { agentOnline?: boolean } = {}) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_s", "x/s", "S", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_s", "s", "S", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)")
    .run("node_s", "usr_s", "m", opts.agentOnline === false ? 0 : 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("agt_s", "node_s", "usr_s", "prj_s", "Ada", "developer", JSON.stringify(["implement_feature"]), 1, "idle");
  db.prepare(
    `INSERT INTO workflows (id, project_id, title, creator_id, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run("wf_1", "prj_s", "Ship OAuth", "usr_s", "active", now, now);
  return db;
}

function task(db: Db, opts: { id: string; state: string; capability?: string | null }) {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, required_capability, workflow_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(opts.id, "prj_s", opts.id, "spec", "usr_s", null, opts.state, 600, 1, 0,
        opts.capability ?? null, "wf_1", new Date().toISOString());
}

const run = (db: Db) => {
  const chats: string[] = [];
  const outcomes = superviseOnce({ db, postChat: (_p, t) => chats.push(t) });
  return { chats, outcomes };
};

describe("the supervisor now runs on its own", () => {
  test("a healthy workflow is left alone and says nothing", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "working" });
    const { outcomes, chats } = run(db);
    expect(outcomes).toEqual([]);
    expect(chats).toEqual([]);
    db.close();
  });

  test("an unroutable task is noticed and reported to a human", () => {
    // Nobody has this capability, so the task can never be assigned. This is
    // exactly the state that used to sit unnoticed forever.
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "submitted", capability: "quantum_welding" });
    const { outcomes, chats } = run(db);
    expect(outcomes).toHaveLength(1);
    expect(chats[0]).toContain("Ship OAuth");
    // The line must carry something actionable, never a bare state name.
    expect(chats[0].length).toBeGreaterThan("Workflow \"Ship OAuth\" is BLOCKED.".length);
    db.close();
  });

  test("a completed workflow is not reported as a problem", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "completed" });
    expect(run(db).outcomes).toEqual([]);
    db.close();
  });

  test("a paused workflow is not touched — someone paused it on purpose", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "submitted", capability: "quantum_welding" });
    db.prepare("UPDATE workflows SET state = 'paused' WHERE id = 'wf_1'").run();
    expect(run(db).outcomes).toEqual([]);
    db.close();
  });
});

describe("what it refuses to do by itself", () => {
  test("it NEVER pauses or cancels automatically", () => {
    // The line this whole file exists to draw. A supervisor that can cancel
    // your work overnight is a worse failure than a workflow that stays
    // stalled until morning with a message explaining why.
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "submitted", capability: "quantum_welding" });
    task(db, { id: "t2", state: "failed" });
    run(db);

    const wf = db.prepare("SELECT state FROM workflows WHERE id = 'wf_1'").get() as any;
    expect(wf.state).toBe("active");
    const halted = db.prepare("SELECT count(*) AS n FROM tasks WHERE state = 'canceled'").get() as any;
    expect(halted.n).toBe(0);
    db.close();
  });

  test("anything it will not do itself is surfaced, not swallowed", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "submitted", capability: "quantum_welding" });
    const { outcomes } = run(db);
    const all = [...outcomes[0].applied, ...outcomes[0].surfaced];
    expect(all.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("it does not become noise", () => {
  test("the same problem is reported once, not every tick", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "submitted", capability: "quantum_welding" });
    expect(run(db).outcomes).toHaveLength(1);
    expect(run(db).outcomes).toHaveLength(0);
    expect(run(db).outcomes).toHaveLength(0);
    db.close();
  });

  test("but a workflow that recovers and breaks again does speak up", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "t1", state: "submitted", capability: "quantum_welding" });
    expect(run(db).outcomes).toHaveLength(1);

    // Recovers.
    db.prepare("UPDATE tasks SET state = 'completed', required_capability = NULL WHERE id = 't1'").run();
    expect(run(db).outcomes).toEqual([]);

    // Breaks differently.
    task(db, { id: "t2", state: "submitted", capability: "quantum_welding" });
    expect(run(db).outcomes).toHaveLength(1);
    db.close();
  });

  test("a database with no workflows table does not crash the sweep", () => {
    const db = openDb(":memory:");
    db.prepare("DROP TABLE IF EXISTS workflows").run();
    expect(() => superviseOnce({ db })).not.toThrow();
    db.close();
  });
});
