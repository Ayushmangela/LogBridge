# LogBridge

**A shared virtual office for humans and the AI agents running on their own laptops.**

Your agent runs on your computer, with your repos, your tools and your keys. Your friend's runs on theirs. A small always-on server on a spare laptop lets everyone — human and agent — see each other, talk, delegate work and collaborate, **without any machine ever executing anyone else's code.**

> **Local machines = AI execution and work.**
> **Central server = communication, coordination and shared state.**

Built by a few friends, for ourselves, to learn. Not a product.

---

## The idea

An office floor, where **a character's position is the truth about what it is doing**:

| Room | Means |
|---|---|
| 👔 Boss cabin *(corner, biggest)* | agents waiting on the repo admin |
| 🚪 Senior cabins ×3 | agents waiting on those three people |
| 🏢 Open office — desk pods | agents actively working right now |
| 🚶 Atrium | upper: blocked on CI or a build · lower: reviewing code |
| 🤝 Meeting room | agents on **two different laptops** working together |
| ☕ Cafeteria | idle, nothing to do |
| 🏓 Chill room | just finished a job |
| 🛎 Lobby | reception |

**Nothing moves unless something really happened.** There is no animation loop and no idle wandering — position is computed from real task state, so the office cannot show activity that isn't real.

Glance at it and you know the day: *cafeteria full = quiet · one person's cabin crowded = that person is the bottleneck · meeting room busy = the machines are talking to each other.*

---

## Architecture in one picture

```
   MY LAPTOP              CENTRAL SERVER            FRIEND'S LAPTOP
   ═════════              ══════════════            ═══════════════
   my agents run here ←→  routes · coordinates  ←→  their agents run here
   my repos               remembers · syncs         their repos
   my keys                knows who's online        their keys
                          NEVER EXECUTES

   AI EXECUTION           COMMUNICATION &           AI EXECUTION
   AND WORK               SHARED STATE              AND WORK
```

**The test for any new feature:** *does this make the central server execute someone's work?* If yes, it doesn't go in.

| Package | What it does |
|---|---|
| `packages/protocol` | envelope, task state machine, view types, sealed payloads — one zod definition shared by server, runner and browser |
| `apps/server` | Fastify + WebSocket + SQLite. `/ws` for browsers, `/node-ws` for machines (Ed25519 signed-challenge auth), lease sweep, orchestrator, GitHub mirror |
| `apps/runner` | the node daemon. Runs the CLI you already have installed, with a hard wall-clock budget kill — and survives a real network partition |
| `apps/web` | the office. Vanilla HTML/CSS/JS, no build step. Everything on screen comes from the live `WorkspaceView` |
| `apps/desktop` | a thin Electron shell around the identical page |

---

## Running it

```bash
npm run dev:server
```

Then open `http://localhost:8787`. For a real local agent:

```bash
cd apps/runner && npm run dev
```

Full machine setup, Tailscale and the spare-laptop server: **[SETUP.md](SETUP.md)**.

---

## The UI

Top nav: **Office Map · Workspace · Chat · Memory · Settings**, with the project switcher on the left (a dropdown listing every project, plus *show all* and *create*).

- **Office Map** — the pixel floor, a HUD with the on-floor roster, an agent hover card, and a full-height inspector panel per agent.
- **Workspace** — everything scoped to the *project*: Tasks (a five-column board) · Goals · Approvals · Workflows · Sequence · Triggers · Artifacts · Pull Requests · Graph.
- **Command Center** — everything scoped to *one agent*: **Terminal · Traces · Monitor · Git · Memory**, plus a `TASK` / `AGENT` action row and a Commands drawer.

That split is deliberate. The Command Center used to carry 21 tabs, about half of which rendered identical content for every agent — several never read the agent at all. Anything that answers a question about the *project* now lives in Workspace; anything server-scoped lives in Settings.

**Theme.** Warm-neutral dark, and every status colour is lifted from the carpet tile of the office room that status maps to — a "working" pill in the roster is the same sage as the desk carpet the character is standing on. The console and the floor describe state in the same colours instead of competing.

---

## What's built

| | |
|---|---|
| **Protocol, server, runner** | leases, heartbeats, budget kill, and the Wi-Fi-drop test — a real TCP partition, not a dropped socket |
| **Real agent execution** | `claude` and `opencode` verified against **captured real output**, not documentation. Tool policy enforced via a per-run settings file |
| **Talk to it** | `@agent do X` → proposal → approve / edit / reject → runs. Mid-task questions: the agent stops, asks the room, continues on your answer |
| **Cross-machine** | delegation **end-to-end sealed** (X25519/AES-256-GCM) — the server routes it and provably cannot read it. Per-request consent with `once`/`always`/`never`. Code review and context sharing |
| **GitHub mirror** | repos → rooms, issues → tasks, PR/CI state and commit pushes on the feed. Read-only and polled |
| **Orchestrator** | routes unassigned work by capability, availability and load; queues rather than failing |
| **Planning** | `/plan <goal>` — an agent breaks a goal into tasks, you approve, the orchestrator routes them |
| **Shared memory** | an agent starts a task already knowing what the team learned, including from agents on other machines |
| **Agent lifecycle** | create · edit · note · pause · retire · delete · steer · move · clone, plus traces, per-agent git and health |
| **Readiness** | a booting agent reports `starting`, not `idle` — a cold CLI takes 10–20s and used to look identical to a ready one |

**Verification:** 423 server · 129 runner · 5 web · 15 end-to-end = **572 tests**. Both packages typecheck. `CONTRACT.md` is at **v1.27**. 141 HTTP endpoints.

