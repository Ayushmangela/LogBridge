# Decisions
### Settled questions, and what would reopen them.

Read this before proposing a change. If your idea is here, the argument already happened — bring **new information**, not the same argument.

Format: **decision · why · what would change my mind.**

---

## Architecture

### D1 — AI agents run only on their owner's machine
The central server has no execution path. Not disabled — absent.
**Why:** it's the entire point of the project. It's what makes lending an agent safe and what makes this different from a hosted platform.
**Would change it:** nothing. This is the axiom.

### D2 — All cross-machine traffic goes through the server, never peer-to-peer
Even though Tailscale gives every machine a reachable address.
**Why:** laptops sleep. Peer-to-peer means a message to a sleeping machine is simply lost, with no ordered history to render the office from. The server earns its place by being *always on* and *the one log*.
**Would change it:** large artifact transfers becoming painfully slow. Then add a direct path for **bytes only**, keeping control messages on the server.

### D3 — The node runner is separate from the agent process
The runner holds the socket, the key and the policy. The agent has none of them.
**Why:** merging them puts the network-facing surface inside the thing executing model output. It's the difference between "an agent wasted an hour" and "an agent pushed to main and posted my `.env`."
**Would change it:** nothing.

### D4 — Server-authoritative state + an append-only event log. No CRDTs.
**Why:** nothing here is concurrently edited by multiple writers. CRDTs cost a lot and buy nothing. The log is also what makes the office provably honest and what enables replay later.
**Would change it:** adding collaborative document editing.

### D5 — Full view snapshot on every change, no deltas
**Why:** a few KB, four people. Deltas are a week of bugs for zero benefit.
**Would change it:** the view exceeding ~200KB, or more than ~20 concurrent viewers.

---

## Stack

### D6 — TypeScript everywhere
**Why:** the envelope schema is the heart of the system and must be identical on server, runner and browser. One zod module imported by all three gives compile-time *and* runtime validation from one definition. That's worth more than any per-tier language optimum.
**Would change it:** an agent harness that only ships a Python SDK — and even then, only inside the adapter.

### D7 — SQLite, not Postgres
**Why:** four users. Relational state, append-only log and JSON bodies in one file. Single process means in-process fan-out; no broker needed.
**Would change it:** multiple server processes, or write contention showing up in profiling. Neither will happen at this size.

### D8 — No Docker
**Why:** ceremony at this scale. One directory, one config, `npm start`, under systemd.
**Would change it:** moving the server to a VPS with other services on it.

### D9 — Tailscale only. No public hostname, no tunnel, no webhooks.
**Why:** zero public exposure, free HTTPS via `tailscale serve`, works from any café. It also deletes GitHub App registration, tunnels and webhook endpoints from the project entirely — GitHub is polled instead.
**Would change it:** someone who genuinely cannot install Tailscale. Then Cloudflare Tunnel.

### D10 — GitHub is read-only from the server; agents write with their human's own credentials
**Why:** a server with write access to everyone's repos is one bad day from being a commit bot, and it makes the server the most valuable target in the system despite holding no code. Local writes are also more honest about accountability.
**Would change it:** nothing.

---

## Product

### D11 — Position is a pure function of state
Agents are *placed*, never animated. Humans move freely.
**Why:** it makes "the office shows real activity" structural rather than aspirational. There is no code path that produces motion without an event, so fake activity is impossible to render.
**Would change it:** nothing. This is the second axiom.

### D12 — Hybrid: the four cabins belong to people, every other room is a work state
Cabin 0 (boss, biggest, corner office) = the GitHub repo admin. Cabins 1–3 = the other three. Open office = working, review room = reviewing, meeting room = collaborating, lounge = blocked, cafeteria = idle, table tennis = done.
**Why:** pure state-mapping loses *who*. Pure person-mapping loses the glance-read of the day. The hybrid keeps both — and routing `needs_human` to the specific person's cabin is strictly better than one generic room, because "three agents in Sam's office" says *Sam is the bottleneck*, which is actionable.
**Cost:** two extra contract fields — `HumanView.cabin` and `AgentView.zoneAnchor`. Worth it.
**Would change it:** growing past ~6 people, where there aren't enough cabins.

### D13 — Delegation targets are chosen by capability + machine, never by role
`run_integration_tests@sams-mbp`, not "be my researcher."
**Why:** a role is just a prompt, and prompts are free — a local subagent is faster and cheaper. What another machine actually has is *environment*: its branch, its database, its credentials, its hardware, its accountable human.
**Would change it:** nothing. This is the reason cross-machine delegation exists at all.

### D14 — Delegation depth limit of 1
An agent working on a delegated task may request reviews and ask humans, but cannot delegate further.
**Why:** eliminates loops, fan-out storms and runaway spend for almost no capability loss — the coordinator can just make a second request.
**Would change it:** real traces showing a repeated case where depth 2 is genuinely needed. Then raise to 2, never higher.

### D15 — `request_review` is a separate flow from `delegate_task`
**Why:** a review returns a *judgement*, not work. Different state machine, different verification, different UI. Collapsing them is cheap now and expensive to separate later.
**Would change it:** nothing.

### D16 — Natural language in, typed contract out
Humans talk to agents in plain sentences; the agent proposes a structured spec back for confirmation.
**Why:** under-specified tasks are the top documented cause of multi-agent failure, but forcing humans to fill forms is the wrong fix. Move the specification work to the agent, where it belongs.
**Would change it:** nothing.

### D17 — No voice, video or screenshare. A `callLink` per room instead.
**Why:** a self-hosted SFU plus TURN is weeks of work and the flakiest possible component on a home laptop. Vendors whose entire business is voice still get complaints about it.
**Would change it:** actually missing it after two months of using the thing.

---

## Process

### D18 — Zero file overlap between the two tracks
Friend owns `public/assets/**`. You own everything else.
**Why:** zero shared files means zero merge conflicts. Not "few" — zero.
**Would change it:** nothing.

### D19 — Greybox map on day 2, art later
**Why:** it unblocks the entire renderer immediately, and the real art is a drop-in replacement. Standard game-dev practice, and the highest-leverage scheduling decision in the plan.
**Would change it:** nothing.

### D20 — The Wi-Fi-drop test is automated and runs on every commit
**Why:** it's the single test that distinguishes a distributed system from a demo. Everything built on top assumes the system tells the truth about what happened.
**Would change it:** nothing.
