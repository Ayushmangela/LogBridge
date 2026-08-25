// What an agent is doing right now, projected onto its card.
//
// TaskBrief.note existed in the contract from the start and the server always
// set it to null — the office had a place to say what an agent was doing and
// permanently said nothing. `steps` is new alongside it: providers report real
// step boundaries, so the count is honest, while the TOTAL is unknowable and
// so must never be rendered as a fraction.
import { describe, expect, test } from "vitest";
import { appendEvent, openDb, type Db } from "./db.js";
import { latestProgress } from "./view.js";

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_a", "a/a", "a/a", "office");
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, creator_id, state, cost_usd, created_at)
     VALUES ('tsk_1','prj_a','do the thing','you','working',0,?)`
  ).run(new Date().toISOString());
  return db;
}

const event = (db: Db, summary: string, data?: unknown) =>
  appendEvent(db, "prj_a", "tsk_1", "task.event", { taskId: "tsk_1", summary, data });

describe("what the office shows under a working agent", () => {
  test("a task that has reported nothing yet shows nothing, not a fake zero-state", () => {
    const db = seed();
    expect(latestProgress(db, "tsk_1")).toEqual({ note: null, steps: 0 });
  });

  test("the newest line becomes the note", () => {
    const db = seed();
    event(db, "reading the schema");
    event(db, "writing the migration");
    expect(latestProgress(db, "tsk_1").note).toBe("writing the migration");
  });

  test("the step count survives ordinary output arriving after a boundary", () => {
    // The bug this is here for: reading `steps` off the newest event alone
    // reset the count to 0 every time the agent said anything, so the office
    // flickered between "step 3" and nothing.
    const db = seed();
    event(db, "step 1", { steps: 1 });
    event(db, "step 2", { steps: 2 });
    event(db, "still working on the parser"); // no steps field
    const p = latestProgress(db, "tsk_1");
    expect(p.steps).toBe(2);
    expect(p.note).toBe("still working on the parser");
  });

  test("a very long line is truncated, so one agent cannot break the layout", () => {
    const db = seed();
    event(db, "x".repeat(500));
    expect(latestProgress(db, "tsk_1").note!.length).toBeLessThanOrEqual(80);
  });

  test("a malformed body costs the note, not the render", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO events (project_id, task_id, type, body, ts) VALUES ('prj_a','tsk_1','task.event','{not json',?)`
    ).run(new Date().toISOString());
    expect(() => latestProgress(db, "tsk_1")).not.toThrow();
    expect(latestProgress(db, "tsk_1")).toEqual({ note: null, steps: 0 });
  });

  test("another task's progress never leaks onto this one", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, creator_id, state, cost_usd, created_at)
       VALUES ('tsk_2','prj_a','other','you','working',0,?)`
    ).run(new Date().toISOString());
    appendEvent(db, "prj_a", "tsk_2", "task.event", { taskId: "tsk_2", summary: "not mine", data: { steps: 9 } });
    expect(latestProgress(db, "tsk_1")).toEqual({ note: null, steps: 0 });
  });
});
