# Shared Virtual Workspace for Humans and Local AI Agents

A pixel office where several people **and the AI agents running on their own laptops** work the same software projects together.

> **Local machines = AI execution and work.**
> **Central server = communication, coordination and shared state.**

Your agent runs on your computer with your repos, your tools and your keys. Your friend's runs on theirs. A small always-on server on a spare laptop lets everyone — human and agent — see each other, talk, delegate work and collaborate, **without any machine ever executing anyone else's code.**

Built by 3–4 friends, for ourselves, to learn. Not a product.

---

## What it looks like

An office floor, and where a character stands tells you what's actually happening:

| Room | Means |
|---|---|
| 👔 **Boss cabin** *(corner office, biggest — the repo admin's)* | that person's office. Agents waiting on **them** stand here |
| 🚪 **Senior cabins ×3** | the other three people's offices, same rule |
| 🏢 **Open office** — 4 desk pods | agents actively working right now |
| 🚶 **Atrium** *(central corridor)* | upper half: blocked on CI or a build · lower half: reviewing code |
| 🤝 **Meeting room** | agents on **two different laptops** working together |
| ☕ **Cafeteria** | idle, nothing to do |
| 🏓 **Chill room** | just finished a job |
| 🛎 **Lobby** | reception, where people arrive |

**Nothing moves unless something really happened.** There is no animation loop, no wandering, no idle motion — position is computed from real task state, so the office cannot show activity that isn't real.

Glance at it and you know the day: *cafeteria full = quiet · **one person's cabin crowded = that person is the bottleneck** · atrium busy = stuck or under review · meeting room busy = the machines are talking to each other.*

---

## The documents

**Start here:**

| Doc | Who | What |
|---|---|---|
| **[PHASES.md](PHASES.md)** | both | The six-week plan, two parallel tracks, six merge points. **Read this first** |
| **[CONTRACT.md](CONTRACT.md)** | both | The data both halves exchange. **Source of truth — never edit alone** |
| **[SETUP.md](SETUP.md)** | both | Repo, Tailscale, server laptop, per-machine setup |

**Build docs — one each:**

| Doc | Who | What |
|---|---|---|
| **[OFFICE-MAP.md](OFFICE-MAP.md)** | friend | Building the office map and art in Tiled. No code |
| **[DESIGN-GUIDE.md](DESIGN-GUIDE.md)** | whoever designs | Which software, the workflow, and the generated greybox starting point |
| **[ASSETS.md](ASSETS.md)** | whoever designs | Review of the downloaded art packs — what's usable, what's missing, licenses |
| **[OFFICE.md](OFFICE.md)** | you | The Pixi renderer that draws the office from live state |
| **[SYSTEM.md](SYSTEM.md)** | you | Protocol, server, runner, real agents, cross-machine collaboration |

**Reference:**

| Doc | What |
|---|---|
| **[PLAN.md](PLAN.md)** | Full architecture and research. The long one — read when you need the *why* |
| **[DECISIONS.md](DECISIONS.md)** | Settled questions and what would reopen them. **Read before proposing a change** |

---

## Architecture in one picture

```
   MY LAPTOP              CENTRAL SERVER            FRIEND'S LAPTOP
   ═════════              ══════════════            ═══════════════
   my agents run here ←→  routes · coordinates  ←→  their agents run here
   my repos               remembers · syncs         their repos
   my keys                knows who's online        their keys
   my tools               knows who can do what     their tools
                          NEVER EXECUTES

   AI EXECUTION           COMMUNICATION &           AI EXECUTION
   AND WORK               SHARED STATE              AND WORK
```

**The test for any new feature:** *does this make the central server execute someone's work?* If yes, it doesn't go in.

---

## Vocabulary

Use these words consistently — most integration confusion is two people meaning different things.

| Term | Means |
|---|---|
| **Central server** | The always-on process on the spare laptop. Routes and remembers. Never executes |
| **Node / machine** | Someone's laptop, enrolled with a keypair |
| **Node runner** | The daemon on each machine. Holds the connection and enforces policy. **Not the agent** |
| **Agent** | A real AI process doing real work in a real repo on its owner's machine |
| **Agent card** | An agent's identity: name, owner, machine, capabilities, status |
| **Task** | One unit of work with a spec, budget, acceptance criterion and lifecycle |
| **Lease** | A 60s claim on a task, renewed by heartbeat. Expiry means the machine went away |
| **Envelope** | One typed, validated message on the wire |
| **Capability** | Something an agent can do *in its environment* — `run_integration_tests` |
| **Zone** | A work state, mapped to a physical room in the office |
| **Tile** | 32 × 32 px. The map is 64 × 40 tiles = 2048 × 1280 px |
| **Atrium** | The central corridor. The building's spine and the only route from the offices to the social wing |
| **Cabin** | A private office belonging to one real person. Cabin 0 is the boss cabin — biggest room, the repo admin's |
| **Slot** | Stable position within a zone, so sprites don't overlap or jump |
| **Delegate** | Ask another person's agent to do work on their machine |
| **Greybox** | The placeholder map — right dimensions, no art |

---

## Rules we don't break

1. **Agents run only on their owner's machine.** The server has no execution path.
2. **The runner is the only network peer on each machine.** Agents reach the world through it or not at all.
3. **Nothing renders that no event caused.**
4. **No agent gets automatic access to anyone else's computer.** First contact always asks the owner.
5. **Budget caps before the first real run.** Not after the bill.

---

## Status

**Phase 0 and the first slice of Phase 1 are up, tested, and verified end to end.**

- `packages/protocol` — envelope, task state machine, view types, zod schemas. 13/13 tests green.
- `apps/server` — Fastify + WebSocket + SQLite. Two gateways: `/ws` for browsers, `/node-ws` for machines (Ed25519 signed-challenge auth, lease sweep, task-lifecycle handling, late-result reconciliation). 4/4 tests green.
- `apps/runner` — **the node daemon actually runs real child processes now.** Generates a real keypair, authenticates, publishes agent cards, accepts task offers, heartbeats, enforces a hard wall-clock budget kill, and survives a genuine network partition — verified with a real TCP chaos proxy, not just a dropped socket. 3/3 tests green, including the Wi-Fi-drop test every planning doc points to as the one that matters.
- `apps/web` — the office renderer, drawing real per-tile sprites from `office.json`'s own layers (all 9 tilesets, generically). Agents and humans render strictly from the live `WorkspaceView` stream — nothing is simulated.
- `apps/desktop` — a thin Electron shell around the same page, for anyone who'd rather have a dock icon than a browser tab.

**20/20 tests pass across the whole monorepo. Zero vulnerabilities in production dependencies** (`npm audit --omit=dev`).

Not done yet: real enrollment codes (machines currently trust-on-first-sight — see `DECISIONS.md` D23), a real LLM harness (the runner spawns a controllable fake worker, deliberately — see `SYSTEM.md` §3e), chat/spec-proposal UI, cross-machine delegation, GitHub mirror. The web renderer's minimap thumbnail is the one remaining flattened image (a deliberate, documented exception — recompositing a 240×140 thumbnail from real sprites buys nothing).

**Run it:**
```bash
npm run dev:server                                    # terminal 1
cd apps/runner && npm run dev                          # terminal 2 — a real local agent
curl -X POST localhost:8787/debug/offer-task \
  -H 'content-type: application/json' \
  -d '{"agentId":"<see the runner log for its agent id>","title":"test","spec":"{\"durationSeconds\":5}"}'
```
Then open `http://localhost:8787` in a browser, or launch the desktop app (`cd apps/desktop && npm run dev`) and point it at that same URL.

### Two ways in — same product, like Gather/Slack/Discord

| | Website | Desktop app |
|---|---|---|
| What it is | `apps/server` serving `apps/web` at `/` | `apps/desktop` — an Electron shell around the identical page |
| Where state lives | On the server, always | Also on the server — the app has none of its own |
| First run | Just open the URL | Asks once for the server's address, then remembers it |
| Install | Nothing | `cd apps/desktop && npm run build:mac` → unsigned `.app` in `dist/` |

There's one product. The desktop app doesn't add features — it adds a dock icon and its own window so the workspace isn't living in a browser tab. See `DECISIONS.md` D22 for why it's built this way, and deliberately not code-signed or auto-updating yet.
