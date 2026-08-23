# Shared Virtual Workspace for Humans and Local AI Agents
### Final architecture and implementation plan — v3

> **The locked concept.** People own and run their AI agents locally, while a shared central server allows humans and AI agents to discover each other, communicate, collaborate, coordinate tasks, and exist together in one shared virtual workspace.
>
> **LOCAL MACHINES = AI EXECUTION AND WORK · CENTRAL SERVER = COMMUNICATION, COORDINATION, AND SHARED STATE**

Scope: 3–4 friends, private, non-commercial, built to learn. Copy anything worth copying.

---

## 0. Requirements compliance audit

Every fixed requirement, checked against this plan.

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Shared virtual workspace/office for humans **and** AI agents | ✅ | §3, §13 — the office is in the MVP, not deferred |
| 2 | Multiple humans join, communicate, collaborate | ✅ | §8 — presence, rooms, text chat, shared task board |
| 3 | Each human can have **one or multiple** AI agents | ✅ **corrected** | §15 — multiple agents per human, concurrent, per-project |
| 4 | Agents are real working agents, not avatars or chatbots | ✅ | §7 — real processes, real repos, real tools, runner-verified status |
| 5 | Humans communicate with agents **naturally** and assign tasks | ✅ **corrected** | §9 — natural-language chat is the primary interface. v2 got this wrong |
| 6 | Agents communicate and collaborate with agents owned by **other people** | ✅ **corrected** | §10 — core MVP feature. v2 wrongly deferred it |
| 7 | **Agents MUST run locally on their owner's machine** | ✅ | §5, §7 — the architectural spine. Never compromised |
| 8 | **Central server MUST NOT run everyone's agents** | ✅ | §6 — the server has no execution path at all; the "never" list is a contract |
| 9 | Cross-person AI help routes through the central server | ✅ | §10, §16 — every cross-machine byte transits the server |
| 10 | No automatic unrestricted access to another person's machine | ✅ | §7, §17 — the runner/agent split plus local policy file is precisely this |
| 11 | Human↔Human, Human↔AI, AI↔AI all supported | ✅ | §8, §9, §10 — all three first-class |
| 12 | Agents: share context (when permitted), delegate, request reviews, return results, ask humans | ✅ **corrected** | §10, §11 — added explicit `context.share` and `review.request`. v2 was missing both |
| 13 | GitHub: repos, issues, PRs, **commits**, collaborators, project activity | ✅ **corrected** | §12 — commits now included (aggregated). v2 wrongly excluded them |
| 14 | Workspace represents **real** activity and state | ✅ | §13 — "position is a pure function of state"; no code path produces motion without an event |
| 15 | Visual workspace useful, not decorative | ✅ | §13 — one view model, two renderers; every element click-throughs to the real record |
| 16 | Dedicated server laptop; keeps running when your machine is off | ✅ | §19 — hosts the whole workspace infrastructure |
| 17 | Combines virtual office + Munder Difflin + October + multi-agent + GitHub | ✅ | §25 — explicit shopping list from each |

**Result: all 17 satisfied. Six required correcting from v2 — listed next, with what was wrong.**

---

## 1. Corrections made to v2

I'm naming these rather than silently patching, because two of them were real design mistakes on my part, not just scope calls.

### C1 — Natural language with agents *(req 5)* — **was contradicted**
v2 said *"A form, not a chat box."* That directly contradicts "communicate with AI agents naturally." The reasoning behind it (under-specified tasks are the top cause of multi-agent failure) was sound, but the fix was wrong.

**Corrected:** natural-language chat is the primary way to reach an agent. The agent **converts your message into a structured task spec and shows it back for confirmation.** Natural in, structured contract out — you get both, and the specification discipline moves from the human to the agent, where it belongs.

### C2 — AI-to-AI collaboration *(reqs 6, 9, 12)* — **was contradicted**
v2 pushed cross-machine delegation to phase 3 and called it *"probably a party trick."* That's a fixed core requirement, and demoting it was wrong.

**Corrected:** AI↔AI collaboration is a **headline MVP capability**, in from Phase 2, with four distinct interaction types (delegate, request review, share context, ask human) rather than one. The engineering guardrails stay — typed contracts, depth limits, mandatory verification — because those make it *work*, not because they make it optional.

### C3 — Context sharing and review requests *(req 12)* — **was missing**
v2's delegation envelope had no way to share context and no review flow. Req 12 names both.

**Corrected:** two new first-class message types — `context.share` (permissioned, explicitly framed as data) and `review.request` (a distinct flow with its own state machine, because review is a different shape from delegation: it returns a judgement, not an artifact).

### C4 — The office ships in the MVP *(reqs 1, 14, 15)* — **was contradicted in spirit**
v2 put the spatial floor in Phase 4, "after everything works." But the shared virtual office **is** the product per req 1. Deferring it made this a task queue that eventually grows a UI.

**Corrected:** the office is in the MVP, built in Phase 3 of 4, over the state-derived view model. The engineering point that produced the v2 ordering survives intact — *build the truth first, then render it* — but "first" now means three weeks, not "someday."

### C5 — Commits *(req 13)* — **was contradicted**
v2 said commits were "high volume, low meaning — No." Req 13 names them explicitly.

**Corrected:** commits are ingested and shown, **aggregated** — "dev-a pushed 4 commits to `feat/auth`" rather than four separate events. Requirement satisfied, noise avoided.

### C6 — Multiple agents per human *(req 3)* — **was under-specified**
v2 defaulted to one agent, `concurrency: 1`.

**Corrected:** a human declares as many agents as they like across as many machines as they like; they run concurrently, each with its own card, capabilities and budget. §15.

### Terminology
v2 said "hub." This plan says **central server** to match your language. Where you see "hub" in a diagram, it is the central server.

### What did *not* change, and shouldn't
Local-only execution · the server having no execution path · server-mediated AI↔AI routing · the runner/agent split · leases, heartbeats, reconnect-with-resume, idempotency · hard budget caps · position-as-a-function-of-state. Those all *serve* your requirements — 7, 8, 9, 10, 14 respectively — rather than competing with them.

---

## 2. Executive summary

Feasible. The core principle — execution local, coordination central — is right, and every architectural decision below is downstream of it.

The system is five things:

1. **A central server** on your spare laptop: one Node process, one SQLite file, always on. It routes, coordinates, remembers, and synchronises. It cannot execute anything.
2. **A node runner** on each person's machine: a small daemon holding one outbound connection to the server, enforcing that machine's policy, and spawning agents.
3. **Real local agents** — actual agent processes doing actual work in actual repositories on their owner's hardware.
4. **The shared workspace** — one browser page showing every human, every agent, every machine and every task, in rooms, with the office view and the board view over identical data.
5. **GitHub** as the project spine — repos define rooms, collaborators define membership, issues become tasks, PRs and commits become activity.

Five things to hold onto while building:

- **The server's "never" list is the architecture.** No LLM calls, no code execution, no secrets, no source. The moment one bends, you have built the cloud AI platform this design exists to avoid.
- **The runner is what makes requirement 10 true.** It is the only network peer on each machine, and the only policy enforcement point. Merging it into the agent puts your network-facing surface inside the thing that executes model output.
- **Natural language in, typed contracts on the wire.** Humans and agents talk naturally. What crosses machine boundaries is always a validated, typed envelope. Both halves matter.
- **Nothing renders that no event caused.** This is how "the workspace shows real state" becomes structurally guaranteed rather than a promise you try to keep.
- **Leases and budget caps are not enterprise features.** They are what makes the thing survive a closed laptop lid and a looping agent at 3am.

**Timeline:** ~6 weeks of evenings to the full MVP including AI↔AI and the office. **Build first:** the two-week vertical slice in §26.

---

## 3. The concept, locked

```
   MY MACHINE                 CENTRAL SERVER              FRIEND'S MACHINE
   ══════════                 ══════════════              ════════════════
   my agents run here    ←→   routes, coordinates,   ←→   their agents run here
   my repos                    remembers, syncs            their repos
   my keys                     knows who's online          their keys
   my tools                    knows who can do what       their tools
   my policy                   never executes              their policy

   AI EXECUTION + WORK        COMMUNICATION,               AI EXECUTION + WORK
                              COORDINATION,
                              SHARED STATE
```

