// Trigger schedules (HANDOFF-TRIGGERS.md, stream B, Phase 1).
//
// A trigger is a standing rule that creates a task when a condition is met.
// Phase 1 builds only the VOCABULARY: parsing a schedule expression and
// computing its next firing instant. Nothing here fires anything.
//
// Grammar — deliberately tiny, documented in TRIGGERS.md:
//     every day at HH:MM          every weekday at HH:MM
//     every <weekday> at HH:MM    every <n> minutes|hours
// Anything else is rejected with a message listing what IS accepted, because
// a rule nobody can read is worse than a rule that only does five things.
//
// TIMEZONE DECISION (the trap this module exists to get right): wall-clock
// schedules are evaluated in an explicit IANA timezone stored per trigger
// (`tz`, defaulted to the server's zone at creation). Every computation goes
// through Intl.DateTimeFormat in that zone — never fixed offsets — so 09:00
// stays 09:00 the morning after a DST spring-forward, and the gap between two
// consecutive 09:00s is genuinely 23 hours, not a rounded 24.
import type { Db } from "./db.js";

// ---------------------------------------------------------------- schedule

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, per getDay()

export type Schedule =
  | { kind: "daily"; hh: number; mm: number }
  | { kind: "weekdays"; hh: number; mm: number } // Mon–Fri
  | { kind: "weekly"; weekday: Weekday; hh: number; mm: number }
  | { kind: "interval"; everyMinutes: number };

export type ParseResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; error: string };

const WEEKDAYS: Record<string, Weekday> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

const ACCEPTED =
  'Accepted forms: "every day at HH:MM", "every weekday at HH:MM", ' +
  '"every <weekday> at HH:MM", "every <n> minutes", "every <n> hours".';

function parseClock(raw: string): { hh: number; mm: number } | { error: string } {
  const [hhS, mmS] = raw.split(":");
  const hh = Number(hhS), mm = Number(mmS);
  // Number("") is 0, which would let "9:" parse as 09:00 — insist on digits.
  if (!/^\d{1,2}$/.test(hhS ?? "") || !/^\d{2}$/.test(mmS ?? "")) {
    return { error: `"${raw}" is not a time. Use HH:MM, e.g. 09:00.` };
  }
  if (hh > 23 || mm > 59) {
    return { error: `${raw} is not a valid time — hours 00–23, minutes 00–59.` };
  }
  return { hh, mm };
}

/** Parse one schedule expression. Pure; throws nothing. */
export function parseSchedule(expr: string): ParseResult {
  const s = expr.trim().toLowerCase();

  const m = s.match(/^every (day|weekday|([a-z]+)) at (\S+)$/);
  if (m) {
    const time = parseClock(m[3]);
    if ("error" in time) return { ok: false, error: time.error };
    if (m[1] === "day") return { ok: true, schedule: { kind: "daily", ...time } };
    if (m[1] === "weekday") return { ok: true, schedule: { kind: "weekdays", ...time } };
    const wd = WEEKDAYS[m[2]];
    if (wd !== undefined) {
      return { ok: true, schedule: { kind: "weekly", weekday: wd, ...time } };
    }
    // "every sprint at 09:00" reads like it should work — say why it doesn't.
    return { ok: false, error: `"${m[2]}" is not a weekday. ${ACCEPTED}` };
  }

  const iv = s.match(/^every (\d+) (minutes?|hours?)$/);
  if (iv) {
    const n = Number(iv[1]);
    if (n < 1) return { ok: false, error: `"${expr}" — the count must be at least 1.` };
    const everyMinutes = iv[2].startsWith("hour") ? n * 60 : n;
    return { ok: true, schedule: { kind: "interval", everyMinutes } };
  }

  return { ok: false, error: `Unknown schedule "${expr}". ${ACCEPTED}` };
}

// ------------------------------------------------------- zoned wall-clock

const WEEKDAY_INDEX: Record<string, Weekday> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface ZonedParts { y: number; m: number; d: number; hh: number; mm: number; weekday: Weekday }

function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")), m: Number(get("month")), d: Number(get("day")),
    hh: Number(get("hour")) % 24, // some ICU versions render midnight as 24
    mm: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/**
 * The absolute instant at which wall-clock y-m-d hh:mm occurs in `tz`.
 *
 * You cannot multiply: a zone offset depends on the date (DST). So guess with
 * UTC, render the guess back through the zone, and shift by the difference —
 * three iterations converge for every real zone rule, including the ambiguous
 * hour of a fall-back (both renders agree there) and the skipped hour of a
 * spring-forward (the shift lands on the first instant after the gap).
 */
