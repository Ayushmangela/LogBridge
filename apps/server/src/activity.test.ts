// The activity projection. describeEvent is pure, so the wording rules are
// tested directly; recentActivity is tested against a real db because the
// parts that break involve ordering, filtering and the task-title join.
import { describe, expect, test } from "vitest";
import { appendEvent, createTask, openDb, type Db } from "./db.js";
import { describeEvent, recentActivity } from "./activity.js";

const ev = (type: string, body: unknown, taskId: string | null = "tsk_1", seq = 1) => ({
  seq, type, task_id: taskId, body: JSON.stringify(body), ts: new Date().toISOString(),
});
const titled = (t: string | null) => () => t;

describe("describeEvent", () => {
  test("names the agent and the task for an assignment", () => {
    const item = describeEvent(ev("task.assigned", { agentName: "dev-api", by: "orchestrator" }), titled("Add JWT auth"));
    expect(item).toMatchObject({ actor: "dev-api", type: "task.assigned", taskId: "tsk_1" });
    expect(item!.summary).toContain("Add JWT auth");
  });

  test("a failure carries its reason; a success doesn't need one", () => {
    const failed = describeEvent(ev("task.result", { state: "failed", reason: "budget_exceeded" }), titled("Long job"));
    expect(failed!.summary).toContain("failed");
    expect(failed!.summary).toContain("budget_exceeded");

    const ok = describeEvent(ev("task.result", { state: "completed", reason: null }), titled("Long job"));
    expect(ok!.summary).toContain("finished");
    expect(ok!.summary).not.toContain("—");
  });

  test("a lease expiry reads as the machine going silent, not as a plain failure", () => {
    const item = describeEvent(ev("lease.expired", {}), titled("Migrate schema"));
    expect(item!.summary).toMatch(/went silent/);
    expect(item!.summary).toContain("lease");
  });

  test("a late result says the task had already been given up on", () => {
    const item = describeEvent(ev("task.late_result", { state: "completed" }), titled("Slow job"));
    expect(item!.summary).toMatch(/late/);
    expect(item!.summary).toMatch(/already/);
  });

  test("noise is dropped rather than rendered", () => {
    for (const t of ["position", "task.status", "task.event"]) {
      expect(describeEvent(ev(t, {}), titled("x")), t).toBeNull();
    }
    // re-learning a known fact isn't news either
    expect(describeEvent(ev("memory.write.duplicate", { text: "x" }), titled(null))).toBeNull();
  });

  test("long text is truncated so one event can't dominate the feed", () => {
    const long = "x".repeat(400);
    const item = describeEvent(ev("memory.write", { text: long, agentName: "a" }), titled(null));
    expect(item!.summary.length).toBeLessThan(90);
    expect(item!.summary).toMatch(/…$/);
  });

  test("newlines are collapsed — the feed is one line per event", () => {
    const item = describeEvent(ev("memory.write", { text: "line one\n\nline two", agentName: "a" }), titled(null));
    expect(item!.summary).not.toContain("\n");
    expect(item!.summary).toContain("line one line two");
  });

  test("a malformed or missing body never throws", () => {
    const broken = { seq: 1, type: "task.result", task_id: null, body: "{not json", ts: "t" };
    expect(() => describeEvent(broken, titled(null))).not.toThrow();
    const nobody = { seq: 1, type: "task.result", task_id: null, body: null, ts: "t" };
    expect(() => describeEvent(nobody, titled(null))).not.toThrow();
  });

  test("an unknown event type still appears rather than vanishing", () => {
    // A silent feed while a new feature ships is worse than an ugly line.
    const item = describeEvent(ev("some.future.thing", {}), titled(null));
    expect(item).not.toBeNull();
    expect(item!.summary).toBe("some future thing");
  });

  test("a task with no title reads sensibly instead of showing an empty quote", () => {
    const item = describeEvent(ev("task.accept", {}, null), titled(null));
    expect(item!.summary).toContain("a task");
    expect(item!.summary).not.toContain('""');
  });
});

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_a", "a/a", "a/a", "office");
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_b", "b/b", "b/b", "office");
}

describe("recentActivity", () => {
  test("is newest first and scoped to the room", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = createTask(db, { projectId: "prj_a", title: "Ship the thing", creatorId: "you", agentId: null });
    appendEvent(db, "prj_a", t, "task.assigned", { agentName: "dev-a" });
    appendEvent(db, "prj_a", t, "task.accept", {});
    appendEvent(db, "prj_a", t, "task.result", { state: "completed" });
    appendEvent(db, "prj_b", null, "task.accept", {}); // different room

    const feed = recentActivity(db, "prj_a", 10);
    expect(feed.map((f) => f.type)).toEqual(["task.result", "task.accept", "task.assigned"]);
    expect(feed[0].seq).toBeGreaterThan(feed[2].seq);
    // the task title was joined in
    expect(feed[0].summary).toContain("Ship the thing");
    expect(recentActivity(db, "prj_b", 10)).toHaveLength(1);
  });

  test("a flood of position events doesn't produce an empty feed", () => {
    // The filter happens after the query, so a naive LIMIT would return a
    // page of pure noise and then render nothing.
    const db = openDb(":memory:");
    seed(db);
    appendEvent(db, "prj_a", null, "task.accept", {});
    for (let i = 0; i < 200; i++) appendEvent(db, "prj_a", null, "position", { x: i, y: i });

    const feed = recentActivity(db, "prj_a", 10);
    expect(feed).toHaveLength(1);
    expect(feed[0].type).toBe("task.accept");
  });

  test("honours the limit", () => {
    const db = openDb(":memory:");
    seed(db);
    for (let i = 0; i < 20; i++) appendEvent(db, "prj_a", null, "task.accept", {});
    expect(recentActivity(db, "prj_a", 5)).toHaveLength(5);
  });

  test("an empty room yields an empty feed, not an error", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(recentActivity(db, "prj_a", 10)).toEqual([]);
  });
});

describe("github push wording", () => {
  const push = (over: any) => describeEvent(
    ev("github.push", { repo: "acme/api", author: "sam", count: 1, headline: "fix the thing", ...over }, null),
    titled(null)
  );

  test("one commit reads as a commit, not '1 commits'", () => {
    expect(push({ count: 1 })!.summary).toContain("pushed a commit");
    expect(push({ count: 1 })!.summary).not.toContain("1 commits");
  });

  test("several commits are counted, and the headline still shows", () => {
    const s = push({ count: 4, headline: "rework the parser" })!.summary;
    expect(s).toContain("pushed 4 commits");
    expect(s).toContain("acme/api");
    expect(s).toContain("rework the parser");
  });

  test("the author is the actor, not the system", () => {
    expect(push({ author: "maya" })!.actor).toBe("maya");
  });

  test("a missing headline doesn't leave a dangling dash", () => {
    expect(push({ headline: undefined })!.summary).not.toMatch(/—\s*$/);
  });
});
