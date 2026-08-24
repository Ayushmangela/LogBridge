# The orchestrator

A supervisor that decides which agent runs which task. It does that by
**rules**, not by a model, and the difference matters enough to be the first
thing stated here.

## What it does

It answers exactly one question:

> Given a task nobody is assigned to, which agent should run it?

By capability, availability and load:

1. The agent must be in the task's project.
2. Its machine must be **online** — a sleeping laptop cannot take work.
3. If the task names a `requiredCapability`, the agent must declare it.
4. It must be under its `concurrency` limit.
5. Among those, the **least loaded** wins; ties break on agent id.

Everything else follows from that. Submit work without naming an agent
(`POST /debug/submit-task`) and it either gets routed immediately or **queues**
until someone can take it.

## What it deliberately is NOT

**It does not decide what work should exist.** Turning "ship the billing
feature" into a set of tasks is a reasoning job, and this project still has no
LLM wired into it anywhere (the same gap `DECISIONS.md` D24 records for
`ptyHarness` and D25 for semantic recall). This component routes; it does not
reason. Calling rule-based routing an "AI orchestrator" would be the kind of
overclaim the rest of this codebase avoids.

What is here is real: capability matching, real availability, real load
balancing, real FIFO queueing. It just isn't intelligence.

**It never reassigns or retries.** A task whose runner went silent is failed by
the lease sweep (D20's rule: surfaced, never silently retried), and the
orchestrator does not pick it back up. Auto-retry would resurrect exactly the
double-execution problem leases exist to prevent.

**No priorities, no deadlines, no preemption.** The queue is FIFO. A task
cannot jump ahead, and a running task is never interrupted for a more important
one. At this scale that's adequate; it is not a scheduler.

## Determinism

Same database state, same decision — every time. This is a deliberate
constraint, not an accident of implementation:

- If the choice were random, *"why did that run on Sam's laptop?"* would be
  unanswerable, and D4's event log would record the what without the why.
- The office would reshuffle between renders for no observable reason, which
  D11 (position is a pure function of state) rules out.

Ties break on agent id rather than row order for the same reason. And the
pending queue is ordered by `created_at, rowid` — **not** `created_at, id` —
because `created_at` is only millisecond-resolution, so a burst of submissions
shares a timestamp and a UUID tie-break would make the "queue" arbitrary rather
than FIFO. `rowid` is insertion order by definition. There is a regression test
for exactly this.

## When it runs

`orchestrate()` is called wherever capacity changes:

| Trigger | Why |
|---|---|
| a task is submitted unassigned | there may be someone free right now |
| a machine authenticates | its agents are new capacity |
| an agent card is registered | likewise |
| a task result lands | that agent just freed a slot |
| the lease sweep releases a task | same |

It is cheap by design — with nothing pending it is a couple of indexed reads —
which is what allows one entry point everywhere instead of three subtly
different ones.

## Safety properties

**No double-assignment.** `assignTaskToAgent` updates with an
`agent_id IS NULL AND state = 'submitted'` guard, so a second caller racing the
first changes zero rows and gets `false` back rather than stealing the task.

**No overfilling within a pass.** Load is incremented in memory as tasks are
assigned, so two tasks in one pass cannot both be handed to an agent with one
free slot.

**"Nobody is free" is a queue, not an error.** An unroutable task stays
`submitted` and is retried on the next call. It is never failed — failing work
because the team is busy would be a lie about what happened.

**Hand-assigned tasks are left alone.** Anything with an `agent_id` already set
is invisible to the orchestrator, so `@mention` and `/debug/offer-task` keep
working exactly as before.

## Files

| Path | What |
|---|---|
| `apps/server/src/orchestrator.ts` | `pickAgent()` (pure), `assignPendingTasks()` |
| `apps/server/src/db.ts` | the queue and capacity queries, the assignment guard |
| `apps/server/src/nodeGateway.ts` | `orchestrate()` and its trigger points |
| `apps/server/src/orchestrator.test.ts` | routing rules, queueing, FIFO, double-assign |
