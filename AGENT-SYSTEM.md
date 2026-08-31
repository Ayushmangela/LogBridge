# The agent system

**How agents are run, how they are reached, and how they talk to each other.**

This is the single reference for the agent side of LogBridge. It describes what
the code does today — every claim here was checked against the source, and
where something is unfinished it says so rather than describing the intent.

For the wire format see [CONTRACT.md](CONTRACT.md). For settled trade-offs and
what would reopen them see [DECISIONS.md](DECISIONS.md).

---

## 1. The constraint everything follows from

> **Agents are not services. They are one-shot CLI processes.**

`claude -p` and `opencode run` execute a turn and exit. Nothing sits in a loop
polling a mailbox. This single fact determines the whole design, and most
"obvious" multi-agent architectures are wrong here because they assume an
always-on actor with an inbox.

**There are exactly two ways a message can reach an agent:**

| Verb | When | Cost |
|---|---|---|
| **inject** | a PTY session is already live | cheap, preserves the agent's context |
| **spawn** | no live session — the message becomes the prompt | a cold start, 10–20s |

Everything else in this document is bookkeeping around those two verbs.

The corollary matters: **a message is not something an agent receives. A message
is a reason to run an agent.** A mailbox nobody is watching delivers into a
void — which is exactly what happened before the wake path existed. In a
recorded session all three agents woke, found empty inboxes, asked the human
what to do, and the orchestrator did the work itself, which its own protocol
forbids.

---

## 2. Where an agent physically runs

```
   MY LAPTOP              CENTRAL SERVER            FRIEND'S LAPTOP
   ═════════              ══════════════            ═══════════════
   agents execute    ←→   routes · coordinates ←→   agents execute
   my repos, my keys      remembers · syncs         their repos, their keys
                          NEVER EXECUTES
```

An agent runs **only** on its owner's machine, spawned by that machine's runner,
using that owner's own installed and authenticated CLI. The server never
executes anyone's work. The test for any new feature is: *does this make the
central server execute someone's work?* If yes, it doesn't go in.

The runner is the **only network peer** on each machine — agents reach the world
through it or not at all.

---

## 3. The three communication channels

There were three overlapping mechanisms, which is how `fleet.json` and
`registry.json` drifted apart. Today there are **two live channels plus one
deliberately shelved**:

| Channel | Transport | Carries | State |
|---|---|---|---|
| **Hive mailbox** | files — `outbox/` → `inbox/` | agent ↔ agent on the *same* machine, and the shared plan | live |
| **Sealed delegation** | WebSocket envelopes | agent → agent across *different* machines | live |
| ~~Contract Net~~ | HTTP only | CfP → bid → award | **shelved**, §7 |

### 3.1 Hive mailbox — addressed, durable, one-to-one

A file-backed mailbox under the project's hive directory. An agent writes JSON
into `outbox/`; a router tick (1.5s) moves it to the recipient's `inbox/`, then
**wakes** the recipient (§4). The agent moves the file to `inbox/.done/` when it
has handled it, which is the acknowledgement.

Files, not a broker, because the durability requirement here is *"survive a
laptop sleeping"* — which files already satisfy. A broker (Redis/NATS) would add
an always-on dependency to a system whose whole premise is running on your own
machine.

**One writer per file is enforced.** `GOD_OWNED_FILES` — `board.md`,
`tasks.json`, `registry.json`, `fleet.json` — may only be written by the
commander. This exists because two agents once edited `board.md` concurrently
and, in the transcript, "two design systems collided."

`fleet.json` is **derived**, not maintained: a direct projection of
`registry.json` plus live inbox metrics. A monitoring file missing two of three
workers is worse than no monitoring file.

### 3.2 Sealed delegation — cross-machine, and the server cannot read it

Machine A hands work to machine B *through* the server, and the server — which
routes it, logs it, and draws the office from it — **cannot read what was
sent**.

```
ephemeral X25519 keypair (fresh per message)
  -> ECDH against the recipient's long-term X25519 public key
  -> HKDF-SHA256(shared, salt = epk‖recipientPk, info = "logbridge-sealed-v1")
  -> AES-256-GCM(key, random 96-bit nonce, aad = envelope metadata)
```

HPKE base mode using only Node's built-in crypto. Routing metadata stays
plaintext because the server needs it to route; findings, criteria and context
bodies are content and are sealed.

`apps/runner/src/sealedDelegation.test.ts` asserts the claim the only way that
means anything: it dumps every table in the server's database and greps for the
plaintext.

**Consent is per-machine.** `acceptDelegations` defaults to **off** — a machine
refuses delegated work until its owner opts in. No agent gets automatic access
to anyone else's computer.

### 3.3 Event log — fan-out

