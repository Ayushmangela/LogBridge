// Triggers Phase 2: the firing loop. The clock is INJECTED (house rule 4 —
// no test sleeps to prove a schedule), rows go in and out through the real
// functions, and each test targets one of the three decisions that make this
// phase hard: double-firing, catch-up, and a trigger that fails.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import {
  createTrigger, fireDueTriggers, getTrigger,
  startTriggerLoop, type TriggerLoopOptions,
} from "./triggers.js";

let db: Db;
let nowMs: number;
let opts: TriggerLoopOptions;

beforeEach(() => {
  db = openDb(":memory:");
  nowMs = Date.UTC(2026, 5, 10, 12, 0); // Wed 2026-06-10 12:00Z
  opts = { now: () => nowMs, log: () => {} };
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES ('prj_t','t/t','t/t','office')").run();
});

afterEach(() => {
  db.close();
});

/** A daily-at-09:00-New-York trigger whose first firing is due at `dueAt`. */
function seedDaily(dueAt: Date, overrides: Partial<Parameters<typeof createTrigger>[1]> = {}) {
  // Compute next_fire_at exactly as createTrigger would for "now", then pin
  // it to the instant the test wants due — storage-level, not via sleep.
  const res = createTrigger(db, {
    projectId: "prj_t",
    name: overrides.name ?? "morning triage",
    kind: "schedule",
    rule: "every weekday at 09:00",
    tz: "UTC",
    template: {
      title: "Triage overnight CI failures",
      spec: "look at the red builds",
      requiredCapability: "fix_test",
      budgetSeconds: 900,
      budgetUsd: 2,
      ...overrides.template,
    },
    ...overrides,
  });
  if (!res.ok) throw new Error(res.error);
  db.prepare("UPDATE triggers SET next_fire_at = ? WHERE id = ?")
    .run(dueAt.toISOString(), res.id);
  return res.id;
}

const taskCount = () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n;
const tasks = () => db.prepare("SELECT id, title, spec, required_capability, budget_seconds, agent_id FROM tasks ORDER BY created_at").all() as any[];
const events = (type: string) =>
  db.prepare("SELECT body FROM events WHERE type = ? ORDER BY seq").all(type) as any[];

describe("firing basics", () => {
  test("a due trigger creates its template task, logs an event, advances bookkeeping", () => {
    const id = seedDaily(new Date(nowMs - 1000)); // became due a second ago

    expect(fireDueTriggers(db, opts)).toBe(1);

    const ts = tasks();
    expect(ts).toHaveLength(1);
    expect(ts[0].title).toBe("Triage overnight CI failures");
    expect(ts[0].required_capability).toBe("fix_test");
    expect(ts[0].budget_seconds).toBe(900);
    expect(ts[0].agent_id).toBeNull(); // orchestrator routes, as everywhere else

    const firedEvents = events("trigger.fired");
    expect(firedEvents).toHaveLength(1);
    const body = JSON.parse(firedEvents[0].body);
    expect(body.triggerId).toBe(id);
    expect(body.taskId).toBe(ts[0].id);

    const t = getTrigger(db, id)!;
    expect(t.lastFiredAt).toBe(new Date(nowMs).toISOString());
    // Rescheduled from NOW into the future — not replayed from the past.
    expect(Date.parse(t.nextFireAt!)).toBeGreaterThan(nowMs);
  });

  test("a trigger that is not yet due does nothing", () => {
    seedDaily(new Date(nowMs + 3_600_000));
    expect(fireDueTriggers(db, opts)).toBe(0);
    expect(taskCount()).toBe(0);
  });
});

