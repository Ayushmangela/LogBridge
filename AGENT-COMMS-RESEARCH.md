# Multi-agent communication — research and recommendation

Grounded in what this codebase actually does, not in what the prompts claim.
Every finding below was checked against the source.

---

## 1. The finding that explains the idle agents

The commander's own prompt says:

> "The Hive message router immediately delivers these to recipient inboxes
> **and wakes their terminals to code.**"

**The second half is not true.** In `apps/server/src/hive.ts` (844 lines):

```
wake        0 occurrences
notify      0
nudge       0
inject      0
sendToPty   0
```

`startRouter(1500)` moves JSON files from `outbox/` to `inbox/` every 1.5
seconds. **Nothing tells the agent a message arrived.** `ptyGateway.ts` imports
`HiveManager` and builds hive prompts at *startup*, but never reads an inbox to
push anything into a running PTY. There is no inbox → agent path at all.

So an agent only discovers its mail when a human opens it and it runs its
"read your inbox at task start" instruction. That is exactly what the samsung
transcript shows: three agents woke, found empty inboxes, and asked the human
what to do. The delegation never fired.

`board.md` had already recorded the symptom without naming the cause:

> "the delegation harness was NOT live. Tasks dispatched to sam/ram were
> executed by spawned workers … and by god directly."

God did the work itself — the one thing its protocol explicitly forbids —
because dispatch is a no-op.

**Second bug, same area:** `fleet.json` lists `agt_b793523e` and
`agt_scout01`; `registry.json` lists `agt_7f6a3c1d` (sam), `agt_94bcb8f3`
(ram), `agt_b793523e`. The monitoring file the commander is told to read is
**missing both workers** and contains an agent that does not exist. All
`tokens`/`cost` are `0`.

## 2. There are three overlapping messaging systems

| System | Where | Status |
|---|---|---|
| **Sealed delegation** over WebSocket | `nodeGateway/delegation.ts` | Works, tested end to end, sealed (D26) |
| **File hive** inbox/outbox + poller | `hive.ts` | Running the samsung project. No wake path |
| **Contract Net** (CfP → bid → award) | `communication/contractNet.ts` | 390 lines, HTTP routes, **never called by any agent loop** |

Three mechanisms, none complete. This is the real problem — more than any
single missing feature.

---

## 3. The patterns, honestly compared

### A. Blackboard (`board.md` + `tasks.json`)
Shared state everyone reads; one writer.

**For:** dead simple; human-readable; survives restarts; no delivery
guarantees needed; excellent as the *plan of record*.
**Against:** polling only — nobody learns anything changed; no addressing
("who is this for?"); write contention if more than one scribe; unbounded
growth. **Cannot initiate work.**

**Verdict: keep, but only as the plan. It is not a transport.**

### B. Mailbox / message passing (current `inbox/outbox`)
Files addressed agent-to-agent, moved by a router.

**For:** durable (a message survives a crash); auditable — every message is a
file you can read; naturally asynchronous; agents stay decoupled.
**Against:** **delivery ≠ attention** — the exact failure here; 1.5s polling
burns wake-ups on an empty directory; no ack, no retry, no dead-letter; no
ordering guarantee; two agents editing one file still collide (this happened).

**Verdict: right shape, missing its other half.**

### C. Contract Net (built, unwired)
Broadcast a call-for-proposals, collect bids, award to the best.

**For:** genuinely good when *who should do this* is unclear; naturally load-
balances; bids can carry cost/capability/context-headroom.
**Against:** at least 3 round trips before any work starts; with 2–3 agents
the auction costs more tokens than it saves; needs a timeout policy for
non-responders; adds a whole state machine to debug.

**Verdict: over-engineered for a 3-agent floor. Keep the code, do not wire it
yet. It earns its place at ~10+ heterogeneous agents.**

### D. Event log + subscriptions (already exists here)
Agents react to appended events (`task.result`, `github.ci_failed`).

**For:** already built and tested — the triggers subsystem does exactly this;
one append fans out to many; complete audit trail for free; the office already
renders from it.
**Against:** needs loop-safety (this project already hit runaway triggers and
fixed them by provenance); "everyone sees everything" unless filtered.

**Verdict: this is the transport you already have and are not using for A2A.**

### E. Direct RPC (agent calls agent synchronously)
**For:** immediate, simple to reason about.
**Against:** couples lifetimes — the caller blocks on a process that may not
exist; no durability; a crash loses the request; deadlocks with two agents
waiting on each other. **Wrong for CLI agents that exit between turns.**

### F. Orchestrator / hub-and-spoke (the `god` pattern)
One planner decomposes and dispatches; workers never talk to each other.

**For:** one place holds the plan; no N² coordination; easy to reason about
and to debug; matches how the human already thinks about it.
**Against:** the orchestrator is a bottleneck and a single point of failure;
it burns the most context; workers idle waiting for dispatch.

