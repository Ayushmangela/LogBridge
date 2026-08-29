# Development plan — agent coordination

> **Per-phase briefs live in `docs/phases/`** — one document each, written as
> reasoning rather than requirements. Hand an AI exactly one, and only after
> the previous phase is verified. Phase 0 is built; **Phases 3 and 4 are
> audits, not builds** — those tables already exist and are in use.

Merges three inputs: the diagnosis in `AGENT-ARCHITECTURE.md` (what is broken
now, evidence-checked against the code), the design in
`docs/history/deep-research-report.md` (what it should become), and the papers
in `research/`.

---

## What I took from the deep-research report

It is good, and it is stronger than my own analysis in three specific places:

1. **Task / TaskAttempt split.** I did not propose this and should have. One
   logical task, many attempts, each with its own status and timestamps.
   Retries, rework and reassignment stop overwriting history. It also gives
   idempotency a natural key. **Adopted wholesale.**
2. **Artifacts by reference, never by value.** Agents pass
   `{ diff_artifact_id: 1234 }`, not the diff. Metadata in the DB, bytes on
   disk. This is the biggest token saving available and it is structural, not
   a prompt trick. **Adopted.**
3. **Claim-verification discipline.** It marked unsupported numbers NOT
   VERIFIED and rejected a future-dated arXiv reference outright. That is the
   right instinct and worth keeping as a habit.

We independently reached the same conclusions on: direct routing first with
Contract Net only for ambiguous tasks; A2A as an adapter rather than the core;
DB as the source of truth with events for the UI; no event sourcing; no
workflow DSL.

### Where I would change it

- **It does not identify the wake gap.** It designs the destination without
  noticing that dispatch currently delivers into a void. Phase 0 below exists
  because of that, and nothing in the report's plan works until it is done.
- **"Shared blackboard: NOT NEEDED NOW" is too strong.** `board.md` and
  `tasks.json` are load-bearing in the running system and — more importantly —
  they are what the *human* reads. Demote the blackboard from transport to
  plan-of-record; do not remove it.