**The one-line test for any future feature:** *does this make the central server execute someone's work?* If yes, it doesn't go in. Everything else is negotiable.

---

## 4. Participants

Five, not four. The one commonly left out is the one that makes requirement 10 enforceable.

### Human
- **Identity:** GitHub OAuth. No password system — GitHub already knows who they are and which repos they can see.
- **Owns:** their machines and their agents. Nothing else.
- **Can:** talk to anyone, talk to any agent they have access to, create tasks, approve/reject/answer agent requests, stop any task in the workspace, move around the office.
- **Cannot:** execute on a machine they don't own. No admin override exists, including for you.

### Machine (node)
- Keypair generated at enrollment; **private key never leaves the disk**.
- Exactly one owner.
- One outbound WebSocket to the central server. Persistent, resumable.
- State: `online` / `offline` / `draining`, plus `last_seen` and an event cursor.

### Node runner — **the daemon that makes requirement 10 true**
- Holds the server connection, the node key, the local policy file, the task queue, lease timers, local audit log.
- Exposes a **localhost-only MCP server** to agent processes, so agents get `list_peers`, `delegate_task`, `request_review`, `share_context`, `ask_human`, `report_status` as ordinary tool calls — and never touch a socket.
- Is the single policy enforcement point on that machine.

> Merging the runner into the agent puts the network-facing surface inside the thing running LLM output. That is the difference between "a confused agent wasted an hour" and "a confused agent pushed to main and posted my `.env` into a room."

### Local AI agent
- A **real** agent process — Claude Agent SDK, a coding CLI in headless mode. Spawned per task, scoped to one working directory, one budget.
- **Agent card:** `id, name, owner, node, role, capabilities[], harness, projects[], concurrency, status`.
- **Status:** `idle · working · waiting · blocked · needs_input · reviewing · completed · failed` — exactly the vocabulary from requirement 14.
- **A human may own many.** §15.

### Central server
- Directory, router, durable log, projection source, workspace host.
- Holds **no** source, **no** secrets, **no** model keys, **no** artifacts, and has **no execution path**.

### GitHub project
- Source of truth for repos, collaborators, issues, PRs, commits. The server mirrors read-only; local agents write using their own human's credentials.

---

## 5. Complete system architecture

```
  ═══════════ EXECUTION PLANE — each person's own machine ═══════════

    MY LAPTOP                SAM'S LAPTOP              PRIYA'S LAPTOP
  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
  │ node runner  │         │ node runner  │         │ node runner  │
  │  ├ policy    │         │  ├ policy    │         │  ├ policy    │
  │  ├ task queue│         │  ├ task queue│         │  ├ task queue│
  │  ├ MCP :local│         │  ├ MCP :local│         │  ├ MCP :local│
  │  ├ artifacts │         │  ├ artifacts │         │  ├ artifacts │
  │  └ audit log │         │  └ audit log │         │  └ audit log │
  │       ↕      │         │       ↕      │         │       ↕      │
  │ ▸ dev agent  │         │ ▸ qa agent   │         │ ▸ research   │
  │ ▸ doc agent  │         │ ▸ review ag. │         │              │
  │   real repos │         │   real repos │         │   real repos │
  │   own API key│         │   own API key│         │   own API key│
  │   own shell  │         │   own shell  │         │   own shell  │
  └──────┬───────┘         └──────┬───────┘         └──────┬───────┘
         │                        │                        │
         │        outbound WSS (Tailscale). No inbound.     │
         └────────────────────────┼────────────────────────┘
                                  ▼
  ═════════════ CONTROL PLANE — the dedicated server laptop ═════════════
              ┌──────────────────────────────────────────┐
              │  CENTRAL SERVER — one Node process         │
              │                                            │
              │  ws gateway       agent discovery           │
              │  message router   presence                  │
              │  task router      shared workspace state     │
              │  event log        real-time sync             │
              │  auth + perms     project/task metadata      │
              │  github mirror    workspace UI (served)      │
              │                                            │
              │  SQLite (WAL)   ·   NO EXECUTION PATH       │
              └────────┬─────────────────────┬─────────────┘
                       │                     │
              browsers │                     │ read-only, polled
                       ▼                     ▼
            ┌────────────────────┐    ┌──────────────┐
            │  SHARED WORKSPACE  │    │    GitHub    │
            │  office + board    │    │  repos·issues│
            │  rooms · chat      │    │  PRs·commits │
            │  presence · tasks  │    │ collaborators│
            └────────────────────┘    └──────────────┘

   Everything above lives inside one Tailscale network. Nothing is public.
```

### The five invariants

1. **Every AI process runs on its owner's machine.** No exceptions, no "just this once," no fallback path.
2. **The central server has no execution path.** Not disabled — absent. There is no code in it that spawns a process or calls a model.
3. **All node connections are outbound.** No node ever listens. Works from any café, behind any NAT.
4. **Bytes stay local; references travel.** Artifacts are hashed on the node; the server sees hash, size, type, summary.
5. **The workspace derives, never decides.** It is a projection over the event log. Turning it off changes no behaviour.

> **Why route AI↔AI through the server at all, rather than machine-to-machine?**
> Because laptops sleep. Direct peer messaging means a message to a sleeping machine is simply lost, with no ordered history to render the workspace from. Server-mediation gives you one place where every cross-machine byte is authenticated, ordered, permission-checked, logged and observable — which is exactly what requirements 8, 9 and 14 ask for.

---

## 6. Central server responsibilities

Mapped directly to requirement 8's list.

| Responsibility (req 8) | How |
|---|---|
| **Communication** | WebSocket gateway; one connection per node, one per browser |
| **Message routing** | Envelope router with per-project ordering and offline buffering |
| **Task routing** | Task store + offer/accept protocol + capability matching |
| **Agent discovery** | Directory query: "which agents can do X, in project P, right now" — filtered by asker's visibility |
| **Agent presence** | Heartbeat-driven; human, machine **and** agent presence tracked separately |
| **Shared workspace state** | Rooms, zones, occupancy, chat — all projections of the event log |
| **Coordination** | Leases, heartbeats, dependency tracking, escalation timers |
| **Authentication** | GitHub OAuth (humans) + Ed25519 signed challenge (machines) |
| **Permissions** | Project membership, capability grants, delegation consent |
| **Project/task metadata** | Tasks, specs, acceptance criteria, history, links to GitHub items |
| **Real-time synchronization** | Snapshot-then-delta over the same socket; `seq` cursor for resume |
| **GitHub/project integration** | Read-only polled mirror of repos, issues, PRs, commits, collaborators |

### The "never" list — write it into the README

- **Never runs an LLM call.** No model keys exist on this machine.
- **Never executes user or agent code.** No sandboxes, no containers, no builds, not once.
- **Never stores source, secrets, or full transcripts.** Descriptors and summaries only.
- **Never holds write credentials to anyone's GitHub.**
- **Never pushes execution.** It *offers*; runners *pull* and may refuse.

This list is requirement 8. Guard it like a type signature.

---

## 7. Local machine responsibilities

The split between runner and agent is the security architecture, and it's what makes requirement 10 enforceable rather than aspirational.

| Concern | Node runner *(trusted)* | Agent process *(untrusted)* |
|---|---|---|
| Server connection | Owns it — sole network peer | No network access to the server |
| Node private key | Holds it | Never sees it |
| Policy decisions | Makes all of them | Subject to them |
| Spawning | Spawns per task, scoped cwd + env | Runs the loop |
| Reasoning / tool use | None | All of it |
| Secrets | Injects only what task scope permits | Sees only the injected subset |
| Delegation / review / context | Validates, enforces depth + budget + consent, forwards | Requests via localhost MCP call |
| Status | Emits authoritative status from **observed process state** | May annotate; cannot fake |
| Artifacts | Hashes, stores, publishes descriptor | Writes files into the task's artifact dir |
| Audit log | Writes locally, append-only | Cannot write to it |

