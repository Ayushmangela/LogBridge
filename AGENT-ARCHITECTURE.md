# Agent communication — analysis and target architecture

Evidence in `research/` (six papers, downloaded). Diagnosis checked against
this codebase, not against the prompts that describe it.

---

## Part 1 — Diagnosis

### 1.1 The proximate cause

The commander's prompt promises that dispatch *"delivers these to recipient
inboxes and wakes their terminals to code."* In `apps/server/src/hive.ts`:

```
wake 0 · notify 0 · nudge 0 · inject 0 · sendToPty 0   (844 lines)
```

`startRouter(1500)` moves JSON from `outbox/` to `inbox/`. `hive.ts` itself
has no wake verb — but **`index.ts` does**: its `onMessage` callback called
`submitPromptToAgent(toId, wakeText)`.

**Correction to an earlier draft of this document**, which said there was no
wake path at all. That was too strong. The path existed and was *inject-only*:
its boolean return was discarded inside a bare `catch {}`, so when no PTY
session was live it silently did nothing, with no spawn fallback and no record
that delivery had failed. Narrower than "missing", and worse — a failure that
reports success. `ptyGateway.ts` imports `HiveManager` and injects a hive prompt at
*spawn* time, but never reads an inbox to push into a live session.

Observable result, from the transcript: three agents woke, found empty
inboxes, and asked the human what to do. `board.md` recorded the consequence
without naming the cause — *"the delegation harness was NOT live … executed by
spawned workers and by god directly."* The orchestrator did the work itself,
which its own protocol forbids, because dispatch is a no-op.

### 1.2 Mapped onto the MAST taxonomy

MAST (arXiv:2503.13657, 1,600+ traces across 7 frameworks) sorts failures into
**foundation-model**, **system-design**, and **agent-interaction**. Ours:

| Observed | MAST category | Mode |
|---|---|---|
| Dispatch delivers, nobody wakes | Agent interaction | Communication breakdown |
| God performs work it must delegate | System design | Inadequate planning / role violation |
| Two agents edit the same files, styles collide | Agent interaction | Coordination failure |
| `fleet.json` missing two of three workers | System design | Weak monitoring |
| Agent wakes to empty inbox, asks human, exits | System design | Unaware of stopping conditions |
| No ack — "delivered" and "handled" indistinguishable | System design | Weak monitoring / error recovery |

**Not one of these is a model failure.** That is the useful result: every
failure here is architectural, and architecture is fixable. MAST's own
conclusion is the same — better prompts do not repair a system whose
coordination layer is missing.

### 1.3 The structural problem underneath

Three overlapping mechanisms, none complete:

| Mechanism | Location | State |
|---|---|---|
| Sealed delegation over WebSocket | `nodeGateway/delegation.ts` | Works, tested, sealed (D26) |
| File hive inbox/outbox + 1.5s poller | `hive.ts` | Running, no wake path |
| Contract Net (CfP → bid → award) | `communication/contractNet.ts` | 390 lines, reachable only by HTTP route; **no agent path calls it** |

Three systems is how `fleet.json` and `registry.json` drifted apart. Any design
that does not collapse them will drift again.

### 1.4 The constraint that determines the design

**These agents are not services. They are CLI processes.** `claude -p` and
`opencode run` execute a turn and exit. Nothing sits in a loop polling a
mailbox.

Any design assuming an always-on actor with an inbox is modelling something
this system does not have — which is precisely why the mailbox delivers into a
void. There are exactly two ways a message reaches a CLI agent:

1. **Spawn it with the message as its prompt** — works with one-shot CLIs,
   costs a cold start.
2. **Inject into a live PTY** — cheap, preserves context, only possible while a
   session exists.

Both already exist here (`proc.write` in `ptyGateway.ts`,
`AgentHandle.answer()` in the runner). Neither is connected to the hive.
Everything else is bookkeeping around those two verbs.

---

## Part 2 — What the research says

### 2.1 The protocol landscape (arXiv:2505.02279)

| Protocol | For | Transport |
|---|---|---|
| **MCP** | Tool access | JSON-RPC client/server |
| **ACP** | General agent messaging, sessions, discovery | REST + MIME multipart |
| **A2A** | Peer-to-peer task delegation, capability "Agent Cards" | Enterprise workflows |
| **ANP** | Open-network discovery, marketplaces | W3C DIDs + JSON-LD |

The survey's roadmap is **MCP → ACP → A2A → ANP**, adopted as scale demands.

**Applied here:** we are at the ACP rung — structured, session-aware messaging
between a handful of known agents. **A2A's capability cards and ANP's
decentralised identity solve problems this system does not have** (discovering
unknown agents across organisational boundaries). Adopting them now would add
ceremony without capability. Notably, LogBridge's `agent.card` already carries
capabilities — the A2A idea is present in embryo, and that is the right amount
of it for three agents.

### 2.2 The four open challenges (arXiv:2502.14321)

Efficiency, security, benchmarking, scalability. Two bite immediately:

- **Efficiency** — polling every 1.5s and waking agents that have no work is
  pure token burn. Three empty wake-ups in one transcript.
- **Security** — the transport now carries sessions and sealed payloads
  (arXiv:2506.19676 covers the threat surface). Waking an agent is *causing
  code execution*, so the wake path needs the same authorisation as spawning.

**Benchmarking is the one we cannot skip forever.** MAST exists because MAS
performance gains are often minimal and unmeasured. We have no measure of
whether the hive beats a single agent. That should be an explicit later task,
not an assumption.