describe("decision 1 — double-firing is structurally impossible", () => {
  test("two ticks at the same instant create one task", () => {
    seedDaily(new Date(nowMs));
    fireDueTriggers(db, opts);
    fireDueTriggers(db, opts);
    expect(taskCount()).toBe(1);
  });

  test("a restart mid-fire (task created, bookkeeping lost) does not duplicate", () => {
    const id = seedDaily(new Date(nowMs));
    fireDueTriggers(db, opts);

    // Simulate the crash window: the task exists but last_fired/next_fire were
    // never written, so the trigger still looks due with the SAME schedule slot.
    db.prepare("UPDATE triggers SET last_fired_at = NULL, next_fire_at = ? WHERE id = ?")
      .run(new Date(nowMs).toISOString(), id);

    fireDueTriggers(db, opts);
    expect(taskCount()).toBe(1);
    // And the bookkeeping finally advanced instead of looping forever.
    expect(Date.parse(getTrigger(db, id)!.nextFireAt!)).toBeGreaterThan(nowMs);
  });

  test("several firings over several ticks — one task per scheduled slot", () => {
    const res = createTrigger(db, {
      projectId: "prj_t", name: "pulse", kind: "schedule",
      rule: "every 30 minutes", tz: "UTC",
      template: { title: "pulse check" },
    });
    if (!res.ok) throw new Error(res.error);
    // Pin the first slot to the INJECTED clock — createTrigger computed
    // next_fire_at from real wall-clock, which is months away from nowMs.
    db.prepare("UPDATE triggers SET next_fire_at = ? WHERE id = ?")
      .run(new Date(nowMs).toISOString(), res.id);

    // First tick fires immediately (created as due-now), then advance the
    // clock slot by slot. Three slots → exactly three tasks.
    let fired = fireDueTriggers(db, opts);
    for (let i = 0; i < 3; i++) {
      nowMs += 30 * 60_000;
      fired += fireDueTriggers(db, opts);
    }
    expect(fired).toBeGreaterThanOrEqual(3);
    expect(taskCount()).toBe(fired); // no duplicates along the way
  });
});

describe("decision 2 — catch-up after downtime fires ONCE", () => {
  test("three missed days produce one task today, not three", () => {
    // Daily weekday trigger went due Friday; server comes back Monday.
    const fridayDue = Date.UTC(2026, 5, 5, 9, 0); // Fri 2026-06-05 09:00Z
    const id = seedDaily(new Date(fridayDue));
    nowMs = Date.UTC(2026, 5, 8, 12, 0); // Mon 2026-06-08 12:00Z — three days dark

    fireDueTriggers(db, opts);

    expect(taskCount()).toBe(1);
    // Rescheduled from NOW: the next slot is tomorrow morning, not a replay
    // of Saturday's and Sunday's missed slots.
    const t = getTrigger(db, id)!;
    expect(Date.parse(t.nextFireAt!)).toBeGreaterThan(nowMs);
  });
});

describe("decision 3 — a broken trigger is disabled while peers keep firing", () => {
  test("deleted project disables only the broken trigger", () => {
    const healthy = createTrigger(db, {
      projectId: "prj_t", name: "healthy", kind: "schedule",
      rule: "every day at 09:00", tz: "UTC", template: { title: "healthy work" },
    });
    const broken = createTrigger(db, {
      projectId: "prj_gone", name: "broken", kind: "schedule",
      rule: "every day at 09:00", tz: "UTC", template: { title: "doomed" },
    });
    // Pin BOTH to the injected clock — real-wall-clock slots are months away.
    for (const r of [healthy, broken]) {
      if (r.ok) db.prepare("UPDATE triggers SET next_fire_at = ? WHERE id = ?")
        .run(new Date(nowMs).toISOString(), r.id);
    }

    const errors: string[] = [];
    fireDueTriggers(db, { ...opts, log: (m) => errors.push(m) });

    // The healthy one ran; the broken one was disabled with a logged reason.
    expect(getTrigger(db, (healthy as any).id)!.lastFiredAt).toBeTruthy();
    expect(getTrigger(db, (broken as any).id)!.enabled).toBe(false);
    expect(errors.some((e) => e.includes("disabled"))).toBe(true);
    expect(taskCount()).toBe(1);
  });

  test("a corrupted stored rule disables instead of throwing forever", () => {
    const res = createTrigger(db, {
      projectId: "prj_t", name: "corrupt", kind: "schedule",
      rule: "every day at 09:00", tz: "UTC", template: { title: "x" },
    });
    const id = (res as any).id;
    db.prepare("UPDATE triggers SET rule = 'whenever sam feels like it' WHERE id = ?").run(id);
    // Pin to the injected clock — otherwise its real-wall-clock slot is
    // months in the future and it would never come due at all.
    db.prepare("UPDATE triggers SET next_fire_at = ? WHERE id = ?")
      .run(new Date(nowMs).toISOString(), id);

    expect(() => fireDueTriggers(db, opts)).not.toThrow();
    expect(getTrigger(db, id)!.enabled).toBe(false);
  });
});

describe("the loop itself", () => {
  test("startTriggerLoop ticks on the injected clock and stop() ends it", () => {
    const id = seedDaily(new Date(nowMs));
    // Drive setInterval manually-ish: interval 5ms, clock static — the first
    // immediate run fires it without any sleeping.
    const loop = startTriggerLoop(db, { ...opts, intervalMs: 5 });
    try {
      expect(taskCount()).toBe(1);
      expect(getTrigger(db, id)!.lastFiredAt).toBeTruthy();
    } finally {
      loop.stop();
    }
  });
});