> **Status is observed, not self-reported.** An agent claiming `working` while its process is wedged is exactly the fake activity requirement 14 forbids. `working` means *the process is alive and the lease is fresh*. Ground every state in something the runner can independently verify.

### The local policy file

Plain, human-editable, on the machine, never synced. Any friend should be able to answer *"what can this network make my laptop do?"* by reading one file.

```yaml
node: ayush-mbp

agents:                                  # req 3 — as many as you like
  - name: dev-api
    role: developer
    project: acme/api
    capabilities: [implement_feature, fix_test, review_diff]
    concurrency: 2
  - name: doc-api
    role: documentation
    project: acme/api
    capabilities: [write_docs, summarize_changes]
  - name: research
    role: research
    project: "*"
    capabilities: [research_topic, compare_libraries]

projects:
  acme/api:
    workdir:     ~/code/api
    allow_tools: [read, write, git, test]
    deny_paths:  [".env*", "**/secrets/**", "~/.ssh/**"]
    network:     deny
    max_task:    { minutes: 30, usd: 3.00 }

accept_from_others:                      # req 10 — nothing automatic
  from:         [sam, priya]
  delegate:     [run_integration_tests, review_diff]
  review:       true
  context:      ask_once                 # ask | ask_once | always | never
  max_concurrent: 1
```

---

## 8. Human-to-human collaboration *(req 2, 11)*

| Capability | In MVP | Approach |
|---|---|---|
| See who's online | ✅ | Presence over the same WebSocket |
| See who's working on what | ✅ | Derived from task assignments — never self-reported |
| **See whose *machine* is online** | ✅ | "Sam is online but his node is offline" means his agents can't take work. Nothing else you use can express this |
| Project rooms | ✅ | One per GitHub repo; membership from collaborators |
| Text chat per room | ✅ | Same table as agent events, different type. Humans and agents share the room feed |
| Direct messages | ✅ | Same mechanism, `to.kind = "user"` |
| Avatars in the office | ✅ | §13 |
| Voice / video / screenshare | ❌ MVP | `call_link` per room, one anchor tag. See below |

> **On voice:** requirement 2 asks that humans communicate and collaborate — it doesn't mandate voice, and the original brief said "potentially… where appropriate." Building it means a self-hosted SFU, TURN servers, echo cancellation and device permissions: weeks of work, and the flakiest possible component on a home laptop. A `call_link` field per room gets you to Discord in one click. This is a scope call, not a rejection — revisit after the MVP if you actually miss it.

**Humans and agents share one room feed.** When your agent asks a question, it appears in the room where everyone can see it — not in a private side channel. That single decision does more for "collaborate naturally" than any feature.

---

## 9. Human ↔ AI interaction *(req 5, 11, 12)*

**Corrected from v2.** Natural language is the primary interface.

### Talking to an agent

You type in the room, addressing an agent by name:

> **you:** `@dev-api` can you add JWT auth to the API? use the existing user table, don't break the session endpoints

The agent reads it, and **replies with a structured task spec for you to confirm** — this is where specification discipline lives, and the agent does the work of it, not you:

> **@dev-api:** Here's what I understand. Start?
>
> | | |
> |---|---|
> | **Task** | Add JWT authentication to acme/api |
> | **Scope** | `src/auth/**`, `src/middleware/**` — write. `src/session/**` — read only |
> | **Acceptance** | JWT issue + verify working; existing session tests still pass |
> | **Plan** | 1. read existing user model · 2. add token service · 3. wire middleware · 4. run test suite |
> | **Budget** | 25 min, $2.00 |
> | **Unclear** | Refresh tokens — in scope or not? |
>
> `[ Start ]  [ Edit ]  [ Cancel ]`

You answer the question in chat, hit Start. **Natural in, typed contract out.** You never fill in a form; the contract still exists.

Direct task creation from the board (or from a GitHub issue) stays available for when you already know exactly what you want.

### Watching work — three depths, all needed

- **Glance** — status chip / avatar position in the office. *"working, 6 min, $0.40"*
- **Follow** — the task event stream: tool calls summarised, files touched, checkpoints, spend. This is what makes the workspace feel alive without inventing anything.
- **Inspect** — the raw transcript, **on the owner's machine only**, opened locally. Never mirrored to the server: transcripts contain file contents and environment variables.

### Being asked — an inbox, not popups

The human usually isn't looking when the agent needs them, so a blocking dialog is the wrong shape. Four responses, all four used in practice:

- **Approve** — proceed as proposed
- **Edit** — change the proposed action, then proceed *(the most-used option)*
- **Reject** — with a reason the agent must incorporate
- **Answer** — reply to a question; resumes `needs_input`

Always routed to the inbox: first-time delegation to another person's machine, any push to a shared branch, anything outside declared scope, any budget overrun, anything the agent flags as uncertain.

A pending request appears **in the room** and lights the `NEEDS HUMAN` zone. An agent silently blocked for an hour is exactly what requirement 14 exists to prevent.

### Stopping

Every task has a hard **Stop** that works from anyone's browser and doesn't require the agent's cooperation: server marks cancelled, runner kills the process group, lease released. Any member can stop any task in their project, including on someone else's machine — stopping only ever *reduces* activity, so it needs no permission.

---

## 10. AI ↔ AI communication *(req 6, 9, 12)* — core MVP capability

**Corrected from v2**, which wrongly deferred this. It's in the MVP, and it's four distinct interaction types, not one.

### The four ways agents work together

| Type | Shape | Returns | Consent |
|---|---|---|---|
| **`delegate_task`** | "Do this piece of work in your environment" | An artifact + status | Ask-once per capability |
| **`request_review`** | "Judge this work against these criteria" | A verdict + findings, no artifact | Ask-once per project |
| **`share_context`** | "Here is what I know that you need" | Acknowledgement | Explicit — it moves data off a machine |
| **`ask_human`** | "I need a person to decide" | An answer | Always visible in the room |

Splitting review out from delegation matters: **a review returns a judgement, not work.** Different state machine, different verification, different UI. Collapsing them into one message type is a mistake that gets expensive later.

### Why route across machines at all

The thing another machine has that yours doesn't is **environment**, not intelligence. If both agents are the same model, spawning a local subagent takes a second and costs nothing.

What's worth a network hop: their checked-out branch, their database with real data, their staging credentials, their device on the desk, their toolchain, **and their human**, who is accountable for that repo and can answer questions about it.

> **Design rule:** route on **capability + machine**, never on job title. `run_integration_tests@sams-mbp` is a real request. "be my researcher" isn't — that's a local subagent.
>
> Keep `role` as a human-readable badge in the office UI. It's for people, not for routing.

### The five rules that make it work

The multi-agent literature is blunt: the MAST study (1,600+ traces, 7 frameworks) puts failures in *system design* and *inter-agent misalignment*, not model capability. Cognition's version: subagents acting on independently-formed assumptions produce incompatible work. These five rules are how you get the requirement-6 capability *and* have it work.

**1. Every cross-machine message is typed and validated.** No free-form instruction field. The runner validates against the schema before anything goes on the wire, and again on receipt.

```js
delegate_task({
  capability:   "run_integration_tests",   // must be advertised by target
  target:       "node:sams-mbp",           // environment, not job title
  project:      "acme/api",
  inputs:       { ref: "sha256:...", branch: "feat/auth" },
  acceptance:   "all suites pass, or return the failing-test list",
  budget:       { seconds: 900, usd: 2.00 },
  context_refs: ["ctx_01J..."],            // shared context, by reference
  context_note: "auth middleware added; touches src/auth/**"
})
```

**2. Depth limit 1 to start, 2 once you've watched real traces.** An agent working on a delegated task can `request_review` and `ask_human` freely, but cannot `delegate_task` further. Eliminates loops and fan-out storms at near-zero capability cost — the coordinator can just make a second request.

**3. One coordinator per task tree.** Delegates return to it, not to each other. No shared mutable scratchpad between peers.

**4. Every result is verified.** The coordinator checks the returned artifact against the acceptance criterion it sent, and records the check as an event. Failing verification means `failed`, not silent input.

