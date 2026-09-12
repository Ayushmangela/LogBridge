# LogBridge

**A shared virtual office where you and your friends work alongside the AI
coding agents running on your own laptops.**

You walk around a pixel office. So do your friends. So do the agents. You talk
by voice when you're in the same room. Your agent and your friend's agent hand
work to each other across machines — and the server routing it between them
cannot read what they said.

This is the single document for the whole project: what it is, how it works,
what techniques it uses, what's built and what isn't. Every claim here was
checked against the source or the running system; where something is unproven
it says so rather than describing the intent.

---

# Part 1 — What this is

## 1.1 The idea in one picture

```
   YOUR LAPTOP            SERVER LAPTOP             FRIEND'S LAPTOP
   ═══════════            ═════════════             ═══════════════
   your agents run   ←→   routes · remembers   ←→   their agents run
   your repos             draws the office          their repos
   your API keys          NEVER EXECUTES            their API keys
```

Three rules the whole design follows:

1. **Agents run only on their owner's machine**, with that owner's own
   installed CLI (`claude`, `opencode`, `gemini`, `codex`) and their own keys.
   The server has no execution path at all — not disabled, *absent*.
2. **Nothing on screen moves unless a real event caused it.** No idle
   animation. A character's position *is* the task state.
3. **Nobody commands anyone else's machine.** Across people it is always
   *request → consent → run on the owner's hardware.*

## 1.2 Why an office, and not a dashboard

Position encodes state, so you read the room at a glance instead of reading a
table:

| Room | Means |
|---|---|
| Boss cabin | agents waiting on the repo admin |
| Senior cabins ×3 | agents waiting on those three people |
| Open office | agents actively working right now |
| Atrium | upper: blocked on CI · lower: reviewing code |
| Meeting room | agents on **two different laptops** working together |
| Cafeteria | idle |
| Chill room | just finished |
| Lobby | reception |

*Cafeteria full = quiet day. One cabin crowded = that person is the
bottleneck. Meeting room busy = the machines are talking to each other.*

## 1.3 Who it's for

**2–3 people using it daily, up to ~10 who might drop in to watch.** One spare
laptop as the always-on server. Private network (Tailscale). Not a product —
built by friends, for ourselves, to learn.

That number matters. Hub-and-spoke coordination is correct at this size, and
most of the "deliberately not built" decisions in §7.3 follow from it.

---

# Part 2 — How it actually works

The clearest way to understand the system is to follow one task from a sentence
typed in a chat box to a result on the board.

## 2.1 The constraint everything follows from

> **Agents are one-shot CLI processes, not services.** `claude -p` runs a turn
> and exits. Nothing sits in a loop polling a mailbox.

This single fact shapes every other decision. There is no agent daemon to send
a message *to*. So there are exactly **two ways** to reach an agent:

- **inject** — a terminal session is already live. Cheap, and it keeps the
  agent's accumulated context.
- **spawn** — no session exists. Cold start; the message *becomes* the prompt.

Therefore **a message is not something an agent receives — a message is a
reason to run an agent.** Everything else is bookkeeping around those two verbs.

## 2.2 One task, end to end

**Step 1 — a goal becomes a plan.**
You type a goal. The planner decomposes it into a wave-ordered task graph. Each
task carries more than a description: a `suggested_role`, an
`expected_outputs` list (`diff`, `test_report`, `architecture_doc`…), and a
`requires_review` flag set automatically when the task produces a diff.

**Step 2 — the orchestrator picks an agent.**
Not an auction, not round-robin — a deterministic weighted score, computed on
the server with no model call:

| Signal | Weight |
|---|---|
| Has the required capability | +40 (or +30 when none is required) |
| Role matches the plan's suggestion exactly | +25 |
| Role is in the right office category | +12 |
| Owner's machine is online | +20 |
| Historical success rate | up to +20 |
| Current load vs. concurrency limit | up to −10 |
| Already failed this task once | −15 |

Ties break on lowest load, then agent id — so the same inputs always produce
the same choice, which is what makes routing decisions reproducible and
testable. Three conditions are hard gates rather than weights: machine offline,
at concurrency limit, missing a required capability. If nothing is eligible the
task **queues** rather than failing.

**Step 3 — the agent is woken.**

```
message routed to an inbox
   ↓
terminal live?  ── yes ──▶ inject a short notice (keeps its context)
   ↓ no
machine online? ── yes ──▶ spawn, wait for the CLI's own readiness signal,
   ↓ no                    then send. 45s ceiling.
leave it, record `undeliverable` — never pretend it arrived
```

"Wait for readiness" is real signal detection, not a sleep — see §4.4.

