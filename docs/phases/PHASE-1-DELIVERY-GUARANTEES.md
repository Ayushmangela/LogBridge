# Phase 1 — every message ends somewhere

**Prerequisite: Phase 0 must be working.** Verify first: a dispatch from god
causes sam to start with no human involved. If it does not, stop and fix that
— this phase assumes messages arrive.

## The problem

Today a hive message has one observable state: the file exists. There is no
way to distinguish:

- delivered and handled perfectly
- delivered and never read
- delivered to an agent that crashed mid-task

They look identical on disk. **That is why the harness failure went unnoticed
for an entire session** — nothing could have reported it, because nothing
tracked whether a message was acted on.

## What already exists — check before building

- `hive.ts` has `.done` (7 references) and `ack` (14). **Read these first.**
  There is partial acknowledgement support; find out exactly what it covers.
- `hive.ts` has **zero** references to `retry`, `attempts`, or `dead`.
- `deadLetter.ts` (201 lines) exists but is **entirely about tasks and
  attempts** — zero references to hive, inbox, outbox, or HiveMessage. Do not
  assume it covers messages. It does not.

So: acknowledgement is partly there; retry and message-level dead-lettering
are not.

## The model

```
pending ──► delivered ──► handled
   │            │
   │            ├─ timeout, attempts < N ──► redeliver (back to delivered)
   │            └─ attempts = N ──────────► dead
   └─ machine offline ─────────────────────► undeliverable   (Phase 0 does this)
```

Four terminal-ish states, and the important property is that **no message can
sit in an unknowable one**.

## Design decisions and why

**Ack on `.done/` move, not on read.** The protocol already tells agents to
move handled messages into `inbox/.done/`. That move is the honest signal —
an agent that read a message and did nothing has not handled it. Do not add a
separate ack step agents must remember; use the one they already perform.

**Redelivery must not duplicate work.** This is the trap. If an agent is
halfway through a task when redelivery fires, waking it again could double the
work. Options, in order of preference:

1. Do not redeliver while the agent is `working` — check status first. Cheap
   and correct in the common case.
2. Carry an idempotency key so a second wake for the same message is a no-op
   (Phase 0's `wokenFor` already does this within a process; make it durable).

**Dead-letter must be visible.** A message that fails N times and vanishes is
worse than one that never sent. It goes to `dead-letter/` **and** surfaces in
the office, because the human is the recovery mechanism.

**Timeouts should be generous.** An agent doing real work can take many
minutes. A 30-second redelivery would flood the floor. Start at something like
10 minutes and make it configurable; the failure you are guarding against is
"the agent died", not "the agent is slow".

## What to be suspicious of

1. **Redelivery storms.** A message that always fails, retried forever, on
   every router tick. The attempt counter must be durable — in the message
   file or a table, not in memory — or a server restart resets it to zero.
2. **Ack races.** The agent moves the file to `.done/` while the router is
   reading the directory. Handle a missing file as "handled", not as an error.
3. **Clock assumptions.** Do not use file mtime for timeouts; a synced folder
   or a restore will lie to you. Record an explicit `delivered_at`.
4. **Counting the wrong thing.** A crash retry, a rejected review, and a
   reassignment are different failures. Do not let them share one counter —
   the deep-research report makes this point and it is right.

## Done when

- Killing an agent mid-task causes exactly one redelivery, not a stream.
- A message that fails N times lands in `dead-letter/` and appears in the
  office.
- An agent that handles a message normally never triggers a redelivery.
- A server restart does not reset attempt counts.
- Tests cover each transition, and each fails without its fix.