- **It models agents as addressable services** ("Commander → Assign Task →
  Developer"). They are CLI processes that exit. Every arrow in its sequence
  diagram has to resolve to *spawn* or *inject*.
- **"Remove the global chatroom"** — room chat also carries humans, and the
  office renders it. Scope that removal to agent-to-agent chatter only.

---

## Phase 0 — Make dispatch actually arrive

**Nothing above this matters.** Today `startRouter(1500)` moves JSON between
folders and no one is told.

- On delivery, resolve the recipient: **live PTY → inject** a short notice;
  **no session, machine online → spawn** with the message as its prompt;
  **machine offline → leave pending, record `undeliverable`** (D28).
- Wake **only** when a message was genuinely moved for that agent. Three
  agents woke to empty inboxes in one transcript and asked the human what to
  do — that is pure token burn.
- Treat waking as execution: it causes code to run, so authorise it like spawn.

**Files:** `hive.ts` (router), `ptyGateway.ts` (inject path), `nodeGateway/`
(spawn path).
**Done when:** a dispatch from god causes sam to start working with no human
in the loop, and an offline recipient produces a visible `undeliverable`
rather than silence.

## Phase 1 — Give every message a terminal state

`pending → delivered → handled`, plus `undeliverable` and `dead`.

- Ack when the agent moves a message to `inbox/.done/`.
- Redeliver if `delivered` and unhandled past a timeout.
- After N attempts → `dead-letter/`, surfaced to the human.

Today "delivered but never read" is indistinguishable from "handled
perfectly", which is why the harness failure went unnoticed for a whole
session.

**Done when:** killing an agent mid-task causes redelivery, and a permanently
failing message lands in dead-letter instead of vanishing.

## Phase 2 — Fix the roster and enforce one writer

- **`fleet.json` becomes a projection** of `registry.json` plus live process
  state, regenerated, never hand-maintained. It currently lists an agent that
  does not exist and omits two that do.
- **Enforce god-as-sole-scribe** at the router: refuse a message asserting a
  write to a god-owned path. Two agents edited the same files and two design
  systems collided; the rule existed only in prose.

**Done when:** the roster cannot drift from the registry, and a second writer
to `board.md` is refused with a readable reason.

## Phase 3 — Task and TaskAttempt

From the report, adopted directly.

- `Task` (logical work) + `TaskAttempt` (one try: agent, status, timings,
  error).
- State machine: `CREATED → EXECUTING → VERIFYING → COMPLETED`, with rejection
  or failure opening a **new attempt** rather than adding a `REWORK` state.
- Distinguish retry classes: a crash is not a failed review is not a
  reassignment. They must not share one `max_attempts` counter.
- Keep `attempt_id` as the idempotency key — it makes exactly-once cheap.

**Done when:** a rejected review produces attempt 2 with attempt 1's history
intact, and replaying the same attempt cannot double-apply work.

## Phase 4 — Artifacts by reference

- `artifacts` table: id, project, task, attempt, type, path, size, hash,
  created_at. Bytes on disk; **no blobs in SQLite**.
- Messages carry `artifact_id`, never content.
- Immutable once written. No content-addressing or dedup yet — git already
  versions the code.

**Done when:** a developer→reviewer handoff carries an id, the reviewer
fetches by id, and no message body contains a diff.

## Phase 5 — Routing, honestly scoped

- **Direct capability match first.** The registry already carries
  capabilities; the orchestrator already routes. Use it.
- **Contract Net only when no single agent clearly fits.** It is 390 lines of
  working, tested code reachable only by an HTTP route no agent calls. Wire it
  as one *strategy* the orchestrator may choose — not the default path.
- Timeout and fallback: if no bid arrives, assign the best guess rather than
  stalling.

**Done when:** the common case never runs an auction, and the ambiguous case
has a bounded one.

## Phase 6 — Prove it is worth it

MAST exists because multi-agent gains over a single agent are **often minimal
and rarely measured**. We have no evidence the hive beats one agent.

- Take three real tasks. Run each single-agent and hive-orchestrated.
- Measure wall-clock, total tokens, and whether the output passed review
  unmodified.
- If the hive loses, say so and simplify. That is a legitimate outcome.

**Done when:** there is a number, either way.

---

## Sequencing

```
Phase 0 ─┬─► Phase 1 ─► Phase 2        (reliability: it works and you can see it)
         │
         └─► Phase 3 ─► Phase 4 ─► Phase 5   (structure: it scales)
                                     │
                                     └─► Phase 6  (evidence: it is worth it)
```

Phases 0–2 are the difference between a system that coordinates and one that
appears to. **Do not start Phase 3 before Phase 0 works** — the report's whole
design assumes messages arrive, and right now they do not.

## Deliberately not doing

Unchanged from `AGENT-ARCHITECTURE.md` §Part 4, and the report agrees on all of
them: no full FIPA ACL, no agent mesh, no message broker, no ANP/decentralised
identity, no event sourcing, no workflow DSL. The report additionally rejects
content-addressable storage and a global event sequence for now; both are
right.

## Resolved: agents talk in the room, in prose, with structure underneath

The earlier open question — typed messages versus free-form chat — had a
better answer than either option. **Both, in one message.**

The product requirement is that the office feels alive: you should watch `sam`
and `ram` talk like two colleagues, and `@sam improve the ui` should just
work. A typed-only channel makes the office silent. A prose-only channel is
where agents mis-parse each other, which this project has already lived
through ("two design systems collided").

So every agent-to-agent message carries **a line for the room and a payload
for the machine**:

```json
{
  "type": "REVIEW_REQUEST",
  "to": "ram",
  "say": "hey, finished the card layout — can you check the contrast ratios? the muted text might fail AA on dark",

  "task_id": "t6",
  "attempt_id": 1,
  "artifact_id": "art_4821",
  "scope": ["styles.css:.product-card"],
  "criteria": ["wcag-aa-contrast"]
}
```

The office renders only `say`:

```
sam → ram   hey, finished the card layout — can you check the
            contrast ratios? the muted text might fail AA on dark
ram         on it
ram → sam   two fail: .price-note is 3.1:1, needs 4.5:1
```

`ram` acts on the typed half — it fetches `art_4821` and checks that exact
scope. Nobody parses English to find out which file was meant.

### The rules that make this work

1. **`say` is required on every agent-to-agent message.** If an agent omits
   it, the router generates a plain fallback from the type, so the room is
   never silent. A silent office is the failure mode we are designing against.
2. **`say` is never authoritative.** The typed fields are what the recipient
   acts on. This is exactly a commit message versus the diff: the prose
   describes, the payload *is*. If they disagree, the payload wins — and the
   disagreement is a detectable bug, not a silent misread.
3. **`say` is capped** — one or two sentences. It is the gist, not the
   context. The office is a conversation, not a transcript dump.
4. **An acknowledgement is a first-class message.** A spawned agent's first
   act is a short `ACK` with a `say` ("on it"). Cheap, and it is what makes
   the floor read as people rather than processes.
5. **`@name` from a human is the same message** with `say` set to what the
   human typed. One path, whether the sender is a person or an agent.

### What this changes upstream

- Phase 0's wake path becomes the delivery mechanism for `@mention` too:
  mention → typed message → wake. `parseMention` in `gateway.ts` already does
  the parsing; it currently creates a task and stops.
- Phase 4's artifact-by-reference is what keeps `say` short. Without it,
  agents paste diffs into chat and the room becomes unreadable.
- Human chat is **untouched**. Free text, no schema, exactly as now.

### Still open

Whether an agent's `say` should be written by the agent (natural voice, may
drift from the payload) or generated from the payload (always consistent,
reads stilted). My recommendation is **agent-written with a generated
fallback** — the personality is the point, and rule 2 means drift cannot cause
a wrong action, only a confusing line.
