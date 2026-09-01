// The breaker exists because the prompt already claimed it did. Every
// employee is told: "A circuit breaker watches the floor. If you receive
// 'Circuit breaker: steer/constrain' you are looping or overspending."
// Nothing sent that string until now, so these pin both the thresholds and
// the exact wording the agents were trained on.
import { describe, expect, test } from "vitest";
import { openDb, appendEvent, type Db } from "./db.js";
import {
  evaluateBreakers, tripBreakers, SPEND_TRIP_FRACTION, REPEAT_TRIP_COUNT,
} from "./circuitBreaker.js";

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_b", "x/b", "B", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_b", "b", "B", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)").run("node_b", "usr_b", "m", 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("agt_b", "node_b", "usr_b", "prj_b", "Ada", "developer", "[]", 1, "working");
  return db;
}

function task(db: Db, opts: { id?: string; cost?: number; budget?: number; state?: string } = {}) {
  const id = opts.id ?? "tsk_1";
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, "prj_b", "Do the thing", "spec", "usr_b", "agt_b",
        opts.state ?? "submitted", 600, opts.budget ?? 1.0, opts.cost ?? 0, new Date().toISOString());
  return id;
}

const collect = (db: Db) => {
  const injected: Array<{ agentId: string; text: string }> = [];
  const chats: string[] = [];
  const fired = tripBreakers({
    db,
    inject: (agentId, text) => { injected.push({ agentId, text }); return true; },
    postChat: (_p, text) => chats.push(text),
  });
  return { injected, chats, fired };
};

describe("overspending trips 'constrain'", () => {
  test("a task under the threshold is left alone", () => {
    const db = seed(openDb(":memory:"));
    task(db, { cost: 0.5, budget: 1.0 });   // 50%, below 80%
    expect(evaluateBreakers(db)).toEqual([]);
    db.close();
  });

  test("crossing the threshold trips, in the exact words the prompt taught", () => {
    const db = seed(openDb(":memory:"));
    task(db, { cost: SPEND_TRIP_FRACTION, budget: 1.0 });
    const { injected } = collect(db);
    expect(injected).toHaveLength(1);
    // The literal prefix IS the contract — the agent was trained to recognise it.
    expect(injected[0].text.startsWith("Circuit breaker: constrain.")).toBe(true);
    // And it says what to do, not merely what is wrong.
    expect(injected[0].text).toContain("$AGENT_DIR/memory.md");
    db.close();
  });

  test("it trips BEFORE the budget is gone, while there is still room to act", () => {
    // At 100% there is nothing left to steer with and the runner's own hard
    // stop is about to fire anyway.
    expect(SPEND_TRIP_FRACTION).toBeLessThan(1);
    const db = seed(openDb(":memory:"));
    task(db, { cost: 0.85, budget: 1.0 });
    expect(evaluateBreakers(db)[0]?.kind).toBe("constrain");
    db.close();
  });

  test("a task with no budget cannot overspend", () => {
    const db = seed(openDb(":memory:"));
    task(db, { cost: 99, budget: 0 });
    expect(evaluateBreakers(db)).toEqual([]);
    db.close();
  });

  test("a finished task is never steered", () => {
    const db = seed(openDb(":memory:"));
    task(db, { cost: 5, budget: 1.0, state: "completed" });
    expect(evaluateBreakers(db)).toEqual([]);
    db.close();
  });
});

describe("looping trips 'steer'", () => {
  const repeat = (db: Db, taskId: string, summary: string, times: number) => {
    for (let i = 0; i < times; i++) {
      appendEvent(db, "prj_b", taskId, "task.event", { summary });
    }
  };

  test("the same step a few times is not yet a loop", () => {
    const db = seed(openDb(":memory:"));
    const id = task(db);
    repeat(db, id, "running the test suite", REPEAT_TRIP_COUNT - 1);
    expect(evaluateBreakers(db)).toEqual([]);
    db.close();
  });

  test("the same step repeated enough times trips", () => {
    const db = seed(openDb(":memory:"));
    const id = task(db);
    repeat(db, id, "running the test suite", REPEAT_TRIP_COUNT);
    const { injected } = collect(db);
    expect(injected[0].text.startsWith("Circuit breaker: steer.")).toBe(true);
    expect(injected[0].text).toContain("running the test suite");
    // It offers a way out rather than only a prohibition.
    expect(injected[0].text).toContain('send a message to "god"');
    db.close();
  });

  test("genuine progress is not a loop, however busy", () => {
    const db = seed(openDb(":memory:"));
    const id = task(db);
    for (let i = 0; i < 10; i++) appendEvent(db, "prj_b", id, "task.event", { summary: `step ${i}` });
    expect(evaluateBreakers(db)).toEqual([]);
    db.close();
  });

  test("an agent that looped, then moved on, is not tripped", () => {
    const db = seed(openDb(":memory:"));
    const id = task(db);
    repeat(db, id, "stuck here", REPEAT_TRIP_COUNT);
    appendEvent(db, "prj_b", id, "task.event", { summary: "wrote the fix" });
    expect(evaluateBreakers(db)).toEqual([]);
    db.close();
  });
});

describe("firing behaviour", () => {
  test("a task gets each kind of warning ONCE, not every tick", () => {
    // Re-sending "stop looping" four times a minute is itself a loop, and
    // each copy pushes the real work further back in the agent's context.
    const db = seed(openDb(":memory:"));
    task(db, { cost: 0.9, budget: 1.0 });
    expect(collect(db).injected).toHaveLength(1);
    expect(collect(db).injected).toHaveLength(0);
    db.close();
  });

  test("one trip per task per pass — never both messages at once", () => {
    const db = seed(openDb(":memory:"));
    const id = task(db, { cost: 0.95, budget: 1.0 });
    for (let i = 0; i < REPEAT_TRIP_COUNT; i++) appendEvent(db, "prj_b", id, "task.event", { summary: "same" });
    // An agent told to both wrap up and change approach does neither well.
    const trips = evaluateBreakers(db);
    expect(trips).toHaveLength(1);
    expect(trips[0].kind).toBe("constrain");
    db.close();
  });

  test("an agent with no live terminal is still recorded, and says so", () => {
    const db = seed(openDb(":memory:"));
    task(db, { cost: 0.9, budget: 1.0 });
    const chats: string[] = [];
    tripBreakers({ db, inject: () => false, postChat: (_p, t) => chats.push(t) });
    expect(chats[0]).toContain("no live terminal");
    // Recorded regardless, so the office can show it and a human can act.
    const row = db.prepare("SELECT body FROM events WHERE type = 'circuit.tripped'").get() as any;
    expect(JSON.parse(row.body).delivered).toBe(false);
    db.close();
  });

  test("two different tasks each get their own warning", () => {
    const db = seed(openDb(":memory:"));
    task(db, { id: "tsk_1", cost: 0.9, budget: 1.0 });
    task(db, { id: "tsk_2", cost: 0.9, budget: 1.0 });
    expect(collect(db).injected).toHaveLength(2);
    db.close();
  });
});