**5. First contact asks the machine's owner.** *(req 10)* First time your agent asks Sam's machine for capability C: Sam gets *once / always / never*. After "always," it flows silently. One question, at the moment it means something.

### The full flow

```
 Human ─chat──▶ CENTRAL SERVER ─offer──▶ my runner ─spawn──▶ coordinator agent
                                                                    │
                                        needs the staging DB box    │
                                                                    ▼
                                            runner MCP: delegate_task()
                                                    │
                    ┌── runner policy check ────────┘
                    │   capability advertised? depth==0? budget sane?
                    ▼
            CENTRAL SERVER ── ask? ──▶ Sam's inbox + room ── "always" ──┐
                    │                                                   │
                    │◀──────────────────────────────────────────────────┘
                    ▼
            Sam's runner ─spawn──▶ QA agent  (HIS machine, HIS env, HIS key)
                    │                              │
                    │        artifact hashed locally, never uploaded
                    ▼                              ▼
            CENTRAL SERVER ◀── result: summary + hash + status
                    │
                    ├──▶ office: qa-c moves to COMPLETED zone
                    └──▶ coordinator ─verify vs acceptance──▶ continue / failed
```

The human sits at the trust boundary, not in the middle of the work. Both rooms see the whole exchange live.

---

## 11. Context sharing, reviews, and artifacts *(req 12)*

**New in v3** — v2 was missing the first two entirely.

### Context sharing — data, explicitly permissioned

Requirement 12 says agents share context *when permitted*. Both halves matter: it must be possible, and it must be permissioned, because context sharing is the one operation that moves your data onto someone else's machine.

```jsonc
share_context({
  to:      "agent:qa-sam",
  project: "acme/api",
  kind:    "decision" | "file_excerpt" | "repo_state" | "finding" | "constraint",
  title:   "Auth approach chosen",
  body:    "Using RS256 with rotating keys; refresh tokens deliberately out of scope for now.",
  refs:    ["sha256:..."],        // artifacts, by reference
  ttl:     "7d"
})
```

Rules that keep this safe without crippling it:

- **Policy-gated** by `accept_from_others.context` in the receiving machine's config.
- **Framed as data on arrival.** The receiving runner builds its agent's prompt from a *local* template and inserts shared context inside explicit untrusted-data delimiters. Shared context describes the world; it never issues instructions.
- **Logged both sides** before delivery. You can always answer "what has left my machine?"
- **Referenced, not embedded, for anything large.** File contents go as artifact refs, fetched under policy.

### Review requests — a different shape from delegation

```jsonc
request_review({
  to:         "agent:review-sam",         // or "any capable in project"
  project:    "acme/api",
  subject:    { kind: "pr", ref: "acme/api#212" },   // or artifact hash
  criteria:   ["security of token handling", "no breaking changes to /session"],
  depth:      "thorough" | "quick",
  budget:     { seconds: 600, usd: 1.50 }
})
```

Returns a **verdict**, not an artifact:

```jsonc
{ verdict: "changes_requested",           // approved | changes_requested | rejected
  findings: [ { severity, file, line, note } ],
  summary:  "Token refresh path allows replay within the 30s window.",
  confidence: "high" }
```

The reviewing agent sits in the `REVIEWING` state in its owner's room while it works — visible to everyone, per requirement 14. If it reviews a GitHub PR and its owner allows it, it can post the review to GitHub **using its own owner's credentials**.

### Artifacts — references travel, bytes stay home

| Step | Behaviour |
|---|---|
| **Produce** | Node hashes content (`sha256`), stores locally, publishes a *descriptor* |
| **Descriptor** | `{ id, hash, mime, bytes, produced_by, task_id, summary, preview? }` — a model-written summary, optionally the first ~4KB. Never the whole thing |
| **Fetch** | Consumer requests by id; owner's policy decides; relays through the server as opaque chunks, never persisted server-side |
| **Expiry** | Contents expire locally (default 30 days); descriptors are permanent. A dead link to a real past artifact is honest |

**Most of the time the right artifact is a GitHub reference** — a branch, a SHA, a PR number, a check run. Those already have hosting, access control, review UI and history.

---

## 12. GitHub integration *(req 13)*

Read-only on the server, permanently. **Writes are performed by local agents using their own human's `gh` credentials** — which keeps the server out of the blast radius and is more honest about accountability, since the commit shows up as that person's work.

### What gets ingested

| Signal | In | How it's used |
|---|---|---|
| **Repositories** | ✅ | Each becomes a room |
| **Collaborators** | ✅ | Room membership; who can see and assign |
| **Issues** | ✅ | Best entry point in the product — "assign issue #42 to `@dev-api`" |
| **Pull requests** | ✅ | Drives the `NEEDS REVIEW` zone; links to review requests |
| **Commits** | ✅ **aggregated** | *"dev-a pushed 4 commits to `feat/auth`"* — one event, not four. **Corrected from v2** |
| **Branches** | ✅ | Those with agent activity or an open PR |
| **Check / CI status** | ✅ | A red build becomes a visible `BLOCKED` state instead of a surprise |
| **Reviews** | ✅ | Human and agent reviews land in the same activity feed |
| **Project activity feed** | ✅ | The aggregate of the above, per room, time-ordered |
| Stars, forks, wiki, releases | ❌ | Vanity — nothing to do with work in flight |

### How it connects

- **Sign-in:** GitHub OAuth. Free auth, free authorization, free org structure.
- **Mirror:** each person supplies a **read-only fine-grained PAT** for the shared repos. Poll every 60s with ETags — nowhere near rate limits at this size, and needs **zero inbound networking**, which deletes App registration, tunnels and webhook endpoints from the whole project.
- **Linking:** every task can reference a GitHub item; every agent-authored PR carries a trailer naming the agent and its supervising human, so the workspace can link back from GitHub to the task that produced it.

---

## 13. The shared virtual workspace *(req 1, 14, 15)*

**In the MVP.** This is the product, not a skin over it.

> ### The rule that makes requirement 14 structural
> **Position is a pure function of state.**
> Nothing is positioned by animation logic, randomness, or an agent's self-report. An avatar's location is computed from its task record. Move the record, the avatar moves. There is no other code path that produces motion.
>
> Consequence: you **cannot** render fake activity, because no such code path exists.

### What follows

- **Agents don't walk — they're placed.** No pathfinding, no wander loops, no idle animation. An agent appears in the zone its state maps to, and tweens between zones only when a real event arrives.
- **Humans may walk.** Human position is self-reported, and that's legitimate — it's a real signal about a real person's intent. It's also the only movement needing input handling, keeping the client simple.
- **Rooms are projects**, one per repo. Not "Development Room / Research Room" — role-named rooms are decorative, because a QA agent working on the API project belongs *with the API project*, not with other QA agents.
- **Zones are the states from requirement 14:** Idle · Working · Waiting · Blocked · Needs Human · Reviewing · Completed. Zone population *is* the metric.
- **Everything is a link** — click any avatar for its record: task, event stream, machine, owner, spend, GitHub item. The office is a navigation surface over real data.

```
┌─ ROOM: acme/api ─────────────────────────── 3 humans · 5 agents ─┐
│  ⟳ synced 2s ago                              💬 room chat  📞 call│
│                                                                   │
│  IDLE (1)      WORKING (2)     REVIEWING (1)      BLOCKED (1)     │
│  ┌────────┐    ┌─────────┐     ┌─────────┐        ┌─────────┐     │
│  │ ◆ doc-a│    │ ◆ dev-a │     │ ◆ rev-s │        │ ◆ qa-p  │     │
│  │        │    │ 8m $0.40│     │ PR #212 │        │ 42m ⚠   │     │
│  │        │    │ ◆ res-p │     │ thorough│        │ CI red  │     │
│  └────────┘    └─────────┘     └─────────┘        └─────────┘     │
│   ayush-mbp     ayush · priya   sams-mbp           priya-pc       │
│                                                                   │
│  ⚑ NEEDS HUMAN (1)   ← pulses only while a request is pending     │
│  ┌───────────────────────────────────────────┐                    │
│  │ ◆ dev-a → @ayush  "push to main?"  2m ago │   ● you            │
│  │                    [approve] [edit] [no]  │   ● sam            │
│  └───────────────────────────────────────────┘   ● priya (away)   │
│                                                  ○ priya-pc  ⚠ off │
│  ◆ = agent, placed by state    ● = human, moves freely            │
└───────────────────────────────────────────────────────────────────┘
```

