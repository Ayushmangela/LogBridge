// The gates existed, were tested, and were invisible. `BoardTask` shipped
// eight fields to the browser and not one of them said why a task was sitting
// still — so a reviewer could block work and the office would show an agent
// doing nothing, with no reason given.
//
// These tests pin the one property that makes the surface honest: it reports
// what the gate HAS said, never what it would say if asked now.
import { describe, expect, test } from "vitest";
import { openDb, createTask, createReviewVerdict, storeArtifact, appendEvent, type Db } from "./db.js";
import { gateStatesForProject } from "./gateState.js";

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_g", "x/g", "G", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_g", "g", "G", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)").run("node_g", "usr_g", "m", 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("agt_dev", "node_g", "usr_g", "prj_g", "Ada", "developer", "[]", 2, "working");
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("agt_rev", "node_g", "usr_g", "prj_g", "Rhen", "review", "[]", 2, "idle");
  return db;
}

const rows = (db: Db) => db.prepare("SELECT * FROM tasks WHERE project_id = 'prj_g'").all() as any[];
const gatesOf = (db: Db) => gateStatesForProject(db, "prj_g", rows(db));

function mk(db: Db, opts: Parameters<typeof createTask>[1] extends infer _ ? any : never = {}) {
  return createTask(db, {
    projectId: "prj_g",
    title: opts.title ?? "Work",
    creatorId: "user",
    agentId: "agt_dev",
    expectedOutputs: opts.expectedOutputs ?? null,
    acceptanceChecks: opts.acceptanceChecks ?? null,
    requiresReview: opts.requiresReview ?? false,
  });
}