**Step 4 — the agent works.** On its owner's machine, in an isolated git
worktree, under a wall-clock budget and a spend cap, with its tool policy
enforced locally by the runner.

**Step 5 — three gates before it may say "done".**
The agent claiming completion is not completion. In order:

1. **Artifacts** — did the files it declared actually appear on disk? A task
   with `expected_outputs: ["diff"]` cannot complete without one. Rejected once
   (`MAX_REJECTIONS = 1`) with a message explaining what's missing, so the
   agent gets a chance to finish rather than the task simply failing.
2. **Acceptance checks** — named commands defined per project (`test`, `lint`,
   `build`) that must exit 0. A task references checks **by name**, never by
   command string, so an agent cannot smuggle in a command to run. Defining one
   is behind the same owner/admin gate as invites, because defining a check
   means handing the server something to execute.
3. **Review** — for anything producing a diff, a second agent with a reviewer
   role must return ACCEPT. The reviewer is never the author. Capped at
   `MAX_REVIEW_CYCLES = 2` so author and reviewer cannot loop forever.

**Step 6 — supervision, while all of that is happening.**
A supervisor loop runs on a clock and watches for stalls. It may **REASSIGN**
or **RETRY** on its own; **PAUSE** and **CANCEL** are never automatic — they
need a human, because both destroy work in progress. A circuit breaker trips
independently when an agent has burned 80% of its budget or repeated the same
action four times, firing once per task per kind.

## 2.3 Agents working together — across two laptops

This is the heart of the product.

| Message | What happens |
|---|---|
| `delegate.request` → `delegate.decision` → `delegate.result` | Your UI agent asks their dev agent to do something. **Their** machine decides yes/no, then runs it on **their** hardware with **their** keys |
| `review.request` → `review.result` | Your agent asks theirs for a review, gets a verdict back |
| `context.share` | Your agent passes findings across so theirs doesn't redo the work |
| Shared project memory | Both agents read what the team has learned, including from the other machine |

**All of it is end-to-end encrypted** — X25519 + HKDF-SHA256 + AES-256-GCM
(HPKE base mode), using only Node's built-in crypto, no dependency. The server
routes it, logs the fact of it, and draws the office from it, and **cannot read
the payload.**

That claim is tested the only way that means anything:
`apps/runner/src/sealedDelegation.test.ts` dumps every table in the server's
database and greps for the plaintext.

**Consent:** a machine refuses delegated work until its owner opts in
(`acceptDelegations`, off by default). Grant modes `always` / `never` /
ask-every-time exist in the database.

---

# Part 3 — Architecture

## 3.1 The packages

| | |
|---|---|
| `packages/protocol` | one zod definition of every message, shared by server, runner and browser. ~2k lines |
| `apps/server` | Fastify + WebSocket + SQLite. ~31k lines, ~140 routes |
| `apps/runner` | the daemon on each laptop. Spawns the CLI, enforces policy, hard budget kill. ~7k lines |
| `apps/web` | the office. Vanilla HTML/CSS/JS, **no build step**. ~9k lines |
| `apps/desktop` | thin Electron shell around the identical page |

**One schema, three consumers.** The protocol package is not a types folder —
it is zod schemas that validate at runtime on both ends of every wire. A
malformed envelope is rejected at the boundary, not discovered three layers in.

## 3.2 Three WebSocket surfaces, three trust levels

| Endpoint | Who connects | Authentication |
|---|---|---|
| `/ws` | browsers | session token → user id (never a client-supplied id) |
| `/node-ws` | machines | Ed25519 signed challenge |
| `/pty-ws` | terminals | shared token, loopback-only by default |

`/pty-ws` is the one to be careful with: it accepts `spawn` followed by raw
keystrokes, so exposing it without a token would put an unauthenticated
interactive shell on every network interface. It binds to `127.0.0.1` unless
you explicitly set both host and token.

## 3.3 The two message channels

| | Same machine | Across machines |
|---|---|---|
| Transport | files (`outbox/` → router → `inbox/`) | sealed WebSocket envelopes |
| Speed | 1.5s router tick | near-instant |
| Encrypted | no | **yes — server can't read it** |
| Survives restart | yes, it's on disk | no |
| Retry / dead-letter | yes | no |
| Consent | n/a | yes |

These are genuinely different guarantees, not one feature with two transports.

**Why files and not a broker.** The durability requirement here is "survive a
laptop closing its lid." A file on disk does that. Redis or NATS would add an
always-on dependency to a system whose entire premise is that the work happens
on your own machine. The `inbox/.done/` directory is the acknowledgement — an
ack you can inspect with `ls`.

