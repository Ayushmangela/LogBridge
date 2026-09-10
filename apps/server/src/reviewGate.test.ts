// `processReviewResult()` was always a complete rework lifecycle — ACCEPT
// completes, REJECT opens a linked rework task and escalates. What was missing
// is the part that makes it matter: nothing ever REQUIRED a review. Work could
// be written, claimed done and completed with no reviewer ever seeing it. The
// reviewer role existed; being reviewed did not.
import { describe, expect, test } from "vitest";
import { openDb, createTask, createReviewVerdict, type Db } from "./db.js";
import { checkReviewGate, findReviewer, requiresReview, MAX_REVIEW_CYCLES } from "./reviewGate.js";

function seed(db: Db, opts: { reviewer?: boolean; reviewerOnline?: boolean } = {}) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_r", "x/r", "R", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_r", "r", "R", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)").run("node_r", "usr_r", "m", 1);
  const add = (id: string, name: string, role: string, roleId: string | null, online = 1) => {
    db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)")
      .run(`node_${id}`, "usr_r", "m", online);
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, role_id, capabilities, concurrency, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, `node_${id}`, "usr_r", "prj_r", name, role, roleId, "[]", 2, "idle");
  };
  add("agt_dev", "Ada", "developer", "developer");
  if (opts.reviewer !== false) {
    add("agt_rev", "Rhen", "review", "reviewer", opts.reviewerOnline === false ? 0 : 1);
  }
  return db;
}

const task = (db: Db, requiresReviewFlag = true) => {
  const id = createTask(db, {
    projectId: "prj_r", title: "Add the callback route", creatorId: "usr_r",
    agentId: "agt_dev", requiresReview: requiresReviewFlag,
  });
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
};

describe("when review is required", () => {
  test("a task that does not require review is not held", () => {
    const db = seed(openDb(":memory:"));
    const t = task(db, false);
    expect(requiresReview(t)).toBe(false);
    expect(checkReviewGate(db, t)).toEqual({ required: false });
    db.close();
  });

  test("the first completion attempt dispatches a review and holds the task", () => {
    const db = seed(openDb(":memory:"));
    const out = checkReviewGate(db, task(db)) as any;
    expect(out.satisfied).toBe(false);
    expect(out.reason).toBe("awaiting_review");

    // The review is itself a task — scheduled, on the board, budgeted.
    const review = db.prepare("SELECT * FROM tasks WHERE id = ?").get(out.reviewTaskId) as any;
    expect(review.title).toContain("Review:");
    expect(review.agent_id).toBe("agt_rev");
    db.close();
  });

  test("an ACCEPT verdict satisfies it", () => {
    const db = seed(openDb(":memory:"));
    const t = task(db);
    createReviewVerdict(db, {
      projectId: "prj_r", taskId: t.id, reviewerAgentId: "agt_rev",
      status: "ACCEPT", comments: ["looks right"],
    });
    const out = checkReviewGate(db, t) as any;
    expect(out.satisfied).toBe(true);
    db.close();
  });

  test("a REJECT does not satisfy it", () => {
    const db = seed(openDb(":memory:"));
    const t = task(db);
    createReviewVerdict(db, {
      projectId: "prj_r", taskId: t.id, reviewerAgentId: "agt_rev",
      status: "REJECT", comments: ["token expiry is wrong"],
    });
    expect((checkReviewGate(db, t) as any).satisfied).toBe(false);
    db.close();
  });

  test("the NEWEST verdict is the one that counts", () => {
    // An ACCEPT, then more work, then a REJECT must not still read as accepted.
    const db = seed(openDb(":memory:"));
    const t = task(db);
    createReviewVerdict(db, { projectId: "prj_r", taskId: t.id, reviewerAgentId: "agt_rev", status: "ACCEPT", comments: ["ok"] });
    createReviewVerdict(db, { projectId: "prj_r", taskId: t.id, reviewerAgentId: "agt_rev", status: "REJECT", comments: ["regressed"] });
    expect((checkReviewGate(db, t) as any).satisfied).toBe(false);
    db.close();
  });
});

describe("who may review", () => {
  test("never the agent that did the work", () => {
    // Self-review is not review.
    const db = seed(openDb(":memory:"), { reviewer: false });
    expect(findReviewer(db, task(db))).toBeNull();
    db.close();
  });

  test("a real reviewer is preferred over anyone merely free", () => {
    const db = seed(openDb(":memory:"));
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, role_id, capabilities, concurrency, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run("agt_docs", "node_r", "usr_r", "prj_r", "Dee", "docs", "docs", "[]", 2, "idle");
    expect(findReviewer(db, task(db))?.id).toBe("agt_rev");
    db.close();
  });

  test("a non-reviewer is NOT accepted as a fallback", () => {
    // "Anyone who is free" reviewing a diff is a rubber stamp, and a rubber
    // stamp is worse than an honest gap because it looks like assurance.
    const db = seed(openDb(":memory:"), { reviewer: false });
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, role_id, capabilities, concurrency, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run("agt_docs", "node_r", "usr_r", "prj_r", "Dee", "docs", "docs", "[]", 2, "idle");
    expect(findReviewer(db, task(db))).toBeNull();
    expect((checkReviewGate(db, task(db)) as any).reason).toBe("no_reviewer");
    db.close();
  });

  test("an offline reviewer cannot review", () => {
    const db = seed(openDb(":memory:"), { reviewerOnline: false });
    expect((checkReviewGate(db, task(db)) as any).reason).toBe("no_reviewer");
    db.close();
  });
});

describe("it cannot deadlock", () => {
  test("after the cycle limit the gate stops blocking", () => {
    // A task nobody will ever accept must not block forever — the same escape
    // the artifact gate has.
    const db = seed(openDb(":memory:"));
    const t = task(db);
    for (let i = 0; i < MAX_REVIEW_CYCLES; i++) {
      expect((checkReviewGate(db, t) as any).satisfied).toBe(false);
    }
    const out = checkReviewGate(db, t) as any;
    expect(out.reason).toBe("exhausted");
    // And it is recorded, never silently waved through.
    expect(db.prepare("SELECT 1 FROM events WHERE type='task.review_abandoned'").get()).toBeTruthy();
    db.close();
  });

  test("no reviewer is reported, not silently passed", () => {
    const db = seed(openDb(":memory:"), { reviewer: false });
    checkReviewGate(db, task(db));
    expect(db.prepare("SELECT 1 FROM events WHERE type='task.review_unavailable'").get()).toBeTruthy();
    db.close();
  });
});