Note the machine indicator under each agent and beside each human — **who is online, and whose machine is online**, which is the signal no existing tool can express and which requirement 14 implies.

### Two renderers, one view model

Build **one view model with two renderers**:

- The **office** — spatial, ambient, with presence and avatars. The one you leave open on a second monitor.
- The **board** — dense, sortable, filterable, keyboard-navigable. The one you use when you're getting something done.

A toggle switches renderers; no data differs between them. This is much less work than two features, and it structurally prevents the pretty view and the useful view from drifting apart — which is exactly requirement 15.

> **Build order within the MVP:** the view model and board come first (Phase 1–2), the office renders over them in Phase 3. Not because the office is optional — it ships in the MVP — but because a spatial view needs something true to display. Three weeks in, not "someday."

---

## 14. Task lifecycle

Adopt the A2A task-state vocabulary — well-considered, already survived real implementations, free interop later.

```
                  ┌──────────────┐
 created ────────▶│  submitted   │  in server, not yet accepted
                  └──────┬───────┘
                         │ node accepts, takes lease
                         ▼
                  ┌──────────────┐
      ┌──────────▶│   working    │◀──────────┐  heartbeat 15s
      │           └──┬───┬───┬───┘           │  lease 60s
      │              │   │   │               │
 resumed             │   │   └──────────▶ ┌──┴───────────┐
      │              │   │                │input-required│  needs_human
 ┌────┴─────┐        │   │                └──────────────┘
 │auth-req'd│◀───────┘   │
 └──────────┘            └──────────────▶ ┌──────────────┐
                                          │   blocked    │  waiting on a
                                          └──────────────┘  delegate / CI
                         │
      ┌──────────────────┼──────────────────┬────────────────┐
      ▼                  ▼                  ▼                ▼
┌───────────┐      ┌──────────┐      ┌───────────┐    ┌──────────┐
│ completed │      │  failed  │      │ canceled  │    │ rejected │
└───────────┘      └──────────┘      └───────────┘    └──────────┘
 acceptance met     error, budget,    human or         policy said no
 + artifacts        or lease expiry   system stop      (never started)
```

Terminal states are terminal. A retry is a **new task** with a `retry_of` link.

### Leases — what makes sleeping laptops safe

A node accepting a task takes a **60s lease**, renewed by heartbeat every 15s. Heartbeats stop → lease expires → task moves to `failed(lease_expired)`.

> ### The idempotency trap
> **Lease expiry does not mean the work stopped.** A laptop that lost Wi-Fi is very likely still running the agent, still editing files, still spending tokens. Re-offering that task to another machine means two agents editing the same repo from different states.
>
> Three mitigations, all of them:
> 1. **Never auto-reassign a task whose scope includes writes.** Surface it to a human instead.
> 2. **Reconcile on reconnect.** If the node still holds a task the server has failed, it reports the outcome as a *late result*, and the server records it rather than discarding it.
> 3. **Idempotency keys** on every task, so duplicate results collapse rather than double-apply.

**Retention:** tasks and event streams are permanent — the audit trail and the agents' task history *(req 14)*. Artifact *contents* expire locally; descriptors don't.

---

## 15. Agent lifecycle *(req 3, 4)*

### Enrollment — once per machine

1. Sign into the workspace, generate a one-time short-lived enrollment code.
2. Run `workspace node enroll <code>` on the machine. **Keypair generated locally; private key never leaves the disk.**
3. Runner posts the public key with the code; server binds machine → owner permanently.
4. Subsequent connections authenticate by signed challenge. No bearer token to leak.

### Multiple agents per human — **corrected in v3**

A human declares as many agents as they want, across as many machines as they want, in their local policy file (§7). Each gets its own card, capabilities, concurrency limit and budget. All of them appear in the office under their owner.

```
  ayush ──┬── ayush-mbp ──┬── dev-api      (developer)   working
          │               ├── doc-api      (docs)        idle
          │               └── research     (research)    idle
          └── ayush-pc  ──┴── build-agent  (build/test)  offline

  sam   ──┬── sams-mbp  ──┬── qa-api       (qa)          working
          │               └── review-api   (review)      reviewing
```

**Agents are declared on the machine, not from the web UI** — the machine's owner decides what runs on their machine. That's requirement 10 applied to agent creation itself.

### Agent card

```json
{ "id": "agt_dev_ayush_01",
  "name": "dev-api",
  "owner": "usr_ayush",
  "node": "node_ayush_mbp",
  "role": "developer",
  "capabilities": ["implement_feature", "fix_test", "review_diff"],
  "harness": "claude-agent-sdk",
  "projects": ["acme/api"],
  "concurrency": 2,
  "status": "idle" }
```

> **Route on `capabilities`, not `role`.** Roles — Developer, Research, QA, Review, Planning, Documentation — are a good *label* vocabulary but a poor *routing* vocabulary, because a role is just a prompt and prompts are free. `run_integration_tests` means "this machine has the test environment," which is what's worth routing on. Keep `role` as the badge people see in the office.

### States *(exactly requirement 14's list)*

| State | Meaning |
|---|---|
| `idle` | Online, no task. Discoverable and assignable |
| `working` | Process alive, lease fresh. Runner-verified |
| `waiting` | Queued behind its own concurrency limit or a workdir lock |
| `blocked` | Waiting on a delegate, a review, CI, or an external dependency — **must name what it waits on** |
| `needs_input` | A real request in a real inbox. Age visible in the office |
| `reviewing` | Executing a review request |
| `completed` / `failed` | Terminal for the current task; agent returns to `idle` |
| `offline` | Machine disconnected. Not discoverable, not assignable |
| `draining` | Owner stopped new work; finishes what it holds. The polite shutdown — you'll want it at 1am |

**Revocation:** an owner can kill a machine or an agent instantly from the workspace. Server drops the connection, cancels in-flight tasks, invalidates grants, keeps the audit record. Revocation must never require the node to cooperate — it's what you reach for precisely when something is misbehaving.

---

## 16. Communication and message flow *(req 11)*

One envelope shape for everything on the wire.

```jsonc
{
  "v": 1,
  "id":  "msg_01J...",         // ULID
  "seq": 84213,                // server-assigned, monotonic per project
  "type":
      // human ↔ human
        "chat" | "presence" | "position"
      // human ↔ AI
      | "agent.message" | "task.create" | "task.spec.propose" | "task.spec.confirm"
      | "human.ask" | "human.answer" | "task.cancel"
      // AI ↔ AI  (req 6, 9, 12)
      | "delegate.request" | "delegate.decision" | "delegate.result"
      | "review.request"   | "review.result"
      | "context.share"    | "context.ack"
      // system
      | "task.offer" | "task.accept" | "task.status" | "task.event" | "task.result"
      | "artifact.publish" | "artifact.fetch"
      | "agent.card" | "node.status" | "github.activity",
  "project": "prj_acme_api",
  "from": { "kind": "user|agent|node|server", "id": "..." },
  "to":   { "kind": "user|agent|node|room",   "id": "..." },
  "task": "tsk_01J...",        // null for chat/presence
  "idem": "sha256:...",        // required for side-effecting types
  "ts":   "2026-08-23T09:14:22Z",
  "body": { /* type-specific, schema-validated at BOTH ends */ }
}
```

All three communication axes from requirement 11 ride the same envelope, the same socket, the same ordered log — which is why the workspace can show a single coherent activity feed containing human chat, agent questions and cross-machine delegation interleaved in true order.

### Guarantees

