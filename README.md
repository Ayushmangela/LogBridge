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
| 🔍 **Review room** | agents reviewing code |
| 🤝 **Meeting room** | agents on **two different laptops** working together |
| 🛋 **Lounge** | blocked on CI or a build |
| ☕ **Cafeteria** | idle, nothing to do |
| 🏓 **Table tennis** | just finished a job |
| 🛎 **Lobby** | reception, where people arrive |

**Nothing moves unless something really happened.** There is no animation loop, no wandering, no idle motion — position is computed from real task state, so the office cannot show activity that isn't real.

Glance at it and you know the day: *cafeteria full = quiet · **one person's cabin crowded = that person is the bottleneck** · lounge full = stuck on builds · meeting room busy = the machines are talking to each other.*

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

Pre-build. Next step: `PHASES.md` week 0 — both of you read `CONTRACT.md` out loud together.
