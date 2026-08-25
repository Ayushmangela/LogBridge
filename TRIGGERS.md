# Triggers

A **trigger** is a standing rule that creates a task when a condition is met:

- *every weekday at 09:00* → "Triage overnight CI failures"
- *when CI goes red on main* → "Find and fix the failing test" *(Phase 3)*

Tasks exist because a human typed one, GitHub was mirrored, or a plan was
approved. Nothing started itself. Triggers close that gap.

Status: **Phase 1 shipped** (the schedule model + storage). The firing loop
is Phase 2; event triggers Phase 3; the wire surface Phase 4. Nothing fires
yet.

---

## Schedule grammar — complete and exact

| Expression | Meaning |
|---|---|
| `every day at HH:MM` | once per calendar day |
| `every weekday at HH:MM` | Monday through Friday |
| `every <weekday> at HH:MM` | one specific weekday (`mon`…`sun`, full names too) |
| `every <n> minutes` | interval, n ≥ 1 |
| `every <n> hours` | interval |

- `HH:MM` is two-digit minutes: `09:00`, not `9:00`. Single-digit hours are
  accepted (`9:07`) but minutes must be two digits.
- Case and surrounding whitespace are ignored.
- Anything else is rejected with an error listing the accepted forms.
  Deliberately absent: cron syntax, seconds, "weekend", multiple times per
  day, month/day-of-month fields. A rule nobody can read is worse than a rule
  that only does five things — add forms only when something real needs them.

---

## Timezones — the decision

**Wall-clock schedules are evaluated in an explicit IANA timezone stored on
each trigger row (`triggers.tz`), defaulted to the server's own zone at
creation time.** Every next-fire computation renders wall-clock time through
`Intl.DateTimeFormat` in that zone; no fixed UTC offsets anywhere.

Why this matters, concretely: for `every day at 09:00` in
`America/New_York`, the gap between the Saturday and Sunday firings around
the March 2026 spring-forward is **23 hours**, and around the November
fall-back it is **25 hours**. Fixed-offset math gets both wrong by an hour,
which means 09:00 silently becomes 10:00 local half the year. A trigger that
says nine says nine all year.

The tests pin exact UTC instants across both 2026 transitions, plus a Tokyo
vs New York case proving the *weekday itself* is read in the target zone
(Sunday 20:00 UTC is already Monday morning in Tokyo).

Intervals (`every N minutes/hours`) are zone-independent arithmetic by
design: they measure elapsed time, not appointments.

---

## What each mode costs

**Wall-clock schedules** are evaluated through `Intl` in the trigger's stored
zone on every check. That is a real cost per evaluation, and it is the price
of being right across a DST transition — fixed offsets are cheaper and wrong
twice a year.

Two boundary behaviours worth knowing, both verified against 2026's US
transitions:

- **A wall-clock time that does not exist.** On spring-forward day `02:30`
  never happens. The next firing lands on the same absolute instant, which
  renders as `03:30` local. The day is 23 hours long and the trigger still
  fires once.
- **A wall-clock time that happens twice.** On fall-back day `01:30` occurs in
  both the old and new offset. The **first** occurrence fires. The day is 25
  hours long and the trigger still fires once.

**Intervals** ignore the zone entirely — "every 30 minutes" is elapsed time,
not an appointment, so it neither skips nor repeats across a transition.

**An unknown zone is refused at write time.** Every zoned computation goes
through `Intl`, which throws rather than degrading, so `createTrigger` checks
the zone and returns `{ ok: false }` — keeping the throw out of the fire loop,
where it would be an exception on a timer instead of an error someone reads.

## Storage

Table `triggers`: identity, project, name, enabled flag, kind
(`schedule`/`event`), the raw `rule` as written, the task template (title,
spec, required capability, budget), the resolved `tz`, and the bookkeeping
pair `last_fired_at` / `next_fire_at`.

The schema ships via `CREATE TABLE IF NOT EXISTS` in `openDb`'s SCHEMA — a
new table needs no ALTER-list migration, and reopening an existing database
file twice is a tested no-op.