| Property | Choice |
|---|---|
| **Ordering** | Total order per project via `seq`. No global ordering — unnecessary and expensive |
| **Delivery** | At-least-once. Every side-effecting handler idempotent on `idem`. Don't attempt exactly-once; it doesn't exist over an unreliable link |
| **Durability** | Written to SQLite before acknowledgement. If the server took it, it survives a reboot |
| **Resume** | Node stores `last_seq`; on reconnect sends it and receives the gap. That's the entire offline story — a few dozen lines |
| **Outbox** | Node buffers outbound events to disk while disconnected, flushes on reconnect. Work continues offline; reporting catches up |
| **Validation** | Same zod schema module on server, node and browser. Validate on send *and* on receive |

---

## 17. Permissions and security model *(req 10)*

You're not defending against your friends. You *are* defending against a confused agent with shell access and a $200 overnight bill. Ranked by what will actually happen.

### 1. Runaway cost — *near certain, week one*

- Hard per-task cost **and** wall-clock caps. Non-negotiable.
- Per-machine daily cap.
- **Delegation budget is charged to the delegator**, so nobody can spend your money by asking your agent for things.
- Exceeding a cap → `failed(budget_exceeded)`, process killed. Never a silent pause.
- Spend visible in the office, per task and per day.

### 2. A confused agent with shell access — *likely*

Not malice — an agent that misreads a task and starts deleting, force-pushing, or rewriting history.

- Deny-by-default tool allowlist per project.
- Path denylist (`.env*`, `**/secrets/**`, `~/.ssh/**`).
- No outbound network for the agent unless explicitly granted.
- Approval required for: pushes to shared branches, anything outside declared scope, destructive git operations.
- **Enforced in the runner's code** via the harness's programmatic permission callback and pre-tool-use hooks — not in a prompt. Prompts are advice; hooks are enforcement.

### 3. Accidental prompt injection across machines — *possible*

Your agent sends text to Sam's agent. That text lands in Sam's context on Sam's machine with his shell and keys. Among friends this isn't an attack — but a poisoned README, a compromised dependency, or an agent relaying text it read somewhere produces the same effect.

The mitigations are things the design wants anyway:

- **No free-form instruction channel.** The typed schemas in §10–11 have no `instructions` field.
- **Remote text is framed as data.** The receiving runner builds its agent's prompt from a *local* template and inserts remote strings inside explicit untrusted-data delimiters.
- **Capability determines the action.** The delegate runs the *local* handler for `run_integration_tests`. Remote input parameterises it; it can't redefine it.
- **The runner enforces regardless** — threat 2's controls apply to delegated work too.

### 4. Machine theft — *unlikely, worth ten minutes*

Node key on disk = ability to connect and receive tasks. Instant revoke from the workspace, and the key is useless.

### Identity layers

| Layer | Mechanism | Lifetime |
|---|---|---|
| Human | GitHub OAuth → session cookie | Days, refreshable |
| Machine | Ed25519 keypair, signed challenge at connect | Permanent until revoked |
| Agent | Derived from machine identity — **cannot authenticate independently** | Machine connection lifetime |
| Task grant | Short-lived signed token scoped to one task + one capability | Task duration + slack |

### Non-negotiables *(this is requirement 10, made concrete)*

- No agent ever gets a shell, a file handle, a repo, a key or a terminal on a machine it doesn't live on. There is **no code path** for it.
- Secrets and API keys never enter the server, a task envelope, or an artifact descriptor.
- Each agent's model API key comes from its **own owner's** machine. Nobody runs on anyone else's budget.
- Every cross-machine action is logged on **both** machines before it happens.
- TLS everywhere, including on the tailnet — free via `tailscale serve`, no cert management.

---

## 18. Failure and recovery

| Scenario | Detection | Behaviour | What people see |
|---|---|---|---|
| **Agent crashes** | Runner sees non-zero exit | `failed` + exit code + last 50 log lines; lease released | Red chip, one-click Retry as a linked new task |
| **Agent loops** | Budget or wall-clock cap | Killed, `failed(budget_exceeded)`, partial artifacts kept | Spend, stopping point, partial output |
| **Wrong result** | Coordinator verifies vs acceptance | `failed(verification)`; must not be consumed | The mismatch, side by side |
| **Machine loses network mid-task** | Heartbeats stop, lease expires at 60s | `failed(lease_expired)`. **Never auto-reassigned if scope includes writes.** Agent keeps running; runner buffers to disk | "Sam's machine went offline 2m in — work may still be running there" |
| **Machine reconnects** | Auth + `last_seq` handshake | Server replays the gap; node flushes outbox; late results reconciled, not dropped | Gap fills in, in order, with a reconnect marker |
| **Laptop sleeps mid-task** | Same as network loss | Same path. On wake the OS resumes the process — reconciliation is what makes this safe | Same, plus "machine was asleep" |
| **Central server goes down** | Nodes fail to reconnect | **Local work continues** *(req 7 holds even here)*. Running agents finish; results queue on disk. Cross-machine collaboration pauses; local tasks still startable from the node CLI | Persistent "server unreachable" banner with last-known state. Nothing silently stale |
| **Server comes back** | Reconnect with backoff + jitter | Outboxes flush, states reconcile, projections rebuild from the log | History fills in with correct timestamps |
| **Server loses its disk** | SQLite file gone | Restore from nightly backup; nodes replay from their own `last_seq`. Some coordination history lost; **no work product lost** — it was never there | Gap in history; local artifacts and git intact |
| **Delegate never responds** | Child lease expiry | Parent unblocks with `delegate_timeout`; coordinator continues degraded or escalates to a human | "Waiting on Sam's QA agent — timed out after 15m" |
| **Review never returns** | Same | `review_timeout`; task goes to `needs_input` rather than proceeding unreviewed | Visible in the room |
| **Approval never answered** | Approval age threshold | Stays `input-required` — **never auto-approves**. Escalates to the room after 30m | Ageing indicator, then a nudge |
| **Two agents, same repo** | Per-(machine, workdir) advisory lock | Second task waits or is rejected with a clear reason | "Waiting — dev-api is holding ~/code/api" |

> **Fail loud, fail terminal, never auto-heal into ambiguity.** Every automatic recovery in a distributed agent system is a chance to duplicate side effects. Prefer a clearly failed task with preserved partial output and a one-click retry. Humans are good at deciding whether to retry; systems are bad at it.

---

## 19. The dedicated server laptop *(req 16)*

Runs **the central server and nothing else**. No agents, no builds, no model calls. If it ever executes work, requirement 8 is broken and the architecture has become the cloud AI platform you explicitly don't want.

### What it hosts

| Component | Choice |
|---|---|
| Central server | One Node process: WS gateway, message + task routing, discovery, presence, workspace state, event log, GitHub poller, lease timer, and the workspace UI itself |
| Database | **SQLite in WAL mode**, one file. At this size this isn't a compromise — it's correct, and it deletes a dependency |
| Access | **Tailscale**, via `tailscale serve` — HTTPS on a stable name, zero cert management, zero public exposure |
| Process manager | `systemd` (if you put Linux on it — recommended) or `launchd` (macOS) |
| Backup | Nightly `sqlite3 .backup` to an external disk **plus** an off-machine copy. This box holds the only copy of the coordination history |

**No Docker** at this scale — it's ceremony. But keep the server **trivially relocatable**: one directory, one config file, one `npm start`. The day the laptop dies, you want it on another machine in twenty minutes.

### Making a laptop behave like a server

- **Never sleep:** on macOS, `caffeinate -s` under a `launchd` job plus Energy Saver set to prevent sleep on power. Lid-closed operation needs AC and sometimes `pmset` tuning — verify before relying on it.
- **Auto-restart on boot**, so it returns after a power cut.
- **Consider headless Linux.** For an always-on box it's meaningfully more reliable than macOS, and `systemd` is better at this job than `launchd`.

### What server uptime actually buys you *(req 16, honestly)*

> With the server up and everyone's laptop asleep, the workspace shows full history, accepts chat, and accepts task creation — but does no AI work, because **there is nowhere for work to run**. That's requirement 7 working correctly, not a bug.
>
> **Server uptime gives continuity of record, communication and coordination — not continuity of execution.** The UI says so plainly: a task assigned to an offline machine sits in `submitted` and shows why.