The e2e suite seeds a populated room (`e2e/seed.ts`) so the dense surfaces — Command Center, Workspace, inspector, board — are actually exercised. Before that seed existed, a whole tab shipped throwing a `ReferenceError` on its first line and nothing caught it.

---

## What's remaining

### Needs a decision, not code

**Authorization.** There is authentication but no *scoping*. `buildView()` takes `meId` and uses it only for avatar placement:

```ts
const projects = db.prepare("SELECT * FROM projects ORDER BY id").all();
```

Every signed-in user therefore receives every project, agent, task and memory, and signup auto-joins every existing project. For "me and a friend on a tailnet" that is a defensible model — but it must be a **decision**, either documented honestly as a trusted-team workspace, or replaced with real per-project membership filtering. Right now the code and the docs imply different things.

### Needs code

- **Enrolment (D23).** Machine registration is trust-on-first-sight: an unknown machine is registered the first time it signs a challenge. Impersonating an *already-known* machine is rejected; only first contact is unauthenticated. Real enrolment codes need a browser flow and a code-issuing endpoint. This is what gates ever running outside a private tailnet.
- **Six unverified providers.** `codex` · `gemini` · `qwen` · `crush` · `copilot` · `grok` · `kimi` run through the plain-text reader until someone captures their real output. Writing a parser from documentation is what produced three wrong guesses for `opencode`. See [PROVIDERS.md](PROVIDERS.md).
- **WebRTC voice.** ~674 lines, **zero tests**, and the only feature touching the microphone. Not broken, not verified. It needs tests or a decision that voice doesn't belong here.

### Blocked on something we don't have

| Gap | Blocked on |
|---|---|
| Semantic memory recall | an embedding model. Today it is SQLite FTS5/BM25 and the UI says so |
| `opencode` tool policy | no per-run mechanism upstream; the harness refuses rather than pretending |
| Forward secrecy | a double ratchet. This is a sealed box, not a ratchet |
| A real progress **percentage** | permanently impossible — no CLI reports how many steps remain. Step *counts* work; a bar would be inventing its denominator |
| Exact push boundaries | polling sees commits, not pushes. Grouping is inferred in a 10-minute window and labelled as an approximation |

### Not features — untested claims

These cannot be closed by writing code:

- [ ] the server runs unattended for a week
- [ ] both machines reconnect cleanly after real laptop sleep *(the Wi-Fi drop is tested; sleep isn't)*
- [ ] **a stranger watches the office for 60 seconds and correctly says what the team is doing**

That last one is the real test. If they can't, the office is decoration and something in the state mapping is wrong. It needs a person who didn't build this.

---

## The documents

| Doc | What |
|---|---|
| **[PROJECT.md](PROJECT.md)** | **Start here.** The whole project in one document — what it is, what's built, architecture, what's broken, the roadmap, deployment, and how to test it with a friend |
| **[AGENT-SYSTEM.md](AGENT-SYSTEM.md)** | **How agents are run, reached and coordinated** — the constraint that shapes everything, the two live channels, the wake rule, assignment, and what's remaining |
| **[AGENT-PROMPTING.md](AGENT-PROMPTING.md)** | The six paths that put text in front of an agent, what breaks on each, and the design that holds under all of them |
| **[CONTRACT.md](CONTRACT.md)** | The data the office and the system exchange. **Source of truth — never edit alone, bump the version, add a changelog line** |
| **[DECISIONS.md](DECISIONS.md)** | Settled questions and what would reopen them. **Read before proposing a change** |
| **[SETUP.md](SETUP.md)** | Repo, Tailscale, server laptop, per-machine setup |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Monorepo layout, security model, subsystem deep-dive |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | Working rules |
| **[SECURITY-REVIEW.md](SECURITY-REVIEW.md)** | Findings and the fixes that closed them |

**Subsystems:** [SYSTEM.md](SYSTEM.md) (server/runner/protocol) · [OFFICE.md](OFFICE.md) (renderer) · [ORCHESTRATOR.md](ORCHESTRATOR.md) · [MEMORY.md](MEMORY.md) · [SEALED.md](SEALED.md) · [TRIGGERS.md](TRIGGERS.md) · [WORKSPACE.md](WORKSPACE.md) · [PROVIDERS.md](PROVIDERS.md)

**Office art:** [OFFICE-MAP.md](OFFICE-MAP.md) · [DESIGN-GUIDE.md](DESIGN-GUIDE.md) · [ASSETS.md](ASSETS.md)

---

## Rules we don't break

1. **Agents run only on their owner's machine.** The server has no execution path.
2. **The runner is the only network peer on each machine.** Agents reach the world through it or not at all.
3. **Nothing renders that no event caused.**
4. **No agent gets automatic access to anyone else's computer.** First contact always asks the owner.
5. **Budget caps before the first real run.** Not after the bill.
6. **A new provider ships `verified: false`** until someone captures its real output.

---

## Vocabulary

| Term | Means |
|---|---|
| **Central server** | The always-on process on the spare laptop. Routes and remembers. Never executes |
| **Node / machine** | Someone's laptop, enrolled with a keypair |
| **Node runner** | The daemon on each machine. Holds the connection and enforces policy. **Not the agent** |
| **Agent** | A real AI process doing real work in a real repo on its owner's machine |
| **Task** | One unit of work with a spec, budget, acceptance criterion and lifecycle |
| **Lease** | A 60s claim on a task, renewed by heartbeat. Expiry means the machine went away |
| **Envelope** | One typed, validated message on the wire |
| **Capability** | Something an agent can do *in its environment* — `run_integration_tests` |
| **Zone** | A work state, mapped to a physical room in the office |
| **Cabin** | A private office belonging to one real person. Cabin 0 is the boss cabin |
