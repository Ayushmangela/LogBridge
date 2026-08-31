# LogBridge — the whole project, in one document

**A shared virtual office where you and your friends work alongside the AI
coding agents running on your own laptops.**

You walk around a pixel office. So do your friends. So do the agents. You talk
by voice when you're in the same room. Your agent and your friend's agent hand
work to each other across machines — and the server routing it between them
cannot read what they said.

This document is the single place to see **what it is, what's built, what
isn't, how to run it, and what comes next.** Everything here was checked
against the source.

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
   installed CLI (`claude`, `opencode`) and their own keys. The server has no
   execution path at all.
2. **Nothing on screen moves unless a real event caused it.** No idle
   animation. A character's position *is* the task state.
3. **Nobody commands anyone else's machine.** Across people it is always
   *request → consent → run on the owner's hardware.*

## 1.2 Why an office, and not a dashboard

Position encodes state, so you read the room at a glance instead of reading a
table:

| Room | Means |
|---|---|
| 👔 Boss cabin | agents waiting on the repo admin |
| 🚪 Senior cabins ×3 | agents waiting on those three people |
| 🏢 Open office | agents actively working right now |
| 🚶 Atrium | upper: blocked on CI · lower: reviewing code |
| 🤝 Meeting room | agents on **two different laptops** working together |
| ☕ Cafeteria | idle |
| 🏓 Chill room | just finished |
| 🛎 Lobby | reception |

*Cafeteria full = quiet day. One cabin crowded = that person is the
bottleneck. Meeting room busy = the machines are talking to each other.*

## 1.3 Who it's for

**2–3 people using it daily, up to ~10 who might drop in to watch.** One spare
laptop as the always-on server. Private network (Tailscale). Not a product —
built by friends, for ourselves.

That number matters: hub-and-spoke coordination is right at this size, and most
of the "what we deliberately didn't build" decisions below follow from it.

---

# Part 2 — What is built

## 2.1 The multiplayer office

| | Status |
|---|---|
| Several people in one office at once, live positions | ✅ |
| Pixel map, 64×46 tiles, real tileset art | ✅ |
| Walk with WASD, run, zoom, agent roster strip | ✅ |
| Click an agent → hover card → inspector → Command Center | ✅ |
| Room chat with `@mention` autocomplete | ✅ |
| **Voice chat, room-based** — walk into a cabin or the meeting room, mic connects | ✅ |
| **Voice chat, proximity-based** (hear people as you walk near them) | ❌ roadmap |
| Talking *to an agent* by voice | ❌ roadmap |

Voice today is **WebRTC peer-to-peer, triggered by entering a room**
(`PRIVATE_ROOMS` — four cabins plus the meeting room). Gather.town's real
behaviour is distance-based; that difference is the biggest remaining gap in
the "office" half of the product.

## 2.2 Your agents

| | Status |
|---|---|
| Create an agent from the browser — identity, sprite, folder, engine, briefing | ✅ |
| Runs a **real CLI** you already have installed and authenticated | ✅ `claude` + `opencode` verified against captured output |
| Per-agent provider/model, live engine swap | ✅ |
| Workspace isolation: `shared` / `worktree` / `copy` | ✅ (see §4.2 — the default is wrong) |
| Live terminal streamed to the browser | ✅ |
| Edit · note · pause · retire · delete · steer · move · clone | ✅ |
| Traces, per-agent git, context/budget monitor | ✅ |
| **`starting` status** so a booting agent isn't mistaken for a ready one | ✅ |
| Budget caps enforced before the first run, hard wall-clock kill | ✅ |
| Survives a real network partition (Wi-Fi drop test) | ✅ |

## 2.3 Agents working together — your agent + your friend's agent

**This is the heart of the product, and it is built.**

| Message | What happens |
|---|---|
| `delegate.request` → `delegate.decision` → `delegate.result` | Your UI agent asks their dev agent to do something. **Their** machine decides yes/no, then runs it on **their** hardware with **their** keys |
| `review.request` → `review.result` | Your agent asks theirs for a review, gets a verdict back |
| `context.share` | Your agent passes findings across so theirs doesn't redo the work |
| Shared project memory | Both agents read what the team has learned, including from the other machine |

**All of it is end-to-end encrypted** — X25519 + AES-256-GCM, HPKE base mode,
using only Node's built-in crypto. The server routes it, logs it, and draws the
office from it, and **cannot read the payload**.

That claim is tested the only way that means anything:
`apps/runner/src/sealedDelegation.test.ts` dumps every table in the server's
database and greps for the plaintext.

**Consent:** a machine refuses delegated work until its owner opts in
(`acceptDelegations`, off by default). Grant modes `always` / `never` /
ask-every-time exist in the database.

## 2.4 Coordination