## 3.4 State model — full snapshot, no deltas

The server computes a `WorkspaceView` — the complete state of one office — and
broadcasts it. There is no delta protocol, no patch stream, no client-side
reconciliation. A client that reconnects after any gap is immediately correct,
because the next message it receives is the entire truth.

The cost of that choice is real (a view build is ~75 prepared statements), so
it is paid carefully: statements are prepared once and reused, broadcasts are
coalesced, and each viewer's view is built once and shared across their
sockets. **Simple protocol, optimised implementation** — rather than a complex
protocol that is cheap on paper and wrong in practice.

## 3.5 Who plans what

| Scope | Model |
|---|---|
| **Your own agents** | you, or your commander agent, direct them. It's your machine |
| **Across people** | **request → consent → run on the owner's machine.** Never command |

The reason is ownership: a commander that directs everyone's agents is spending
your friend's money on your friend's laptop by decree. That contradicts the
same principle the server follows by never executing anything.

**The humans are the orchestrators.** You're all in the office, seeing who's
busy, talking by voice. That is what makes this different from a fully
autonomous agent framework.

---

# Part 4 — Techniques worth a look

The parts where the engineering is more interesting than the feature.

## 4.1 Agent roles are files, not code

A role is a markdown file with YAML frontmatter — the Claude Code subagent
format, so packs written for other tools load here unchanged:

```yaml
---
name: reviewer
description: Reads diffs and flags risk; does not rewrite code
tools: [Read, Grep, Glob]
disallowedTools: [Write, Edit]
capabilities: [code_review, security_review]
---
## Core mission …
## Definition of done …
```

Resolved through three layers, most specific wins: built-in →
`~/.logbridge/roles` → `<project>/hive/roles`. Adding a role is adding a file.

The file is the **single source** for three things that used to drift apart:
the agent's terminal prompt, its `identity.md` on disk, and its creation
defaults (capabilities, tool policy). Every LogBridge-specific field has a
fallback, so a borrowed file with none of them still loads.

**Editing a role re-seeds live sessions for free.** The prompt builder hashes
its output into a fingerprint; change the file, the fingerprint changes, and
every running session on that role re-seeds on its next turn. No new mechanism
was needed — the invalidation fell out of a hash that already existed.

## 4.2 Prompts are budgeted and tested

Agent prompts are built by a function and pinned by tests: the board vocabulary
must appear in both prompt variants, `$AGENT_DIR` must be used instead of
absolute paths, the one-shot execution model must be stated, the reviewer must
be told not to rewrite code — and the whole thing must stay under a byte cap.
Raising that cap requires editing the test and writing down why. Prompts are
the system's largest recurring cost; treating them as untested strings is how
that cost grows silently.

## 4.3 Spatial state mapping

Nothing on the floor is decorative. Room membership is derived from task state,
so "walk over and see who's stuck" is a real query with a visual answer. The
meeting room only unlocks when two *distinct owners* are online — it is the
visible signal that a cross-machine exchange is genuinely cross-machine.

## 4.4 Readiness detection derived from captures

Knowing when a freshly spawned CLI is ready for input is deceptively hard. The
first implementation matched the substring `"Tip"` — so any output containing
"the tip of the branch" declared the agent ready.

It now matches **multi-word phrases taken from real captured terminal output**,
stored as fixtures in the repo (`__fixtures__/claude-ready.txt`,
`opencode-boot.txt`, …). Two rules make it honest:

- **No invented markers.** Gemini has *no* ready markers, deliberately,
  because reaching its prompt needs an interactive sign-in nobody has captured
  yet. Plausible-looking strings would be the original bug again.
- **Blocked states are detected separately.** "Confirm folder trust", "use
  /login to sign in" — each maps to a message naming what a human must do.
  This is the case that actually bites: all four CLIs tested block on a trust
  dialog before their prompt, and without this the agent just looks hung.

## 4.5 Invite codes designed to be read aloud

`ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ"` — no vowels (so no code
accidentally spells a word), no `0/O` or `1/I/l`. Single-use and 72-hour by
default. A code can be checked without being spent, so the sign-up form can say
"this invite expired" before someone types a password.

## 4.6 Memory is ranked, not just matched

Project memory uses SQLite FTS5 with `bm25()` scoring, normalised and blended
with recency. It is honest about its limit: this is lexical search, so "use
pnpm" will not surface for "package manager". Semantic recall is a known gap,
not an accident.

## 4.7 Isolation that actually isolates