For *"CI went red, somebody look"* you want one event and N reactions. That is
the triggers subsystem, which already handles loop safety by provenance. The
mailbox is reserved for **addressed, durable, one-to-one** requests; the event
log is for **broadcast**. Using the mailbox for fan-out is how you get N copies
of a message and N cold starts.

---

## 4. The wake rule

This is the piece that makes the mailbox real rather than decorative.

When the router moves a message into an `inbox/`, it must then **wake the
recipient**:

```
  PTY session live?  ──yes──▶  inject a short notice into the running session
         │                     (cheap; the agent keeps its context)
         no
         ▼
  machine online?    ──yes──▶  spawn the agent, message becomes the prompt
         │                     (cold start)
         no
         ▼
  leave it in the inbox, record `undeliverable`
  (do not silently drop it; do not pretend it arrived)
```

**Dedup is two-layer**: an in-memory cache first, so the 1.5s router tick does
not hit the database every pass, then a durable table that survives a restart.
Exactly one wake happens, exactly once.

**Empty wake-ups are suppressed.** The router polls every 1.5s to *route*, but
only wakes an agent when something actually arrived for it. An agent that wakes
to an empty inbox and asks "what would you like me to do?" has spent real tokens
to produce nothing.

### Delivery states

A message needs three states, not one:

| State | Meaning |
|---|---|
| `delivered` | `wakeRecipient()` succeeded |
| `handled` | the agent moved the file into `inbox/.done/` |
| `dead` | redelivered N times without being handled; moved to `dead-letter/` and surfaced to the human |

Redelivery uses backoff. A message whose agent crashed is retried from attempt
0. `delivered_at` is recorded explicitly rather than inferred from a folder,
because a folder — or a restore — will lie to you.

Before this existed, *a message that was delivered but never read was
indistinguishable from one handled perfectly.*

---

## 5. How work gets assigned

`orchestrator.ts` → `evaluateAgentCandidates()`. Deterministic, instant, free,
and explainable. Every candidate is scored:

| Signal | Weight |
|---|---|
| capability match | 40 (30 if the task requires none) |
| machine online | 20 |
| historical success rate | up to 20 |
| current load vs its concurrency | penalty, scaled |
| already failed an attempt at *this* task | −15 |

Ineligible agents are disqualified with a stated reason — *"Machine offline"*,
*"At max concurrency limit (2/2)"*, *"Missing required capability: run_tests"* —
and the whole scoring breakdown is emitted as a `task.routing_evaluated` event,
so a routing decision can always be explained after the fact.

Unassigned work is routed oldest-first, and **queued rather than failed** when
nothing is eligible.

---

## 6. The agent lifecycle

```
create ──▶ starting ──▶ idle ⇄ working ──▶ completed / failed
                          │       │
                          │       ├──▶ needs_input   (blocked on a human)
                          │       ├──▶ blocked       (CI, a build, another agent)
                          │       └──▶ reviewing
                          └──▶ paused / retired / deleted
```

**`starting` is not cosmetic.** A cold CLI takes 10–20s to boot, and through
that whole window an agent used to report `idle` — the same value a *ready*
agent reports. So a booting agent was indistinguishable from one ignoring you.

Two invariants hold it honest:

- It only ever moves `idle ↔ starting`. A real status the runner owns is never
  clobbered — including when an agent takes a task *mid-boot*.
- A booting agent cannot survive a restart (its PTY was a child of the server
  process), so `recoverServerState()` releases anything still `starting` at
  boot. Without that, the state is persisted in the database while the only
  things that clear it live in memory — and a restart stranded the agent
  forever.

Other lifecycle facts:

- **Budget caps are enforced before the first real run**, not after the bill —
  a hard wall-clock kill in the runner.
- **Leases** are a 60s claim renewed by heartbeat. Expiry means the machine went
  away, and the task is recovered rather than lost.
- **Tool policy** for `claude` is a project-scoped settings file written fresh
  immediately before every spawn, from the *current* policy — never trusted to
  already be correct on disk from a previous run.

---

## 7. Contract Net — built, tested, deliberately not wired

`experimental/contractNet.ts`, ~450 lines with passing tests, reachable only by
hand over HTTP. **No agent path calls it.** Full reasoning in
[`apps/server/src/experimental/README.md`](apps/server/src/experimental/README.md);
the short version:

A real auction would mean waking **every** candidate with the CfP (a cold start
each), parsing structured bids, waiting out a deadline, awarding, then waking
the winner **again** with the actual task. That is *N+1 cold starts and two
round-trips of billed tokens* per assignment.

And it would decide **worse**. For a bid to beat the scoring in §5, an agent
would need information the server lacks — but a one-shot CLI has no memory of
the task before it is spawned, so its bid can only restate capability and
availability, which the server already has and has more reliably.