| | Status |
|---|---|
| Orchestrator routes unassigned work by capability, availability, load, past success | ✅ |
| Queues rather than failing when nothing is eligible | ✅ |
| `@agent do X` → proposal → approve/edit/reject → runs | ✅ |
| Mid-task questions — agent stops, asks the room, continues on your answer | ✅ |
| Shared hive board (`board.md` prose + `tasks.json` kanban) | ✅ |
| File mailbox between agents on the *same* machine, with wake/retry/dead-letter | ✅ |
| GitHub mirror — repos→rooms, issues→tasks, PR/CI state | ✅ read-only |
| Triggers — scheduled and event-driven tasks | ✅ |

## 2.5 By the numbers

**572 tests** — 423 server · 129 runner · 5 web · 15 end-to-end. Both packages
typecheck. `CONTRACT.md` at v1.27. 141 HTTP endpoints.

---

# Part 3 — Architecture

## 3.1 The packages

| | |
|---|---|
| `packages/protocol` | one zod definition of every message, shared by server, runner and browser |
| `apps/server` | Fastify + WebSocket + SQLite. `/ws` browsers, `/node-ws` machines (Ed25519 signed challenge), `/pty-ws` terminals |
| `apps/runner` | the daemon on each laptop. Spawns the CLI, enforces policy, hard budget kill |
| `apps/web` | the office. Vanilla HTML/CSS/JS, **no build step** |
| `apps/desktop` | thin Electron shell around the identical page |

## 3.2 The constraint everything follows from

> **Agents are one-shot CLI processes, not services.** `claude -p` runs a turn
> and exits. Nothing sits in a loop polling a mailbox.

So there are exactly **two ways** to reach an agent:

- **inject** — a terminal session is already live. Cheap, keeps its context.
- **spawn** — no session. Cold start; the message becomes the prompt.

A message is therefore *not something an agent receives* — **a message is a
reason to run an agent.** Everything else is bookkeeping around those two verbs.

## 3.3 The two channels

| | Same machine | Across machines |
|---|---|---|
| Transport | files (`outbox/` → `inbox/`) | sealed WebSocket envelopes |
| Speed | 1.5s router tick | near-instant |
| Encrypted | no | **yes — server can't read it** |
| Survives restart | yes, it's on disk | no |
| Retry / dead-letter | yes | no |
| Consent | n/a | yes |

These are genuinely different guarantees, not one feature with two transports.
**Plan:** keep both, hide them behind one `sendToAgent(who, what)` so there is
one thing to maintain from the outside. (§5.2)

## 3.4 The wake rule

```
message routed to an inbox
   ↓
terminal live?  ── yes ──▶ inject a short notice (keeps its context)
   ↓ no
machine online? ── yes ──▶ spawn, wait for the CLI's own readiness signal,
   ↓ no                    then send. 45s ceiling.
leave it, record `undeliverable` — never pretend it arrived
```

## 3.5 Who plans what

| Scope | Model |
|---|---|
| **Your own agents** | you, or your commander agent, direct them. It's your machine |
| **Across people** | **request → consent → run on the owner's machine.** Never command |

The reason is ownership: a commander that directs everyone's agents is spending
your friend's money on your friend's laptop by decree. That contradicts the same
principle the server follows by never executing anything.

**The humans are the orchestrators.** You're all in the office, seeing who's
busy, talking by voice. That's what makes this different from a fully
autonomous framework.

---

# Part 4 — What's broken or missing

## 4.1 The sharpest bug

**Readiness detection matches the word `"Tip"`.**

```js
READY_MARKERS = [..., "Tip", "commands"];
looksReady = (data) => READY_MARKERS.some(m => data.includes(m));
```

An unanchored substring match. Any CLI output containing *"the tip of the
branch"* or *"multiple commands"* declares the agent ready. It gates three
behaviours: the `starting` status, prompt seeding, and the wake path.

**And it has never been run against a real CLI** — every terminal test uses a
fake process. Highest-priority fix.

## 4.2 New agents share one folder by default

The Add Agent dialog defaults to `isolation: 'shared'` — agents edit the **same
working tree** with no branch. Git conflicts announce themselves; concurrent
edits to one tree don't. This is how the shared board once got "two design
systems collided". **One-line fix:** default to `worktree`.

## 4.3 Verification is a sentence, not a gate

The commander is *told* to check a subordinate's output. Nothing enforces that
the claimed files exist before a task is marked done.

## 4.4 Still open

| | |
|---|---|
| **Project scoping** | every signed-in user currently receives every project, agent, task and memory. `buildView()` takes `meId` and uses it only to place your avatar. Fine for 3 friends; not fine at 10 |
| **Machine enrolment** | trust-on-first-sight — an unknown machine is registered the first time it signs a challenge. Impersonating a *known* machine is already rejected |
| **Per-request consent** | today it's a per-machine on/off. Approving individual jobs is specified but unbuilt |
| **Six unverified CLIs** | `codex`/`gemini`/`qwen`/`crush`/`copilot`/`grok`/`kimi` run through a plain-text reader |
| **Voice has zero tests** | ~674 lines, the only microphone surface |
| **Semantic memory** | recall is keyword (BM25). "use pnpm" won't surface for "package manager" |
| **Never tested on two real laptops** | every cross-machine test is in-process |