Agents default to `worktree` isolation — each gets
`<folder>.worktrees/<agentId>` on its own `logbridge/<agentId>` branch.
Discovering that this default was decorative is instructive: `resolveWorktree()`
silently degrades to a shared tree when the folder is not a git repository, and
none of the project folders were. Project creation now runs `git init` plus an
empty initial commit, because a worktree needs a HEAD to branch from. **The
setting was right for months and did nothing.**

---

# Part 5 — Security model

| Property | How |
|---|---|
| Server cannot read cross-machine agent traffic | X25519 + HKDF-SHA256 + AES-256-GCM, keys never leave the laptops |
| Server cannot execute anything | No spawn path exists in `apps/server`. Structural, not configured |
| Machines authenticate | Ed25519 signed challenge on `/node-ws`. Private key at `~/.workspace/key`, mode 0600, generated locally |
| Passwords | scrypt with a per-user salt |
| Browser identity | Server derives your user id from the session token. A client-supplied id is ignored — it was spoofable |
| Project access | Membership-scoped. Invite codes, owner/admin roles. A non-member probing a project id gets a 404, not a 403 — existence itself isn't leaked |
| Agent tool policy | Enforced by the runner on the owner's machine, not requested politely in a prompt |
| Terminal access | `/pty-ws` refuses non-loopback connections unless a token is set |
| Delegated work | Refused by default until the receiving machine's owner opts in |

Known limits, stated plainly: machine enrolment is **trust-on-first-sight** (an
unknown machine is registered the first time it signs a challenge;
impersonating a *known* machine is already rejected), and consent is currently
per-machine rather than per-request.

---

# Part 6 — What is built

## 6.1 The office

| | |
|---|---|
| Several people in one office at once, live positions | ✅ |
| Pixel map, 64×46 tiles, real tileset art | ✅ |
| Walk with WASD, run, zoom, agent roster strip | ✅ |
| Click an agent → hover card → inspector → Command Center | ✅ |
| Room chat with `@mention` autocomplete | ✅ |
| **Voice chat, room-based** — walk into a cabin, mic connects | ✅ |
| Voice chat, proximity-based | ❌ roadmap |
| Talking *to an agent* by voice | ❌ roadmap |

Voice is WebRTC peer-to-peer triggered by entering a room. Gather.town's real
behaviour is distance-based; that is the biggest remaining gap in the office
half.

## 6.2 Agents

| | |
|---|---|
| Create an agent from the browser — identity, sprite, folder, engine, briefing | ✅ |
| Runs a **real CLI** you already have installed | ✅ `claude` + `opencode` verified against captured output |
| Per-agent provider/model, live engine swap | ✅ |
| Workspace isolation: `shared` / `worktree` / `copy` | ✅ defaults to `worktree`, and now actually applies |
| Live terminal streamed to the browser | ✅ |
| Edit · note · pause · retire · delete · steer · move · clone | ✅ |
| Roles as definition files, 3-layer resolution | ✅ |
| Traces, per-agent git, context/budget monitor | ✅ |
| `starting` status, readiness-gated wake, blocked-state detection | ✅ |
| Budget caps enforced before the first run, hard wall-clock kill | ✅ |
| Survives a real network partition (Wi-Fi drop test) | ✅ |

## 6.3 Coordination

| | |
|---|---|
| Deterministic weighted routing — capability, role, availability, load, history | ✅ |
| Queues rather than failing when nothing is eligible | ✅ |
| Planner: goal → wave-ordered task graph with declared outputs | ✅ |
| Three completion gates: artifacts · acceptance checks · review | ✅ built, ⚠️ never yet run on real work |
| Circuit breaker (spend + repetition) | ✅ |
| Supervisor loop, auto-REASSIGN/RETRY only | ✅ |
| `@agent do X` → proposal → approve/edit/reject → runs | ✅ |
| Mid-task questions — agent stops, asks the room, continues on your answer | ✅ |
| Shared hive board (`board.md` prose + `tasks.json` kanban) | ✅ |
| File mailbox between same-machine agents, with wake/retry/dead-letter | ✅ |
| Invite codes and project-scoped membership | ✅ |
| GitHub mirror — repos→rooms, issues→tasks, PR/CI state | ✅ read-only |
| Triggers — scheduled and event-driven tasks | ✅ |

## 6.4 By the numbers

**756 tests passing** — 603 server · 148 runner · 5 web — plus 15 end-to-end
Playwright specs. Both packages typecheck. `CONTRACT.md` at v1.32, ~140 route
registrations, ~49k lines across the workspace.

---

# Part 7 — What isn't done

Stated honestly, because a list of features without this is marketing.

## 7.1 The three that matter

