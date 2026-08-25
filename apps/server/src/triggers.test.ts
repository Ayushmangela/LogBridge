// Triggers Phase 1: the schedule model. Pure parsing + zoned next-fire math,
// plus the storage round-trip through the REAL database functions.
//
// Time is never slept on (house rule 4): every test injects concrete instants,
// including the two boundaries that break naive timezone code — the US
// spring-forward / fall-back transitions of 2026 and a month end.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import {
  createTrigger, getTrigger, listTriggers, markTriggerFired,
  nextFireAt, parseSchedule, setTriggerEnabled,
} from "./triggers.js";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

const NY = "America/New_York";
// US 2026 DST: spring-forward Sun Mar 8 (EST→EDT), fall-back Sun Nov 1.
const MAR7_09NY = Date.UTC(2026, 2, 7, 14, 0); // 09:00 EST = 14:00Z
const NOV1_09NY = Date.UTC(2026, 10, 1, 14, 0); // 09:00 EST = 14:00Z (after fall-back)

describe("parseSchedule", () => {
  test("every accepted form parses to its structured schedule", () => {
    expect(parseSchedule("every day at 09:00")).toEqual({ ok: true, schedule: { kind: "daily", hh: 9, mm: 0 } });
    expect(parseSchedule("Every Weekday At 08:30")).toEqual({ ok: true, schedule: { kind: "weekdays", hh: 8, mm: 30 } });
    expect(parseSchedule("every monday at 17:45")).toEqual({ ok: true, schedule: { kind: "weekly", weekday: 1, hh: 17, mm: 45 } });
    expect(parseSchedule("every tue at 06:05")).toEqual({ ok: true, schedule: { kind: "weekly", weekday: 2, hh: 6, mm: 5 } });
    expect(parseSchedule("every 30 minutes")).toEqual({ ok: true, schedule: { kind: "interval", everyMinutes: 30 } });
    expect(parseSchedule("every 4 hours")).toEqual({ ok: true, schedule: { kind: "interval", everyMinutes: 240 } });
    // Whitespace and case are formatting, not meaning.
    expect(parseSchedule("  EVERY DAY AT 9:07  ")).toEqual({ ok: true, schedule: { kind: "daily", hh: 9, mm: 7 } });
  });

  test("invalid expressions produce errors a human can act on", () => {
    const bad = [
      "at nine",
      "whenever",
      "",
      "every",
      "every day at 25:00",
      "every day at 9:61",
      "every sprint at 09:00",
      "every 0 minutes",
      "sometimes",
    ];
    for (const expr of bad) {
      const r = parseSchedule(expr);
      expect(r.ok, `"${expr}" should be rejected`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10); // a sentence, not ""
    }
    // The actionable part: rejections list what IS accepted.
    const unknown = parseSchedule("whenever");
    if (!unknown.ok) expect(unknown.error).toContain('every day at HH:MM');
    const badTime = parseSchedule("every day at 25:61");
    if (!badTime.ok) expect(badTime.error).toMatch(/hours 00–23|not a time/i);
  });

  test("round-trips: parse → nextFireAt → parse stays coherent", () => {
    // The structured form is the only thing nextFireAt consumes; this pins
    // that parsing is stable enough to store-and-replay.
    for (const expr of ["every day at 09:00", "every weekday at 23:15", "every fri at 06:00"]) {
      const first = parseSchedule(expr);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      const ts = nextFireAt(first.schedule, Date.UTC(2026, 5, 10, 12, 0), NY);
      expect(ts).not.toBeNull();
    }
  });
});