It was moved out of `communication/` because a fully-formed, well-tested,
*unreachable* third path looked wired. `selectAssignmentStrategy()` in
particular returned a `"CONTRACT_NET"` decision that **nothing consumed** — a
seam that appeared load-bearing and was not.

**What would reopen it:** agents becoming long-lived (the cost argument
collapses), or agents gaining private information the server cannot see (a warm
index, local cache state, measured latency), or the floor growing past the point
where one orchestrator's view is trustworthy — hub-and-spoke is right at 3–6
agents, not 60.

---

## 8. What is deliberately *not* built

| | Why not |
|---|---|
| **Full FIPA ACL** | the six speech acts already exceed what a 3-agent floor uses. Conversation IDs and protocol state machines add ceremony, not capability |
| **Agent-to-agent mesh** | hub-and-spoke through the orchestrator is right at this size. A mesh multiplies the coordination surface for no gain until agents genuinely negotiate without a planner |
| **A message broker** | the durability requirement is "survive a laptop sleeping", which files satisfy. A broker adds an always-on dependency to a system whose premise is your own machine |
| **A progress percentage** | permanently impossible — no CLI reports how many steps remain. Step *counts* are real; a bar would invent its denominator |

---

## 9. What is actually remaining

### Needs a decision, not code

**Authorization.** There is authentication but no scoping. `buildView()` takes
`meId` and uses it only for avatar placement:

```ts
const projects = db.prepare("SELECT * FROM projects ORDER BY id").all();
```

Every signed-in user receives every project, agent, task and memory, and signup
auto-joins every existing project. For a private tailnet that is defensible —
but it has to be a **decision**, documented as a trusted-team workspace or
replaced with real per-project membership filtering.

### Needs code

| Gap | Detail |
|---|---|
| **Enrolment (D23)** | machine registration is trust-on-first-sight — an unknown machine is registered the first time it signs a challenge. Impersonating a *known* machine is rejected; only first contact is unauthenticated. This gates ever running outside a private tailnet |
| **Six unverified providers** | `codex` · `gemini` · `qwen` · `crush` · `copilot` · `grok` · `kimi` run through the plain-text reader. A new provider ships `verified: false` until someone captures its real output — writing a parser from documentation produced three wrong guesses for `opencode`, including a run that wrote a file and reported zero tool calls |
| **Per-request delegation consent** | `delegate.decision` (approve/deny/always/never) is speced in the protocol and not built. Consent today is the coarser per-machine `acceptDelegations` |
| **WebRTC voice** | ~674 lines, zero tests, the only feature touching the microphone. Not broken, not verified |

### Blocked on something we do not have

| Gap | Blocked on |
|---|---|
| Semantic memory recall | an embedding model. Today it is SQLite FTS5/BM25 and the UI says so. A memory saying "use pnpm" will not surface for "package manager" |
| `opencode` tool policy | no per-run mechanism upstream. The harness refuses to run restricted rather than pretending |
| Forward secrecy | a double ratchet. This is a sealed box, not a ratchet |
| Exact push boundaries | polling sees commits, not pushes. Grouping is inferred in a 10-minute window and labelled as an approximation |

### Not features — untested claims

No amount of code closes these:

- [ ] the server runs unattended for a week
- [ ] both machines reconnect cleanly after real laptop sleep *(the Wi-Fi drop is tested; sleep is not)*
- [ ] **a stranger watches the office for 60 seconds and correctly says what the team is doing**

---

## 10. How to improve the structure — in order

The ordering is deliberate: each item is worth more than everything below it.

1. **Decide authorization.** It is one decision. Either write down that this is
   a trusted-team workspace and make the docs match, or filter `buildView()` by
   `project_members` and make signup stop auto-joining. Right now the code and
   the docs imply different things, which is the worst of both.

2. **Enrolment codes (D23).** Everything else about running this outside a
   tailnet is downstream of it. It is a browser flow, a code-issuing endpoint,
   and expiry — real work, but bounded and well understood.

3. **Verify one more provider properly.** Not six. Pick the one you actually
   use, capture its real output, write the parser against the capture, and mark
   it `verified`. The value is the *method* — six unverified providers is a
   smaller problem than one provider verified by guessing.

4. **Per-request delegation consent.** The per-machine flag is the blunt
   version. The protocol already speaks the finer one.

5. **Decide WebRTC's fate.** Test it or remove it. A microphone feature with
   zero tests is a liability either way, and "it might be useful later" is not a
   reason to keep an untested audio mesh in a product about watching agents work.

**And a standing rule, from how the drift happened in the first place:** when a
mechanism is built but nothing calls it, either wire it or shelve it explicitly.
A well-tested unreachable path is worse than no path, because it looks like
infrastructure. That is what §7 is about, and it is the failure mode this
system has demonstrably had twice.