---

## 20. MVP definition

Proves the whole concept: **humans and their locally-running agents coexisting in one shared workspace, collaborating across machines through the central server, with nothing executing anywhere but on its owner's hardware.**

| Area | Included |
|---|---|
| **Identity** *(req 8)* | GitHub OAuth; machine enrollment by one-time code; Ed25519 auth |
| **Projects** *(req 13)* | Room per GitHub repo; membership from collaborators |
| **Machines** *(req 7)* | Runner CLI: enroll, connect, reconnect-with-resume, drain, local policy file |
| **Agents** *(req 3, 4)* | Multiple per human, multiple per machine; cards published; runner-verified status |
| **Human↔Human** *(req 2)* | Presence (human **and** machine), rooms, room chat, DMs, call link |
| **Human↔AI** *(req 5)* | Natural-language chat with agents; agent-proposed task specs; approval inbox (approve/edit/reject/answer); hard stop |
| **AI↔AI** *(req 6, 9, 12)* | `delegate_task`, `request_review`, `share_context`, `ask_human` — all server-routed, all consented, depth 1 |
| **Tasks** | Create, offer, accept, lease + heartbeat, event stream, cancel, all terminal states, retry-as-new |
| **Execution** *(req 7)* | Real local agents, scoped cwd, tool allowlist, path denylist, budget caps |
| **Artifacts** | Local hash + descriptor to server; on-demand fetch under policy |
| **GitHub** *(req 13)* | Read-only polled: repos, collaborators, issues, PRs, commits (aggregated), checks, reviews |
| **Workspace** *(req 1, 14, 15)* | **Office view** with rooms, zones, avatars, presence — **plus** board view over the same view model |
| **Ops** *(req 16)* | Tailscale, systemd/launchd, nightly backup |

### Definition of done

Three machines, three people, one real repo:

1. Ayush types in the room: *"@dev-api add JWT auth, don't break the session endpoints."*
2. `dev-api` proposes a task spec, asks one clarifying question, gets an answer, starts — **on Ayush's machine**.
3. Mid-task it delegates the integration run to `qa-api` **on Sam's machine**; Sam approves once; it runs on **his** hardware with **his** environment.
4. It requests a review from `review-api` on Sam's machine, which returns `changes_requested` with findings.
5. `dev-api` asks Ayush whether to push; Ayush approves from his phone's browser.
6. Priya, who has written nothing, watches the entire thing happen live in the office — every state change, every machine, every zone transition, correct.
7. **Sam closes his laptop lid mid-review and reopens it two minutes later. Everything reconciles, with exactly one result.**

Step 7 is the real acceptance test. Anyone can demo a happy path.

---

## 21. Not in the MVP

| Feature | Why out | Return? |
|---|---|---|
| Voice / video / screenshare | Weeks of SFU + TURN; flakiest thing on a home server. `call_link` covers it | Post-MVP if you actually miss it |
| Multi-hop delegation (depth > 1) | Combinatorial failure surface and unbounded spend before you've seen one real trace | Phase 5, once traces earn it |
| Agent-initiated work | Agents creating their own tasks turns every bug into a runaway loop across friends' machines | Later, heavily rate-limited |
| Agent long-term memory | A whole product on its own | Later, per-agent first |
| Server-side GitHub writes | Breaks the "never" list for zero gain | **Never** |
| CRDTs / Yjs | Nothing is concurrently edited by multiple writers. Server-authoritative + ordered log is simpler and sufficient | Only with collaborative document editing |
| Postgres, Docker, brokers, k8s | One process and a SQLite file serves 4 people without noticing. Every component is another thing that breaks at 2am | When measurements demand it |
| Multi-tenancy, orgs, invites | One workspace, and you know everyone in it | Never |
| Public hostname, tunnels, webhooks | Tailscale + polling covers it entirely | Only if someone can't install Tailscale |
| Real A2A protocol conformance | Its transport assumes reachable HTTP servers; laptops aren't | Borrow the data model, skip the transport |

---

## 22. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Runaway cost** | Near certain | Moderate | Per-task, per-machine, per-day caps; delegation charged to delegator; hard kill; spend in the office |
| 2 | **AI↔AI produces worse output than one agent** | Medium–high | Core feature underdelivers | Delegate for **environment**, not reasoning; depth 1; mandatory verification; separate review from delegation. Measure delegated vs solo outcomes from the start |
| 3 | **The office ships but shows nothing interesting** | Medium | Hollow product | Build the view model first; the office renders real state or nothing. §13's rule guarantees it |
| 4 | **Confused agent does damage** | Medium | Moderate–severe | Tool allowlist, path denylist, approval on destructive ops, enforced in runner code not prompts |
| 5 | **Duplicate execution after a partition** | Medium | Severe (repo corruption) | No auto-reassign for write-scoped tasks; workdir advisory lock; idempotency keys; reconnect reconciliation |
| 6 | **Scope creep** — the office becomes a game | High | Kills the project | "No pixel without an event." If a feature can't name the event behind it, it doesn't ship |
| 7 | **Agent harness churn** — SDK/CLI moves under you | High | Moderate | One thin adapter (`spawn / stream / interrupt / kill`); never let harness types leak into the protocol |
| 8 | **Status lies** — office says working, nothing is happening | Medium | Destroys trust in the whole thing | Runner-observed status only; lease freshness is part of rendered state; stale is visibly stale |
| 9 | **Server laptop unreliability** | Medium | Low | Nodes degrade gracefully offline; nightly off-machine backup; keep the server relocatable |
| 10 | **Consent flow too annoying to use** | Medium | AI↔AI goes unused | ask-once-then-remember; project-scoped; one line in a config file for people who prefer that |

---

## 23. Phased development plan

~6 weeks of evenings to the full MVP. Each phase has an exit criterion you can demo — if you can't demo it, you're not out of the phase.

| Phase | Time | Content | Exit criterion |
|---|---|---|---|
| **0** | 1–2 wk | **Protocol + skeleton.** Envelope schema, task state machine, central server + SQLite, WS gateway, runner that enrolls and connects. Task runs `echo`, not an agent | Create a task in the browser, watch a fake task run on your laptop, kill the network, watch it resume correctly |
| **1** | 1 wk | **Real local agents** *(req 4, 7)*. Harness adapter, scoped cwd, tool allowlist, budget caps, event streaming, artifact hashing. Board view with the req-14 states | An agent makes a real change in a real repo, streamed truthfully, cancellable mid-run |
| **2** | 2 wk | **Multi-machine + all three communication axes** *(req 2, 5, 6, 9, 11, 12)*. Second and third machines, presence, room chat, natural-language agent chat with spec proposal, approval inbox, `delegate_task`, `request_review`, `share_context`, consent flow | The §20 acceptance test, steps 1–5 and 7 |
| **3** | 1–1.5 wk | **The office** *(req 1, 14, 15)*. Spatial renderer over the existing view model. Agents placed by state, humans movable, machine presence, everything click-through | Office and board disagree about nothing — provable by diffing the view models. §20 step 6 |
| **4** | 1 wk | **GitHub** *(req 13)*. PAT read-only mirror, rooms from repos, tasks from issues, PRs, commits aggregated, checks, activity feed | A task created from issue #N shows its PR, commits and CI state without a manual refresh |
| **5** | ongoing | **Depth.** Agent-authored PRs, artifact fetch policies, cost ledger, event-log replay of a whole session, depth-2 delegation if traces earn it | — |

> Phases 0–2 are the system. Phase 3 is the product. Phase 4 is what connects it to real work. Don't reorder 3 before 2 — a spatial view over nothing is a screensaver, and you'd be building it twice.

---

## 24. Final architecture recommendation