function instantFor(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  let ts = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(ts, tz);
    const want = Date.UTC(y, m - 1, d, hh, mm);
    const got = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    if (want === got) return ts;
    ts += want - got;
  }
  return ts;
}

function dayAllowed(s: Schedule, weekday: Weekday): boolean {
  switch (s.kind) {
    case "daily": return true;
    case "weekdays": return weekday >= 1 && weekday <= 5;
    case "weekly": return weekday === s.weekday;
    case "interval": return true;
  }
}

/**
 * Next firing strictly AFTER `afterMs`, or null if none exists within eight
 * candidate days (unreachable for every valid schedule — the null exists so
 * the signature never has to lie with Infinity).
 *
 * Candidate days advance through REAL instants (Date.UTC normalises month
 * ends: Jan 31 + 1 day is Feb 1), and each candidate's weekday is read in the
 * TARGET ZONE, because 23:00 UTC on Sunday is already Monday in Tokyo.
 */
export function nextFireAt(schedule: Schedule, afterMs: number, tz: string): number | null {
  if (schedule.kind === "interval") return afterMs + schedule.everyMinutes * 60_000;

  const p = zonedParts(afterMs, tz);
  for (let i = 0; i < 8; i++) {
    const cand = new Date(Date.UTC(p.y, p.m - 1, p.d + i, schedule.hh, schedule.mm));
    const ts = instantFor(
      cand.getUTCFullYear(), cand.getUTCMonth() + 1, cand.getUTCDate(),
      schedule.hh, schedule.mm, tz
    );
    if (ts <= afterMs) continue;
    if (dayAllowed(schedule, zonedParts(ts, tz).weekday)) return ts;
  }
  return null;
}

// ------------------------------------------------------------------ storage

export interface TriggerTemplate {
  title: string;
  spec?: string | null;
  requiredCapability?: string | null;
  budgetSeconds?: number;
  budgetUsd?: number;
}

export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/**
 * Whether the runtime knows this IANA zone.
 *
 * Every zoned computation below goes through Intl, which THROWS a RangeError
 * on an unknown zone rather than falling back. Checking once at write time
 * keeps that throw out of the fire loop, where it would be an exception on a
 * timer rather than an error someone can read.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type CreateTriggerResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Create a standing rule. Schedule-kind rules must parse — storage refusing
 * nonsense here is cheaper than a fire loop discovering it at 09:00 someday.
 */