**1. The completion gates have never fired on real work.** Artifacts,
acceptance checks and review are built, unit-tested and wired — and the
database holds 0 artifacts, 0 review verdicts and 0 defined checks. They are
*unproven*, not done.

**2. Hand-made tasks bypass all three gates.** `POST /api/tasks` accepts title,
spec, budget and agent — it does not read `expectedOutputs`,
`acceptanceChecks` or `requiresReview` from the body. Only planner-generated
tasks carry them. A task you create from the office still completes on the
agent's word.

**3. It has never run on two real laptops.** Every cross-machine test is
in-process. Sealed delegation, consent, the meeting room — all coded, all
unit-tested, none of it has crossed a network. *This is the single
highest-value thing left.*

## 7.2 Also open

| | |
|---|---|
| **Acceptance checks can't run remotely** | The check runner is server-side and reports `skipped` when the workspace is on another machine. The gate that proves work is real doesn't work for the cross-machine case. It belongs in the runner |
| **Per-request consent** | Today it's a per-machine on/off. Approving individual jobs is specified but unbuilt |
| **Unverified CLIs** | `gemini`/`qwen`/`copilot`/`codex` need an interactive sign-in before their ready markers can be captured |
| **Voice has zero tests** | the only microphone surface in the product, and it has no automated coverage at all |
| **Semantic memory** | recall is lexical (BM25) — see §4.6 |
| **`node.status`** | declared in the protocol with no sender. Wire it or cut it |
| **`ptyGateway.ts`** | 1,115 lines doing eight jobs, with 16 silent catches |

## 7.3 Deliberately not building

| | Why |
|---|---|
| A message broker (Redis/NATS) | The durability requirement is "survive a laptop sleeping." Files do that without an always-on dependency |
| Agent-to-agent mesh | Hub-and-spoke is correct below ~60 agents |
| Contract Net auctions | *N+1* cold starts and two round-trips of billed tokens, to decide worse than free deterministic scoring. Built, tested, and shelved in `experimental/` with the reasoning written down |
| A progress percentage | No CLI reports how many steps remain. Step *counts* are real; a bar would invent its denominator |
| More than ~10 agents | Coordination failure rates climb with agent count |

---

# Part 8 — Running it

Full step-by-step in **[SETUP.md](SETUP.md)**. The shape:

**The server laptop.** Linux, sleep disabled (a sleeping laptop is an offline
server), running under systemd on boot. Pin `DB_PATH` explicitly — the default
is relative to the working directory. Back the SQLite file up daily and
*verify a restore*; an untested backup is not a backup.

**Network.** One Tailscale tailnet. The server gets a stable name. Nobody
exposes a port to the internet.

**Exposing the server** — both variables together, never one:

```bash
LOGBRIDGE_HOST=0.0.0.0 LOGBRIDGE_TOKEN=<a long random secret> npm run dev:server
```

With a token set, `/pty-ws` rejects any connection lacking it. Without one it
refuses every non-loopback connection outright. Read
[SECURITY-REVIEW.md](SECURITY-REVIEW.md) first.

**Each person's laptop.** `cd apps/runner && npm run dev`. Generates an Ed25519
keypair at `~/.workspace/key` on first run; the private key never leaves the
machine.

**Testing it with a friend, in order:** both runners connect → each create one
agent → walk into the meeting room and check voice → one real task each on your
own agent → **then the real test:** your agent delegates to theirs, their
machine asks *them* for consent, the work runs on *their* hardware, the result
comes back, and the server's database holds no plaintext of what was sent.

That last step is the one that proves the product. Nothing else exercises the
whole stack at once.

---

# Part 9 — What "done" means

Three claims no amount of code can close — each needs a person to actually do
it:

- [ ] the server runs unattended for a week
- [ ] both laptops reconnect cleanly after real sleep *(the Wi-Fi drop is
      tested; sleep isn't)*
- [ ] **a stranger watches the office for 60 seconds and correctly says what
      the team is doing**

That last one is the real test. If they can't, the office is decoration and
something in the state mapping is wrong. It needs someone who didn't build it.

---

## Further reading

| | |
|---|---|
| [CONTRACT.md](CONTRACT.md) | every message on every wire — the source of truth |
| [DECISIONS.md](DECISIONS.md) | settled trade-offs, and what would reopen each |
| [AGENT-SYSTEM.md](AGENT-SYSTEM.md) | how agents are run and reached, in depth |
| [SEALED.md](SEALED.md) | the cross-machine encryption scheme |
| [SECURITY-REVIEW.md](SECURITY-REVIEW.md) | read before exposing the server |
| [SETUP.md](SETUP.md) | full deployment steps |
| `/system-design.html` | the same architecture as 12 rendered diagrams |