| Layer | Choice | Why this, over what |
|---|---|---|
| **Language** | **TypeScript everywhere** | The envelope schema is the heart of the system and must be identical on server, node and browser. One `zod` module imported by all three gives compile-time *and* runtime validation from one definition. Worth more than any per-tier language optimum. Python only if your harness forces it, and then only inside the adapter |
| **Central server** | **Fastify + `ws`** | Small, fast, unopinionated. Not NestJS (ceremony), not a full framework |
| **Database** | **SQLite (WAL), `better-sqlite3`** | Relational state + append-only log + JSON bodies in one file. Single process means in-process fan-out; no broker needed |
| **Transport** | **One WebSocket per machine, one per browser** | Bidirectional, outbound-only, trivially resumable with a `seq` cursor. Not gRPC (browser friction), not SSE+POST (two half-channels) |
| **State model** | **Server-authoritative + ordered event log** | Nothing is concurrently edited by multiple writers, so CRDTs buy nothing and cost a lot. Also: the log is what makes the office provably honest |
| **Agent interface** | **Local MCP server on the runner** | Agents get `delegate_task`, `request_review`, `share_context`, `ask_human` as ordinary tool calls. Runner stays sole network peer and sole policy point. Works with any MCP-capable harness |
| **Harness** | **Claude Agent SDK first, behind an adapter** | Gives you the two things §17 depends on: a programmatic permission callback and pre-tool-use hooks. Adapter keeps you free to add others |
| **Protocol semantics** | **A2A-shaped data model, server transport** | Task states, agent cards, artifacts — proven vocabulary, free future interop. Skip its HTTP transport, which assumes reachable servers |
| **Workspace UI** | **React + one view model, two renderers** — board (DOM) + office (Canvas/Pixi) | They can never disagree, which is requirement 15 enforced structurally |
| **Auth** | **GitHub OAuth (humans) + Ed25519 (machines)** | No password system to build or breach. Machine keys never leave their machine |
| **Network** | **Tailscale only** | Zero public exposure, free HTTPS via `tailscale serve`, works from any café |
| **Deployment** | **A directory, a config file, `npm start`, under systemd** | Relocatable in twenty minutes. Not containerised — ceremony at this scale |

### Three invariants to defend to the end

1. **The central server never executes.** No LLM calls, no user code, no builds. *(req 8)*
2. **The runner is the only network peer on each machine.** Agents reach the world through it or not at all. *(req 10)*
3. **Nothing renders that no event caused.** The workspace is a projection; it owns no truth. *(req 14, 15)*

---

## 25. What to copy, and from where *(req 17)*

Never sold, never leaves your tailnet — so there's no reason to invent anything already worked out. Copy the architecture, the vocabulary, the state machines, the UI ideas. Where source is available, read it before writing your own.

| System | Availability | Take | Skip |
|---|---|---|---|
| **Munder Difflin** | Open source (Electron + Pixi) | The office-floor visual vocabulary; avatars bound to *real* processes; the outbox → router → inbox mailbox pattern; per-agent terminal panes | Git-repo-as-message-bus — fine on one machine, wrong across machines (you need an ordered durable log). The single "GOD agent" orchestrator. Electron |
| **October** | Closed / hosted — study docs, use it | The Bus concept; scoped peer discovery; harness-neutral adapters; **delegation and human escalation as first-class primitives** rather than prompts; MCP as the agent-facing surface | Hosted control plane; 17-harness support (you need one); remote Linux execution |
| **qm** | Open source | Per-scope isolation (own memory, files, credentials per person and room); the three security postures — strict / auto / dangerous — mapping onto your policy file's `mode`; harness abstraction | Slack-first UX; Postgres + cloud sandboxes; org admin layer |
| **A2A spec** | Open standard | Task state machine; agent card shape; artifact and message-part model; streaming + push semantics. **Copy the vocabulary verbatim** | The HTTP transport |
| **LangChain Agent Inbox** | Open source | The inbox UX and the approve / edit / reject / respond quartet — that specific set of four is well-tested and easy to get wrong from scratch | LangGraph coupling |
| **Gather** | Closed | Rooms as the organising unit; proximity presence as *ambient* awareness; the "leave it open on a second monitor" feel | Walking-around-as-the-product; proximity audio |

**One practical note, not a lecture:** reading an architecture and reimplementing it is unrestricted, and that's most of the table. Pasting source verbatim carries its license along even in a private repo — Munder Difflin and qm each ship a LICENSE file worth two minutes before copying code. Concepts, diagrams, state machines and protocol shapes carry nothing at all.

---

## 26. Exactly what to build first

### One vertical slice. Two weeks. No branches.

**The slice:** sign in with GitHub, enroll one machine, type a message to an agent in a room, and watch a **real** agent execute it **on that machine** — with truthful streaming status, a working stop, and correct behaviour when the network drops mid-run.

One machine. One agent. No AI↔AI yet, no GitHub data, no office renderer. Those are Phases 2 and 3, and they land on top of this without rework — because the view model, envelope and state machine you build here are exactly what they render and route.

### Build order within the slice

1. **The envelope and the state machine, as code, first.** A single `protocol/` package: message types, task states, legal transitions, all as zod schemas. **Write the transition tests before anything else exists.** Server, runner and browser all import this. Getting it wrong here is the only mistake in this plan that's genuinely expensive to undo.
2. **Central server:** SQLite schema + WS gateway + message router + task store + event log. No GitHub, hardcoded dev user.
3. **Node runner:** enroll, connect, accept an offer, spawn `echo hello`, heartbeat, report terminal state. **Prove leases, reconnect-with-resume and the disk outbox with a fake agent** — before a real one exists. Debugging a lease bug and an LLM bug simultaneously is miserable.
4. **Swap `echo` for the real harness adapter** — scoped cwd, tool allowlist, path denylist, budget cap, streamed events. Requirement 7 is now real.
5. **Thinnest possible workspace:** one room, chat box, task list with the req-14 states, live event stream, stop button. Unstyled is fine — this is the view model the office will render later.
6. **Then GitHub OAuth**, replacing the dev user.

### Definition of done

- You type a natural-language message in the room; the agent proposes a spec; you confirm; **a real agent makes a real, correct change in a real repository on your machine.**
- The event stream shows what actually happened — no invented steps, no status the runner didn't observe.
- Stop kills the process within two seconds; the task lands in `canceled`.
- **Turning Wi-Fi off for 90 seconds mid-task and back on produces a complete, correctly-ordered event stream with a visible reconnect marker — and exactly one result.**
- **The budget cap fires and kills a deliberately looping task.**

### The one thing to get right

The last two bullets. Anyone can make an agent run from a web button in an afternoon. **Leases, resumable ordered event streams, idempotent results and hard budget kills are what make this a distributed workspace rather than a demo** — and every later phase stands on them. AI↔AI collaboration in Phase 2 *is* those same primitives pointed at a second machine. The office in Phase 3 *is* those same events, rendered. Ship Phase 0 solid and the rest is mostly application code.

### Before you start

Spend one evening with October and Munder Difflin actually **installed and running** — not reading their marketing, using them. Then read Munder Difflin's and qm's source for an hour. Since you're copying deliberately (§25), that reading *is* part of the build. Write down what you take and why; that list will be the most useful thing you produce in week one.

---

## Sources

- [October — multiplayer runtime for technical work](https://www.october.dev/)
- [Munder Difflin — multi-agent harness](https://github.com/chaitanyagiri/munder-difflin)
- [qm — multiplayer agent harness](https://github.com/yc-software/qm)
- [Why Do Multi-Agent LLM Systems Fail? (MAST, arXiv 2503.13657)](https://arxiv.org/abs/2503.13657)
- [Cognition — Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
- [Agent2Agent (A2A) Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [A2A — Streaming & Asynchronous Operations](https://a2a-protocol.org/latest/topics/streaming-and-async/)
- [MCP vs A2A compared](https://www.truefoundry.com/blog/mcp-vs-a2a)
- [Claude Agent SDK — configuring permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [LangChain Agent Inbox — human-in-the-loop UX](https://github.com/langchain-ai/agent-inbox)
- [GitHub — best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Amazon SQS visibility timeout (lease model reference)](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Tailscale Serve — exposing local services privately](https://blog.openreplay.com/secure-local-web-apps-tailscale/)
- [LiveKit self-hosting overview (voice cost assessment)](https://docs.livekit.io/transport/self-hosting/)