export function createTrigger(
  db: Db,
  input: {
    projectId: string;
    name: string;
    kind: "schedule" | "event";
    rule: string;
    template: TriggerTemplate;
    enabled?: boolean;
    /** IANA zone; defaults to the server's own. */
    tz?: string;
  }
): CreateTriggerResult {
  // Refuse an unknown zone for the same reason an unparseable rule is
  // refused: this function promises {ok:false} on bad input, and Intl throws
  // instead of degrading. Without this, "Mars/Phobos" escaped as a RangeError
  // — past the return type, into whatever HTTP handler called it.
  const tz = input.tz ?? defaultTimezone();
  if (!isValidTimezone(tz)) {
    return { ok: false, error: `"${tz}" is not a known IANA time zone (try "America/New_York").` };
  }

  let nextFire: number | null = null;
  if (input.kind === "schedule") {
    const parsed = parseSchedule(input.rule);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    nextFire = nextFireAt(parsed.schedule, Date.now(), tz);
  }
  const id = `trg_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO triggers (id, project_id, name, enabled, kind, rule,
       task_title, task_spec, task_capability, budget_seconds, budget_usd,
       tz, created_at, next_fire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.projectId, input.name, input.enabled === false ? 0 : 1, input.kind,
    input.rule, input.template.title, input.template.spec ?? null,
    input.template.requiredCapability ?? null, input.template.budgetSeconds ?? null,
    input.template.budgetUsd ?? null, tz,
    new Date().toISOString(), nextFire ? new Date(nextFire).toISOString() : null
  );
  return { ok: true, id };
}

export interface TriggerRow {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  kind: "schedule" | "event";
  rule: string;
  taskTitle: string;
  taskSpec: string | null;
  taskCapability: string | null;
  budgetSeconds: number | null;
  budgetUsd: number | null;
  tz: string;
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
}

function rowToTrigger(r: any): TriggerRow {
  return {
    id: r.id, projectId: r.project_id, name: r.name,
    enabled: Boolean(r.enabled), kind: r.kind, rule: r.rule,
    taskTitle: r.task_title, taskSpec: r.task_spec, taskCapability: r.task_capability,
    budgetSeconds: r.budget_seconds, budgetUsd: r.budget_usd,
    tz: r.tz, createdAt: r.created_at,
    lastFiredAt: r.last_fired_at, nextFireAt: r.next_fire_at,
  };
}

export function listTriggers(db: Db, projectId: string): TriggerRow[] {
  return (db.prepare("SELECT * FROM triggers WHERE project_id = ? ORDER BY created_at").all(projectId) as any[])
    .map(rowToTrigger);
}

export function getTrigger(db: Db, id: string): TriggerRow | undefined {
  const r = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  return r ? rowToTrigger(r) : undefined;
}

export function setTriggerEnabled(db: Db, id: string, enabled: boolean): void {
  db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

/** Record a firing and reschedule. Phase 2's loop calls this atomically-ish:
 *  better-sqlite3 is synchronous single-process, so check-then-write cannot
 *  interleave with itself. */
export function markTriggerFired(db: Db, id: string, firedAtMs: number, nextFireMs: number | null): void {
  db.prepare("UPDATE triggers SET last_fired_at = ?, next_fire_at = ? WHERE id = ?").run(
    new Date(firedAtMs).toISOString(),
    nextFireMs != null ? new Date(nextFireMs).toISOString() : null,
    id
  );
}

// ===========================================================================
// Firing — turning due triggers and matching events into real tasks.
//
// Modelled on github.ts's poll: an interval that unrefs, an immediate first
// run, and a stop(). The clock is injectable so tests never sleep.
// ===========================================================================

import { appendEvent, createTask } from "./db.js";

export interface TriggerLoopOptions {
  now?: () => number;
  log?: (msg: string) => void;
  intervalMs?: number;
  onChange?: () => void;
}
export type EventLoopOptions = TriggerLoopOptions;

/** Disable a trigger that cannot work, with a reason a person can act on.
 *  Failing loudly forever is the alternative, and it is worse: one bad row
 *  would keep throwing on every tick and drown the log. */
function disableBroken(db: Db, id: string, name: string, why: string, log: (m: string) => void): void {
  db.prepare("UPDATE triggers SET enabled = 0 WHERE id = ?").run(id);
  log(`trigger "${name}" (${id}) disabled: ${why}`);
}

/**
 * Fire every schedule trigger whose slot has passed.
 *
 * Catch-up policy: a trigger reschedules from NOW, never from the slot it
 * missed. A server dark for three days fires once and moves on — replaying
 * three days of "morning triage" would bury the person under work whose
 * moment has passed. Elapsed time is not a queue.
 */
export function fireDueTriggers(db: Db, opts: TriggerLoopOptions = {}): number {
  const now = opts.now?.() ?? Date.now();
  const log = opts.log ?? (() => {});
  const rows = db
    .prepare("SELECT * FROM triggers WHERE enabled = 1 AND kind = 'schedule' AND next_fire_at IS NOT NULL")
    .all() as any[];

  let fired = 0;
  for (const t of rows) {
    const due = Date.parse(t.next_fire_at);
    if (!Number.isFinite(due) || due > now) continue;

    const parsed = parseSchedule(t.rule);
    if (!parsed.ok) {
      // A rule that no longer parses cannot be rescheduled, so it would stay
      // due forever and throw on every tick.
      disableBroken(db, t.id, t.name, parsed.error, log);
      continue;
    }

    try {
      // The idem key is the trigger plus the SLOT it is firing for — not the
      // wall clock. That is what survives a restart between "task created"
      // and "bookkeeping written": the retry computes the same key, finds the
      // existing task, and advances the bookkeeping instead of duplicating.
      const taskId = createTask(db, {
        projectId: t.project_id,
        title: t.task_title || t.name,
        spec: t.task_spec ?? null,
        creatorId: t.id,
        agentId: null,
        requiredCapability: t.task_capability ?? null,
        budgetSeconds: t.budget_seconds ?? undefined,
        budgetUsd: t.budget_usd ?? undefined,
        idem: `trigger:${t.id}:${t.next_fire_at}`,
      });

      appendEvent(db, t.project_id, taskId, "trigger.fired", {
        triggerId: t.id, name: t.name, rule: t.rule, title: t.task_title, taskId,
      });

      const next = nextFireAt(parsed.schedule, now, t.tz || "UTC");
      markTriggerFired(db, t.id, now, next);
      fired++;
    } catch (err) {
      disableBroken(db, t.id, t.name, (err as Error).message, log);
    }
  }

  if (fired > 0) opts.onChange?.();
  return fired;
}

export function startTriggerLoop(db: Db, opts: TriggerLoopOptions = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 30_000;
  fireDueTriggers(db, opts); // first run immediately, like github.ts
  const timer = setInterval(() => fireDueTriggers(db, opts), intervalMs);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer) };
}

// Debounce note. An earlier attempt added a wall-clock quiet period on top
// of the per-tick limit, and it was wrong twice over: it blocked two GENUINELY
// different subjects failing in the same minute (two distinct tasks each
// deserve triage), and it was unnecessary — with the scan window always
// advancing, a burst of forty events is consumed in one tick and the
// thirty-nine unfired ones are never revisited. The bound is structural, not
// temporal, which is why it cannot leak one task per tick.

/**
 * Fire event triggers against newly appended events.
 *
 * Three properties this has to hold, each of which was got wrong once:
 *
 *  1. **The scan window always advances.** `last_evt_seq` moves to the newest
 *     event seen on EVERY path — fired, debounced, skipped or no match. Left
 *     un-advanced, the same events are re-scanned next tick and the debounce
 *     leaks one task per tick forever, while an office that appends a
 *     `position` event per step makes the rescan unbounded.
 *
 *  2. **Loop safety is by provenance, not by event type.** Any task created
 *     by ANY trigger is marked (creator_id = trigger id), and events about
 *     such tasks never fire a trigger. Special-casing `task.result` left
 *     `trigger.fired` — which this function itself appends — free to feed
 *     itself forever.
 *
 *  3. **Debounce is wall-clock.** See EVENT_DEBOUNCE_MS.
 */
export function fireEventTriggers(db: Db, opts: EventLoopOptions = {}): number {
  const now = opts.now?.() ?? Date.now();
  const log = opts.log ?? (() => {});

  const triggers = db
    .prepare("SELECT * FROM triggers WHERE enabled = 1 AND kind = 'event'")
    .all() as any[];
  if (triggers.length === 0) return 0;

  const maxSeq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as any).m as number;
  const advance = db.prepare("UPDATE triggers SET last_evt_seq = ? WHERE id = ?");

  // Every trigger id, so an event about a trigger-born task is recognisable
  // no matter which trigger created it.
  const triggerIds = new Set(
    (db.prepare("SELECT id FROM triggers").all() as any[]).map((r) => r.id)
  );

  let fired = 0;
  for (const t of triggers) {
    const lastSeq: number = t.last_evt_seq ?? 0;
    if (maxSeq <= lastSeq) continue;

    const candidates = db
      .prepare("SELECT seq, task_id, type FROM events WHERE seq > ? AND type = ? ORDER BY seq")
      .all(lastSeq, t.rule) as any[];

    // Whatever happens below, this trigger has now SEEN everything up to
    // maxSeq. Property 1.
    let handled = false;
    for (const ev of candidates) {
      // Property 2 — provenance. A task this or any other trigger created
      // cannot cause another firing.
      if (ev.task_id) {
        const owner = db.prepare("SELECT creator_id FROM tasks WHERE id = ?").get(ev.task_id) as any;
        if (owner && triggerIds.has(owner.creator_id)) continue;
        if (ev.task_id === t.last_consumed_task_id) continue; // already acted on
      }

      try {
        const taskId = createTask(db, {
          projectId: t.project_id,
          title: t.task_title || t.name,
          spec: t.task_spec ?? null,
          creatorId: t.id,
          agentId: null,
          requiredCapability: t.task_capability ?? null,
          budgetSeconds: t.budget_seconds ?? undefined,
          budgetUsd: t.budget_usd ?? undefined,
          // Keyed on the EVENT, not the clock: re-processing the same event
          // must not be able to produce a second task.
          idem: `event:${t.id}:${ev.seq}`,
        });
        appendEvent(db, t.project_id, taskId, "trigger.fired", {
          triggerId: t.id, name: t.name, rule: t.rule, title: t.task_title,
          taskId, eventSeq: ev.seq,
        });
        db.prepare("UPDATE triggers SET last_evt_fire_ms = ?, last_consumed_task_id = ? WHERE id = ?")
          .run(now, ev.task_id ?? null, t.id);
        fired++;
        handled = true;
        break; // one task per trigger per tick; the rest are debounced
      } catch (err) {
        disableBroken(db, t.id, t.name, (err as Error).message, log);
        handled = true;
        break;
      }
    }
    void handled;
    advance.run(maxSeq, t.id);
  }

  if (fired > 0) opts.onChange?.();
  return fired;
}

export function startEventLoop(db: Db, opts: EventLoopOptions = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 15_000;
  fireEventTriggers(db, opts);
  const timer = setInterval(() => fireEventTriggers(db, opts), intervalMs);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer) };
}
