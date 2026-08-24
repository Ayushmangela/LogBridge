// Goal -> tasks, end to end through the real database.
//
// `ORCHESTRATOR.md` said this was impossible while no LLM was wired in: the
// orchestrator decides WHO runs a task, and nothing decided WHAT tasks exist.
// A planning task is an ordinary task whose OUTPUT is a list of other tasks,
// so budget, tool policy, leases and the orchestrator all apply unchanged.
//
// The property that matters most here: nothing is created until a human
// approves. A bad decomposition should cost a click, not six running agents.
import { describe, expect, test } from "vitest";
import { appendEvent, createTask, openDb, type Db } from "./db.js";
import { acceptPlan, proposePlanFromOutput } from "./nodeGateway.js";

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_a", "a/a", "a/a", "office");
}

/** Create a planning task and feed it the output an agent "produced". */
function planTask(db: Db, goal: string, output: string) {
  const id = createTask(db, {
    projectId: "prj_a", title: `Plan: ${goal}`, creatorId: "you",
    agentId: "agt_x", kind: "plan",
  });
  // The runner logs an agent's words as task.event rows; the plan is
  // reassembled from those rather than needing its own channel.
  for (const line of output.split("\n")) {
    appendEvent(db, "prj_a", id, "task.event", { taskId: id, kind: "progress", summary: line });
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
}

const REAL_OUTPUT =
  '[{"title": "Choose rate limiting algorithm", "capability": null},' +
  ' {"title": "Implement rate limiter middleware", "capability": "backend"},' +
  ' {"title": "Add tests", "capability": "test"}]';

const chats = () => {
  const out: any[] = [];
  return { sink: (c: any) => out.push(c), out };
};

const tasksIn = (db: Db) =>
  db.prepare("SELECT title, required_capability, agent_id, state FROM tasks WHERE kind IS NULL").all() as any[];

describe("proposing a plan", () => {
  test("proposes the tasks but creates NOTHING until approved", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "add rate limiting", REAL_OUTPUT);
    const { sink, out } = chats();

    proposePlanFromOutput(db, t, sink);

    // Proposed in the room, with an approve/reject ask...
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("3 tasks");
    expect(out[0].text).toContain("Implement rate limiter middleware");
    expect(out[0].ask.options).toEqual(["approve", "reject"]);
    expect(out[0].ask.taskId).toMatch(/^pln_/);

    // ...and absolutely nothing created yet.
    expect(tasksIn(db)).toHaveLength(0);
  });

  test("approving creates them unassigned, so the orchestrator routes them", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "add rate limiting", REAL_OUTPUT);
    const { sink, out } = chats();
    proposePlanFromOutput(db, t, sink);

    const created = acceptPlan(db, out[0].ask.taskId);
    expect(created).toBe(3);

    const rows = tasksIn(db);
    expect(rows.map((r) => r.title)).toEqual([
      "Choose rate limiting algorithm", "Implement rate limiter middleware", "Add tests",
    ]);
    // Unassigned on purpose — routing is the orchestrator's job, not the planner's.
    expect(rows.every((r) => r.agent_id === null)).toBe(true);
    expect(rows.every((r) => r.state === "submitted")).toBe(true);
    // Capabilities carried through so routing can actually use them.
    expect(rows.map((r) => r.required_capability)).toEqual([null, "backend", "test"]);
  });

  test("an unusable plan says so instead of proposing an empty one", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "something vague", "I'm not sure how to break that down.");
    const { sink, out } = chats();

    proposePlanFromOutput(db, t, sink);

    expect(out).toHaveLength(1);
    expect(out[0].text).toMatch(/couldn't turn/i);
    expect(out[0].ask, "there is nothing to approve").toBeNull();
    expect(tasksIn(db)).toHaveLength(0);
  });

  test("rejecting simply never calls acceptPlan, and nothing exists", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "add rate limiting", REAL_OUTPUT);
    const { sink, out } = chats();
    proposePlanFromOutput(db, t, sink);
    // (the gateway only calls acceptPlan on "approve")
    expect(tasksIn(db)).toHaveLength(0);
    expect(out[0].ask.taskId).toMatch(/^pln_/);
  });

  test("an unknown plan id creates nothing rather than throwing", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(acceptPlan(db, "pln_does_not_exist")).toBe(0);
    expect(tasksIn(db)).toHaveLength(0);
  });

  test("the proposal chat is persisted, so a late joiner can still approve it", () => {
    // Planning takes minutes against a real CLI. Broadcasting without
    // persisting meant the proposal vanished for anyone not joined at that
    // instant — and an unapprovable plan is a dead end.
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "add rate limiting", REAL_OUTPUT);
    proposePlanFromOutput(db, t, () => {});

    const chatRows = db.prepare("SELECT body FROM events WHERE type = 'chat'").all() as any[];
    const proposal = chatRows.map((r) => JSON.parse(r.body)).find((c) => c.ask);
    expect(proposal, "the proposal must be in the replayable chat log").toBeDefined();
    expect(proposal.ask.taskId).toMatch(/^pln_/);
    expect(acceptPlan(db, proposal.ask.taskId)).toBe(3);
  });

  test("the proposal is recorded in the log, so it survives a restart", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "add rate limiting", REAL_OUTPUT);
    proposePlanFromOutput(db, t, () => {});

    const row = db.prepare("SELECT body FROM events WHERE type = 'plan.proposed'").get() as any;
    const body = JSON.parse(row.body);
    expect(body.tasks).toHaveLength(3);
    // Accepting works from the log alone — no in-memory state to lose.
    expect(acceptPlan(db, body.planId)).toBe(3);
  });

  test("a plan can only be cashed in once", () => {
    const db = openDb(":memory:");
    seed(db);
    const t = planTask(db, "add rate limiting", REAL_OUTPUT);
    const { sink, out } = chats();
    proposePlanFromOutput(db, t, sink);
    const planId = out[0].ask.taskId;

    expect(acceptPlan(db, planId)).toBe(3);
    // Double-clicking approve must not create six tasks.
    const before = tasksIn(db).length;
    acceptPlan(db, planId);
    expect(tasksIn(db).length, "approving twice must not duplicate the plan").toBe(before);
  });
});