describe("gate state — what reaches the office", () => {
  test("a task that declared nothing is omitted entirely, not reported as passing", () => {
    const db = seed();
    mk(db, {});
    expect(gatesOf(db).size).toBe(0);
  });

  test("a declared output with no artifact reads as missing, but does NOT block", () => {
    const db = seed();
    const id = mk(db, { expectedOutputs: ["diff"] });
    const g = gatesOf(db).get(id)!;
    expect(g.outputs).toEqual([{ kind: "diff", present: false }]);
    // The agent is still working. Nothing has been refused yet, so nothing is
    // blocked — this is the property that keeps the board from turning red.
    expect(g.blockedOn).toBeNull();
  });

  test("once the gate has actually refused it, the task reads as blocked on artifacts", () => {
    const db = seed();
    const id = mk(db, { expectedOutputs: ["diff"] });
    appendEvent(db, "prj_g", id, "task.verification_failed", { missing: ["diff"] });
    expect(gatesOf(db).get(id)!.blockedOn).toBe("artifacts");
  });

  test("an artifact of the declared kind clears it, case-insensitively", () => {
    const db = seed();
    const id = mk(db, { expectedOutputs: ["diff"] });
    appendEvent(db, "prj_g", id, "task.verification_failed", { missing: ["diff"] });
    storeArtifact(db, {
      projectId: "prj_g", taskId: id, creatorId: "agt_dev",
      kind: "DIFF", title: "patch", filePath: null,
    });
    const g = gatesOf(db).get(id)!;
    expect(g.outputs).toEqual([{ kind: "diff", present: true }]);
    expect(g.blockedOn).toBeNull();
  });

  test("a check with no run yet is null — deliberately not 'passed'", () => {
    const db = seed();
    const id = mk(db, { acceptanceChecks: ["test"] });
    expect(gatesOf(db).get(id)!.checks).toEqual([{ name: "test", status: null, note: null }]);
  });

  test("a failed check blocks; a remote workspace is skipped and does not", () => {
    const db = seed();
    const failed = mk(db, { title: "F", acceptanceChecks: ["test"] });
    appendEvent(db, "prj_g", failed, "task.checks_run", {
      results: [{ name: "test", passed: false, exitCode: 1, skipped: null }],
    });
    const skipped = mk(db, { title: "S", acceptanceChecks: ["test"] });
    // runAcceptanceChecks() marks a remote workspace passed:true — running
    // `npm test` here would be testing the wrong tree, which is a gap, not a
    // failure to punish the agent for.
    appendEvent(db, "prj_g", skipped, "task.checks_run", {
      results: [{ name: "test", passed: true, exitCode: null, skipped: "workspace is on another machine" }],
    });

    const g = gatesOf(db);
    expect(g.get(failed)!.checks[0].status).toBe("failed");
    expect(g.get(failed)!.blockedOn).toBe("checks");
    expect(g.get(skipped)!.checks[0].status).toBe("skipped");
    expect(g.get(skipped)!.checks[0].note).toBe("workspace is on another machine");
    expect(g.get(skipped)!.blockedOn).toBeNull();
  });

  test("a check name nobody defined reads as FAILED, because that is what the gate does", () => {
    const db = seed();
    const id = mk(db, { acceptanceChecks: ["nonexistent"] });
    // runAcceptanceChecks() records this as skipped with passed:false, and
    // completionGate counts every !passed run as a failure. Showing it as a
    // neutral "skipped" would tell the board the task is fine while the gate
    // is refusing to complete it.
    appendEvent(db, "prj_g", id, "task.checks_run", {
      results: [{ name: "nonexistent", passed: false, exitCode: null, skipped: 'no check named "nonexistent" in this project' }],
    });
    const g = gatesOf(db).get(id)!;
    expect(g.checks[0].status).toBe("failed");
    expect(g.checks[0].note).toContain("no check named");
    expect(g.blockedOn).toBe("checks");
  });

  test("a task that merely REQUIRES review is not 'in review' and does not block", () => {
    const db = seed();
    const id = mk(db, { requiresReview: true });
    // No reviewer has been asked — the agent has not finished. Reporting this
    // as pending put every freshly created task straight into a blocked-
    // looking state on the board.
    const g = gatesOf(db).get(id)!;
    expect(g.review).toEqual({ status: "required", reviewer: null });
    expect(g.blockedOn).toBeNull();
  });

  test("review pending names the reviewer the gate dispatched to", () => {
    const db = seed();
    const id = mk(db, { requiresReview: true });
    appendEvent(db, "prj_g", id, "task.review_requested", {
      reviewTaskId: "tsk_x", reviewerAgentId: "agt_rev", reviewerName: "Rhen", cycle: 0,
    });
    const g = gatesOf(db).get(id)!;
    expect(g.review).toEqual({ status: "pending", reviewer: "Rhen" });
    expect(g.blockedOn).toBe("review");
  });

  test("the NEWEST verdict decides — an ACCEPT then a REJECT is rejected", () => {
    const db = seed();
    const id = mk(db, { requiresReview: true });
    // Written back to back, so they may share a millisecond — which is
    // exactly the case the rowid tie-break exists for.
    createReviewVerdict(db, {
      projectId: "prj_g", taskId: id, reviewerAgentId: "agt_rev",
      status: "ACCEPT", comments: [],
    });
    createReviewVerdict(db, {
      projectId: "prj_g", taskId: id, reviewerAgentId: "agt_rev",
      status: "REJECT", comments: [],
    });
    const g = gatesOf(db).get(id)!;
    expect(g.review!.status).toBe("rejected");
    expect(g.blockedOn).toBe("review");
  });

  test("no reviewer available is its own state, not a silent pending", () => {
    const db = seed();
    const id = mk(db, { requiresReview: true });
    appendEvent(db, "prj_g", id, "task.review_unavailable", { agentId: "agt_dev" });
    expect(gatesOf(db).get(id)!.review!.status).toBe("unavailable");
  });

  test("a settled task never reports as blocked, whatever its gates say", () => {
    const db = seed();
    const id = mk(db, { expectedOutputs: ["diff"], requiresReview: true });
    appendEvent(db, "prj_g", id, "task.verification_failed", { missing: ["diff"] });
    db.prepare("UPDATE tasks SET state = 'canceled' WHERE id = ?").run(id);
    expect(gatesOf(db).get(id)!.blockedOn).toBeNull();
  });

  test("completed-unverified is surfaced, so 'done' and 'done, unchecked' differ", () => {
    const db = seed();
    const id = mk(db, { expectedOutputs: ["diff"] });
    appendEvent(db, "prj_g", id, "task.completed_unverified", { missing: ["diff"] });
    db.prepare("UPDATE tasks SET state = 'completed' WHERE id = ?").run(id);
    expect(gatesOf(db).get(id)!.unverified).toBe(true);
  });

  test("cost stays flat: three statements regardless of how many tasks are gated", () => {
    const db = seed();
    for (let i = 0; i < 40; i++) mk(db, { title: `T${i}`, expectedOutputs: ["diff"], requiresReview: true });

    const all = rows(db);            // fetched before counting — not under test
    let prepared = 0;
    const realPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { prepared++; return realPrepare(sql); };
    gateStatesForProject(db, "prj_g", all);
    (db as any).prepare = realPrepare;

    // Per-task queries would be 120 here. The board rebuilds per viewer,
    // several times a second — see the cost note in gateState.ts.
    expect(prepared).toBe(3);
  });
});