---

# Part 5 — Roadmap

## 5.1 Next — make it trustworthy (do these first)

1. **Two real laptops, two real CLIs, one real task.** Your UI agent delegates
   to your friend's dev agent, for real. Everything in §2.3 is tested in
   isolation and never together. *This is the single highest-value thing left.*
2. **Fix readiness** (§4.1) — capture real CLI output to a fixture, derive
   markers from the capture, anchor to line start.
3. **Default to `worktree`** (§4.2) — one line.
4. **Verification gate** (§4.3) — a task carries `expectedOutputs`; completion
   checks the files exist before `done`.

## 5.2 Then — make it smaller and clearer

5. **One `sendToAgent()`** in front of both channels (§3.3).
6. **Per-request consent** — your friend approves individual jobs.
7. **Split `ptyGateway.ts`** — 1,100 lines, 20 silent catches, doing eight jobs.
8. **Decide project scoping** — document it as a trusted-team model, or build
   real per-project filtering.

## 5.3 Then — the office half

9. **Proximity voice** — volume by distance anywhere on the map, keeping rooms
   for genuinely private calls. This is what makes it feel like Gather.
10. **Talk to an agent by voice** — speak, transcribe, send as a task; the
    agent's reply read back. Everything downstream already exists.
11. **Agent memory you can see and edit** in the office.

## 5.4 Deliberately not building

| | Why |
|---|---|
| A message broker (Redis/NATS) | durability requirement is "survive a laptop sleeping" — files do that. A broker adds an always-on dependency to a system whose premise is your own machine |
| Agent-to-agent mesh | hub-and-spoke is right below ~60 agents |
| Contract Net auctions | *N+1* cold starts and two round-trips of billed tokens, to decide worse than free deterministic scoring. Built, tested, shelved in `experimental/` |
| A progress percentage | no CLI reports how many steps remain. Step *counts* are real; a bar would invent its denominator |
| More than ~10 agents | coordination failure rates climb with agent count |

---

# Part 6 — Deployment

Full step-by-step is in **[SETUP.md](SETUP.md)**. The shape:

## 6.1 The server laptop

1. **Put Linux on it** and disable sleep — a sleeping laptop is an offline
   server.
2. **Run on boot** via systemd. Pin `DB_PATH` explicitly: the default is
   relative to the working directory and moves if that ever changes.
3. **Daily backups** of the SQLite file, and *verify a restore* — an untested
   backup is not a backup.

## 6.2 Network — Tailscale

Everyone joins one tailnet. The server gets a stable name; nobody exposes a
port to the internet, and there are no tunnels or public hostnames.

## 6.3 The security setting that matters

The server binds **loopback only by default** (`127.0.0.1`). This is
deliberate: `/pty-ws` accepts `spawn` then raw keystrokes, so binding it wide
open would put an **unauthenticated interactive shell** on every network
interface.

To let your friends reach it:

```bash
LOGBRIDGE_HOST=0.0.0.0 LOGBRIDGE_TOKEN=<a long random secret> npm run dev:server
```

**Both together.** With a token set, `/pty-ws` rejects any connection that
doesn't supply it. Without one, it refuses every non-loopback connection
outright. Read [SECURITY-REVIEW.md](SECURITY-REVIEW.md) before exposing it.

## 6.4 Each person's laptop

```bash
cd apps/runner && npm run dev
```

Generates an Ed25519 keypair at `~/.workspace/key` (mode 0600) on first run.
**The private key never leaves the machine.** Then a small `config.yaml` naming
your agents, their roles, and their repo folders.

## 6.5 Testing it with your friend — in order

1. **Both runners connect.** The office shows two machines online, and the
   meeting room becomes available (it only unlocks with two *distinct* owners
   online).
2. **Each create one agent.** You: a UI agent. Them: a developer agent. Confirm
   both appear on the floor.
3. **Talk.** Walk into the meeting room together and check voice connects both
   ways.
4. **One real task each**, on your own agent, end to end.
5. **The real test — cross-machine.** Your UI agent delegates to their dev
   agent. Watch for: their machine asks *them* for consent; the work runs on
   *their* hardware; both characters appear in the meeting room; the result
   comes back. Then confirm the server's database holds no plaintext of what
   was sent.

Step 5 is the one that proves the product. Nothing else exercises the whole
stack at once.

---

# Part 7 — What "done" means

The three claims no amount of code can close — each needs someone to actually
do it:

- [ ] the server runs unattended for a week
- [ ] both laptops reconnect cleanly after real sleep *(the Wi-Fi drop is
      tested; sleep isn't)*
- [ ] **a stranger watches the office for 60 seconds and correctly says what
      the team is doing**

That last one is the real test. If they can't, the office is decoration and
something in the state mapping is wrong. It needs a person who didn't build it.
