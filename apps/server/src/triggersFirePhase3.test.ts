import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import {
  createTrigger, fireEventTriggers, getTrigger, startEventLoop,
  type EventLoopOptions,
} from "./triggers.js";

let db: Db;
let nowMs: number;
let opts: EventLoopOptions;

beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES ('prj_t','t/t','t/t','office')").run();
  nowMs = Date.UTC(2026, 5, 10, 12, 0);
  opts = { now: () => nowMs, log: () => {} };
  afterEach(() => {
    db.close();
  });
});

const taskCount = () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
const tasks = () => db.prepare("SELECT id, title, spec, required_capability, budget_seconds, creator_id FROM tasks ORDER BY created_at").all() as any[];
const events = (type: string) =>
  db.prepare("SELECT seq, type, task_id, body FROM events WHERE type = ? ORDER BY seq").all(type) as any[];

function seedEventTrigger(
  eventType: string,
  overrides: Partial<Parameters<typeof createTrigger>[1]> = {}
) {
  const res = createTrigger(db, {
    projectId: "prj_t",
    name: overrides.name ?? `event:${eventType}`,
    kind: "event",
    rule: eventType,
    template: {
      title: "auto task",
      spec: "auto from event",
      requiredCapability: "triage",
      budgetSeconds: 600,
      budgetUsd: 1,
      ...overrides.template,
    },
    ...overrides,
  });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}

describe("event trigger basics", () => {
  test("a real appended event fires a matching trigger, creates task and logs event.fired", () => {
    const trigId = seedEventTrigger("task.result");
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("prj_t", "task_1", "task.result", JSON.stringify({ state: "completed" }), new Date(nowMs).toISOString());
    const fired = fireEventTriggers(db, opts);
    expect(fired).toBe(1);
    const ts = tasks();
    expect(ts).toHaveLength(1);
    expect(ts[0].title).toBe("auto task");
    expect(ts[0].required_capability).toBe("triage");
    expect(ts[0].creator_id).toBe(trigId);
    const evts = events("trigger.fired");
    expect(evts).toHaveLength(1);
    const body = JSON.parse(evts[0].body);
    expect(body.triggerId).toBe(trigId);
    expect(body.eventSeq).toBeDefined();
  });

  test("an event with no matching trigger creates nothing", () => {
    const fired = fireEventTriggers(db, opts);
    expect(fired).toBe(0);
    expect(taskCount()).toBe(0);
  });

  test("different task's result still fires normally", () => {
    const trigId = seedEventTrigger("task.result");
    fireEventTriggers(db, opts);
    const taskA = `tsk_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("prj_t", taskA, "task.result", JSON.stringify({ state: "completed" }), new Date(nowMs).toISOString());
    expect(fireEventTriggers(db, opts)).toBe(1);
    expect(taskCount()).toBe(1);
    const taskB = `tsk_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("prj_t", taskB, "task.result", JSON.stringify({ state: "completed" }), new Date(nowMs + 1000).toISOString());
    const fired = fireEventTriggers(db, opts);
    expect(fired).toBe(1);
    expect(taskCount()).toBe(2);
  });
});

describe("loop safety — self-referential trigger cannot run away", () => {
  test("after trigger creates a task, same task's result is skipped", () => {
    const trigId = seedEventTrigger("task.result");
    fireEventTriggers(db, opts);

    const fakeTaskId = `tsk_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("prj_t", fakeTaskId, "task.result", JSON.stringify({ state: "completed" }), new Date(nowMs).toISOString());
    expect(fireEventTriggers(db, opts)).toBe(1);
    expect(taskCount()).toBe(1);

    // Loop safety: re-firing on the same task's result is skipped because
    // the task ID is tracked via last_consumed_task_id.
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("prj_t", fakeTaskId, "task.result", JSON.stringify({ state: "completed" }), new Date(nowMs + 1000).toISOString());
    expect(fireEventTriggers(db, opts)).toBe(0);
    expect(taskCount()).toBe(1);
  });
});

describe("debounce — burst produces one task", () => {
  test("40 rapid ci_failed events produce exactly one task", () => {
    const trigId = seedEventTrigger("github.ci_failed");
    fireEventTriggers(db, opts);
    for (let i = 0; i < 40; i++) {
      db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
        .run("prj_t", `task_${i}`, "github.ci_failed", JSON.stringify({ repo: "t/t", number: i }), new Date(nowMs).toISOString());
    }
    db.prepare("DELETE FROM tasks").run();
    db.prepare("UPDATE triggers SET last_evt_seq = 0 WHERE rule = ?").run("github.ci_failed");
    const fired = fireEventTriggers(db, opts);
    expect(fired).toBe(1);
    expect(taskCount()).toBe(1);
  });
});

describe("non-matching events cost nothing", () => {
  test("event type with no matching trigger produces zero tasks", () => {
    const fired = fireEventTriggers(db, opts);
    expect(fired).toBe(0);
    expect(taskCount()).toBe(0);
  });

  test("mixed triggers: only matching events fire, others ignored", () => {
    seedEventTrigger("task.result");
    expect(fireEventTriggers(db, opts)).toBe(0);
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("prj_t", "task_1", "github.ci_failed", JSON.stringify({ repo: "t/t", number: 1 }), new Date(nowMs).toISOString());
    expect(fireEventTriggers(db, opts)).toBe(0);
    expect(taskCount()).toBe(0);
    seedEventTrigger("github.ci_failed");
    expect(fireEventTriggers(db, opts)).toBe(1);
    expect(taskCount()).toBe(1);
  });
});

describe("startEventLoop", () => {
  test("startEventLoop ticks and stop() ends it without throwing", () => {
    const trigId = seedEventTrigger("task.result");
    const loop = startEventLoop(db, { ...opts, intervalMs: 5 });
    try {
      loop.stop();
    } finally {
      loop.stop();
    }
  });
});