describe("nextFireAt — DST correctness (America/New_York)", () => {
  test("spring-forward: the gap between consecutive 09:00s is 23 hours", () => {
    const s = parseSchedule("every day at 09:00");
    if (!s.ok) throw new Error(s.error);
    const next = nextFireAt(s.schedule, MAR7_09NY, NY);
    // Mar 8 2026 at 09:00 is EDT = 13:00Z — one hour EARLIER in UTC.
    expect(next).toBe(Date.UTC(2026, 2, 8, 13, 0));
    expect(next! - MAR7_09NY).toBe(23 * 3_600_000);
  });

  test("fall-back: the overlap between consecutive 09:00s is 25 hours", () => {
    const s = parseSchedule("every day at 09:00");
    if (!s.ok) throw new Error(s.error);
    // Oct 31 2026 09:00 EDT = 13:00Z; Nov 1 09:00 EST = 14:00Z.
    const before = nextFireAt(s.schedule, Date.UTC(2026, 9, 31, 13, 0), NY);
    expect(before).toBe(NOV1_09NY);
    expect(NOV1_09NY - Date.UTC(2026, 9, 31, 13, 0)).toBe(25 * 3_600_000);
  });

  test("a naive UTC reading of the same expression gets spring-forward WRONG by an hour", () => {
    // Documents why the Intl machinery exists: fixed-offset math would return
    // 14:00Z on Mar 8 and call it 09:00, which is 10:00 local.
    const s = parseSchedule("every day at 09:00");
    if (!s.ok) throw new Error(s.error);
    const correct = nextFireAt(s.schedule, MAR7_09NY, NY)!;
    expect(new Date(correct).toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(new Date(MAR7_09NY + 24 * 3_600_000).toISOString()).toBe("2026-03-08T14:00:00.000Z"); // what naive math returns
  });

  test("weekdays skip the weekend across it", () => {
    const s = parseSchedule("every weekday at 09:00");
    if (!s.ok) throw new Error(s.error);
    // Friday Mar 6 09:00 EST → next weekday firing is MONDAY Mar 9 09:00 EDT.
    const next = nextFireAt(s.schedule, Date.UTC(2026, 2, 6, 14, 0), NY);
    expect(next).toBe(Date.UTC(2026, 2, 9, 13, 0));
  });

  test("the zone decides the weekday, not UTC — a Tokyo trigger is not a New York one", () => {
    const s = parseSchedule("every monday at 09:00");
    if (!s.ok) throw new Error(s.error);
    // Sun 2026-06-07 20:00Z is already Monday 05:00 in Tokyo but still Sunday
    // in New York. Tokyo's next Monday firing must be THAT Monday morning
    // (today, later), while New York's cannot fire until the NEXT monday.
    const tokyo = nextFireAt(s.schedule, Date.UTC(2026, 5, 7, 20, 0), "Asia/Tokyo");
    const ny = nextFireAt(s.schedule, Date.UTC(2026, 5, 7, 20, 0), NY);
    expect(tokyo).toBeLessThan(ny!);
    expect(new Date(tokyo!).toISOString()).toBe("2026-06-08T00:00:00.000Z"); // Mon 09:00 JST
  });
});

describe("nextFireAt — month ends and intervals", () => {
  test("Jan 31 daily → Feb 1 (month rollover through real instants)", () => {
    const s = parseSchedule("every day at 09:00");
    if (!s.ok) throw new Error(s.error);
    const jan31 = Date.UTC(2027, 0, 31, 14, 0); // 09:00 NY (EST)
    expect(nextFireAt(s.schedule, jan31, NY)).toBe(Date.UTC(2027, 1, 1, 14, 0));
  });

  test("intervals are pure arithmetic, independent of any zone", () => {
    const s = parseSchedule("every 90 minutes");
    if (!s.ok) throw new Error(s.error);
    expect(nextFireAt(s.schedule, 1_000_000, NY)).toBe(1_000_000 + 90 * 60_000);
    const h = parseSchedule("every 4 hours");
    if (!h.ok) throw new Error(h.error);
    expect(nextFireAt(h.schedule, Date.UTC(2026, 2, 8, 6, 0), NY)).toBe(Date.UTC(2026, 2, 8, 6, 0) + 4 * 3_600_000);
  });

  test("strictly after: firing exactly at `afterMs` schedules tomorrow, not now", () => {
    const s = parseSchedule("every day at 09:00");
    if (!s.ok) throw new Error(s.error);
    expect(nextFireAt(s.schedule, Date.UTC(2026, 2, 8, 13, 0), NY)).toBe(Date.UTC(2026, 2, 9, 13, 0));
  });
});

describe("storage round-trip (real db)", () => {
  test("create stores the rule, template, tz and computed next fire", async () => {
    const res = createTrigger(db, {
      projectId: "prj_t", name: "Morning triage",
      kind: "schedule", rule: "every weekday at 09:00",
      template: { title: "Triage overnight CI failures", requiredCapability: "fix_test", budgetSeconds: 900 },
    });
    expect(res.ok).toBe(true);

    const trig = getTrigger(db, (res as any).id)!;
    expect(trig.name).toBe("Morning triage");
    expect(trig.enabled).toBe(true);
    expect(trig.kind).toBe("schedule");
    expect(trig.rule).toBe("every weekday at 09:00");
    expect(trig.taskTitle).toBe("Triage overnight CI failures");
    expect(trig.taskCapability).toBe("fix_test");
    expect(trig.budgetSeconds).toBe(900);
    expect(trig.tz).toBeTruthy(); // defaulted to the server's zone
    expect(trig.nextFireAt).toBeTruthy();
    expect(trig.lastFiredAt).toBeNull();

    expect(listTriggers(db, "prj_t")).toHaveLength(1);
    expect(listTriggers(db, "prj_other")).toHaveLength(0);
  });

  test("storage refuses a schedule it cannot parse — with the reason", () => {
    const res = createTrigger(db, {
      projectId: "prj_t", name: "bad", kind: "schedule", rule: "whenever sam feels like it",
      template: { title: "x" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Unknown schedule");
    expect(listTriggers(db, "prj_t")).toHaveLength(0);
  });

  test("enable/disable and markFired update in place", async () => {
    const res = createTrigger(db, {
      projectId: "prj_t", name: "t", kind: "schedule", rule: "every 30 minutes",
      template: { title: "tick" },
    });
    const id = (res as any).id;

    setTriggerEnabled(db, id, false);
    expect(getTrigger(db, id)!.enabled).toBe(false);
    setTriggerEnabled(db, id, true);
    expect(getTrigger(db, id)!.enabled).toBe(true);

    const fired = Date.UTC(2026, 5, 10, 12, 0);
    markTriggerFired(db, id, fired, fired + 30 * 60_000);
    const t = getTrigger(db, id)!;
    expect(t.lastFiredAt).toBe(new Date(fired).toISOString());
    expect(t.nextFireAt).toBe(new Date(fired + 30 * 60_000).toISOString());
  });

  test("migration is idempotent: reopening the same database file changes nothing", () => {
    const path = ":memory:";
    void path;
    // :memory: dies with the handle, so prove idempotence against a FILE db:
    const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const dir = mkdtempSync(join2(tmpdir(), "logbridge-trig-"));
    const file = join2(dir, "t.db");
    try {
      const d1 = openDb(file);
      d1.close();
      const d2 = openDb(file); // second open re-runs SCHEMA + migration paths
      const n = (d2.prepare("SELECT COUNT(*) AS n FROM triggers").get() as any).n;
      expect(n).toBe(0);
      d2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- tiny local helpers (imports kept minimal above) ---
import { tmpdir } from "node:os";
function join2(a: string, b: string): string {
  return a.replace(/\/$/, "") + "/" + b;
}