**Verdict: correct for this project. Keep it — just make dispatch actually
arrive.**

---

## 4. The constraint that decides the design

**These agents are not services. They are CLI processes.**

`claude -p` and `opencode run` execute a turn and exit. They do not sit in a
loop polling a mailbox. Any design that assumes an always-on actor with an
inbox is modelling something this system does not have — which is precisely
why the file mailbox delivers into a void.

Two, and only two, ways a message can reach a CLI agent:

1. **Spawn it with the message as its prompt** — reliable, works with one-shot
   CLIs, costs a cold start.
2. **Inject into a live PTY** — cheaper and preserves context, but only when a
   session is already running. The plumbing exists (`proc.write` in
   `ptyGateway.ts`, `AgentHandle.answer()` in the runner) and is **not
   connected to the hive**.

Everything else is bookkeeping around those two.

---

## 5. Recommended system

**Keep the orchestrator. Keep the blackboard. Keep the mailbox as the durable
record. Replace polling-and-hoping with an explicit wake.**

### 5.1 Make dispatch actually deliver — the one change that matters

When the router moves a message into `inbox/`, it must then **wake the
recipient**:

- **If a PTY session is live for that agent** → inject a short notice:
  `"New hive message from <sender>: <subject>. Read your inbox now."`
  Cheap, keeps the agent's context.
- **If no session is live** → **spawn the agent** with the message body as its
  prompt. This is what "wakes their terminals to code" was always supposed to
  mean.
- **If the machine is offline** (D28) → leave it in the inbox and record
  `undeliverable`. Do not silently drop it; do not pretend it arrived.

Without this, everything else is decoration. **This is the whole fix.**

### 5.2 Acknowledge, retry, dead-letter

A message needs three states, not one: `pending → delivered → handled`.
`inbox/.done/` already implies the third but nothing enforces it. Add:

- an `ack` written when the agent moves it to `.done/`
- a redelivery if a message sits `delivered` and unhandled past a timeout
- a `dead-letter/` folder after N attempts, surfaced to the human

Today a message that is delivered but never read is indistinguishable from one
that was handled perfectly.

### 5.3 Stop the empty wake-ups

Poll every 1.5s to *route*, but only wake an agent when something actually
arrived for it. An agent that wakes to an empty inbox and asks "what would you
like me to do?" has spent real tokens to produce nothing — three times, in the
transcript.

### 5.4 Fix the roster

`fleet.json` must be generated from `registry.json` plus live process state,
not maintained separately. A monitoring file missing two of three workers is
worse than no monitoring file.

### 5.5 One writer per file, enforced

The collision in `board.md` ("two design systems collided") happened because
two agents edited the same files. The protocol says god is the sole scribe of
`board.md`; nothing enforces it. Either enforce it in the router (reject
outbox messages that claim to have written a god-owned file) or give each
agent its own section and merge.

### 5.6 Use the event log for fan-out, not the mailbox

For "CI went red, somebody look" you want one event and N reactions — the
triggers subsystem already does this correctly, including loop safety by
provenance. Use it. Reserve the mailbox for **addressed, durable, one-to-one**
requests.

### 5.7 Retire the third system

`contractNet.ts` is 390 lines that no agent path calls. Either wire it behind
the orchestrator's assignment decision (as a strategy it can choose when a
task's owner is genuinely unclear) or move it out of `communication/` and mark
it experimental. Three parallel mechanisms is how the fleet/registry drift
happened in the first place.

---

## 6. What I would build, in order

1. **Wake on delivery** (§5.1) — inject if live, spawn if not, undeliverable if
   offline. Nothing else works until this does.
2. **Ack + redelivery + dead-letter** (§5.2).
3. **Generate `fleet.json`** from the registry and live state (§5.4).
4. **Suppress empty wake-ups** (§5.3).
5. **Decide contract-net's fate** (§5.7) — wire it or shelve it.

Items 1–3 are the difference between a system that coordinates and a system
that only looks like it does.

## 7. What I would not build

- **A full FIPA ACL implementation.** The six speech acts in `PROTOCOL.md`
  (`request`/`inform`/`query`/`agree`/`refuse`/`done`) are already more than a
  3-agent floor uses. Adding conversation IDs and protocol state machines
  would add ceremony, not capability.
- **Agent-to-agent mesh.** Hub-and-spoke through the orchestrator is right at
  this size. A mesh multiplies the coordination surface for no gain until
  agents genuinely need to negotiate without a planner.
- **A message broker** (Redis/NATS/etc.). The durability requirement here is
  "survive a laptop sleeping", which files already satisfy. A broker adds an
  always-on dependency to a system whose whole premise is running on your own
  machine.