---

## Part 3 — Target architecture

### 3.1 Principles

1. **One transport.** Collapse three mechanisms into one. Drift comes from
   plurality.
2. **Delivery is not attention.** A message is not delivered until the
   recipient has been made to look at it.
3. **Model agents as workers, not actors.** A message is a *reason to run*, not
   something an idle process receives.
4. **Every message has a terminal state.** `pending → delivered → handled` or
   `dead`. No message may sit in an unknowable state.
5. **The blackboard is the plan, never the transport.**
6. **Waking is execution.** Authorise it like spawning, because it is.

### 3.2 Layers

```
L4  Governance   budgets, circuit breaker, one-writer rules, audit
L3  Knowledge    board.md (plan) · tasks.json (kanban) · memory.md (per agent)
L2  Coordination orchestrator assigns; contract-net only when the owner is unclear
L1  Delivery     ack · retry · dead-letter · undeliverable-when-offline
L0  Transport    mailbox files + WAKE (inject if live, spawn if not)
```

The existing system has L3 and half of L0. **L1 is entirely absent, and that
is the gap that makes everything above it unreliable.**

### 3.3 Message lifecycle

```
        write to outbox
              │
              ▼
   ┌──────► pending ──────────────┐
   │          │ router moves file │ machine offline (D28)
   │          ▼                   ▼
   │      delivered ────────► undeliverable
   │          │  wake: inject | spawn
   │          ▼
   │       handled  (agent moves file to inbox/.done/ and writes an ack)
   │          │
   └── timeout, attempts < N              attempts = N
                                              │
                                              ▼
                                          dead-letter → surfaced to human
```

The single most important arrow is `delivered → handled`. Today it does not
exist, so a message that is never read looks identical to one handled
perfectly.

### 3.4 The wake rule

On delivery, the router resolves the recipient's state:

| Recipient state | Action |
|---|---|
| Live PTY session | Inject: *"New hive message from `<sender>`: `<subject>`. Read your inbox now."* Cheap; preserves context |
| No session, machine online | **Spawn** the agent with the message body as its prompt |
| Machine offline | Leave `pending`, record `undeliverable` (D28). Never silently drop, never pretend |

Spawn-on-message is what "wakes their terminals to code" was always meant to
be.

### 3.5 Suppressing empty wake-ups

Wake **only** when something is genuinely addressed to that agent. An agent
that wakes, finds nothing, asks the human, and exits has spent real tokens to
produce nothing. The router already knows whether it moved a file — that is
the signal.

### 3.6 Deriving the roster

`fleet.json` becomes a **projection** of `registry.json` plus live process
state, regenerated, never hand-maintained. A monitoring file missing two of
three workers is worse than none, because it is trusted.

### 3.7 One writer per file

`board.md` says god is sole scribe; nothing enforces it, and two agents
collided. Enforce at the router: a message asserting a write to a
god-owned path is refused with a reason. Cheap, and it removes an entire
failure mode.

### 3.8 Fan-out belongs to the event log

"CI went red, somebody look" is one event and N reactions. The triggers
subsystem already does this, with loop-safety by provenance that this project
had to learn the hard way. Use it for broadcast. **Reserve the mailbox for
addressed, durable, one-to-one requests.**

---

## Part 4 — Rejected, with reasons

| Rejected | Why |
|---|---|
| **Full FIPA ACL** | The six speech acts already exceed what three agents use. Conversation IDs and protocol state machines are ceremony here |
| **Agent mesh (all-to-all)** | Hub-and-spoke is correct at this size. A mesh multiplies coordination surface for no gain until agents must negotiate without a planner |
| **Message broker (Redis/NATS)** | The durability requirement is "survive a laptop sleeping" — files satisfy it. A broker adds an always-on dependency to a system whose premise is running on your own machine |
| **ANP / decentralised identity** | Solves cross-organisational discovery. We have three known agents in one directory |
| **Contract Net, wired now** | Three round trips before work starts. At three agents the auction costs more than it saves. Keep the code; it earns its place around ten heterogeneous agents |

---

## Part 5 — Implementation order

1. **Wake on delivery** (§3.4) — inject / spawn / undeliverable. *Nothing above
   this works until it does.*
2. **Ack, retry, dead-letter** (§3.3) — give every message a terminal state.
3. **Derive `fleet.json`** (§3.6).
4. **Suppress empty wakes** (§3.5).
5. **Enforce one-writer** (§3.7).
6. **Decide contract-net** — wire behind the orchestrator's assignment strategy,
   or move it out of `communication/` and mark experimental.
7. **Measure** — does the hive beat one agent on the same task? MAST exists
   because that gain is usually assumed and rarely demonstrated.

Steps 1–3 are the difference between a system that coordinates and one that
only appears to.

---

## References

All PDFs in `research/papers/`.

- Cemri, Pan, Yang et al. — *Why Do Multi-Agent LLM Systems Fail?* arXiv:2503.13657
- *A Survey of Agent Interoperability Protocols (MCP, ACP, A2A, ANP)* arXiv:2505.02279
- *Beyond Self-Talk: A Communication-Centric Survey of LLM-Based MAS* arXiv:2502.14321
- *A Survey of LLM-Driven AI Agent Communication: Protocols, Security Risks, Defences* arXiv:2506.19676
- *Survey of LLM Agent Communication with MCP: Design-Pattern Centric Review* arXiv:2506.05364
- *A Technical Taxonomy of LLM Agent Communication Protocols* arXiv:2606.19135
