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
Cabin 0 (boss, biggest, corner office) = the GitHub repo admin. Cabins 1–3 = the other three. Open office = working, atrium upper = blocked, atrium lower = reviewing, meeting room = collaborating, cafeteria = idle, chill room = done.
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

### D21 — One central atrium instead of a review room and a lounge
The whole middle column (x36–43) is an open corridor running from the north corridor down into the cafeteria and chill room.
**Why:** two small rooms cost floor area and needed their own doors, while the building had no single walkable route from the offices to the social wing. The atrium solves circulation, separates the open office from the meeting room, and freed enough area to grow the cafeteria and chill room from 23 × 6 to 23 × 8. `blocked` and `reviewing` live in its upper and lower halves — both are "not actively coding", which suits a breakout space.
**Cost:** two zones share one undivided room, so they read slightly less distinctly than they did with walls between them.
**Would change it:** if the atrium gets visually noisy, drop a low partition at y23 to split it — the zone rects already sit either side of that line.

### D20 — The Wi-Fi-drop test is automated and runs on every commit
**Why:** it's the single test that distinguishes a distributed system from a demo. Everything built on top assumes the system tells the truth about what happened.
**Would change it:** nothing.

### D22 — A desktop app is a thin Electron wrapper around `apps/web`, not a second UI
`apps/desktop` loads the exact same page `apps/server` already serves at `/` — no separate codebase, no duplicated rendering logic. On first launch it asks for a server URL (like "sign in to a workspace" in Slack/Discord) and remembers it; it does not default to `localhost`, because most people running the desktop app are *not* the one machine hosting the server — they're connecting to somebody else's spare laptop over Tailscale.
**Why:** this is the same pattern Gather, Slack and Discord actually use — the desktop app is a convenience shell (dock icon, its own window, no browser tab to lose) around the identical web product, not a fork of it. Building a second UI would double the maintenance surface for zero new capability.
**Explicitly not built:** code signing, notarization, or auto-update. For 3-4 friends, an unsigned local build that each person runs once ("right-click → Open" past Gatekeeper) is the right amount of infrastructure. Revisit only if this ever leaves the friend group.
**Would change it:** wanting the desktop app to work fully offline with cached state — that's a real feature, not a wrapper concern, and would need its own design.

### D23 — Trust-on-first-sight machine registration, not real enrollment codes yet
`apps/runner` generates an Ed25519 keypair on first run and proves it holds the private key via a signed-challenge handshake — that part is real and matches SYSTEM.md §3a exactly. What's *not* real yet: the one-time enrollment code, issued from a web UI, that's supposed to gate a new machine's first connection. There's no such UI. Right now an unknown machine id is simply registered the first time it successfully signs a challenge, and its pubkey is pinned from that point on (impersonation of an *already-known* machine is still rejected — only the very first contact is unauthenticated).
**Why:** building the enrollment-code UI is real, separate work (a browser flow, a code-issuing endpoint, code expiry) that has nothing to do with proving the lease/heartbeat/reconnect/budget-kill mechanics, which is what this pass was actually for — see SYSTEM.md §3e: "prove leases before wiring in a real LLM," the same logic applies to enrollment vs. mechanics.
**Cost:** for the private tailnet this runs on, TOFU is an acceptable trust model — same threat level as SSH's default host-key handling. It would not be acceptable if this were ever reachable from the open internet.
**Would change it:** exposing the server beyond the tailnet, or wanting a real "who's allowed to join" gate before the chat/task UI exists to make that gate meaningful.

### D24 — `TaskRunner` runs against a pluggable `AgentHarness`, not a hardcoded child process; policy is a settings file written fresh on every spawn
`apps/runner/src/harness/types.ts` defines the boundary: `spawn(opts) -> AgentHandle` with an `AsyncIterable<AgentEvent>` (`output` / `tool_call` / `cost` / `done` / `error`) plus `interrupt()`/`kill()`. Two implementations satisfy it — `fakeHarness` (the controllable worker `wifiDrop.test.ts` and `officeZones.test.ts` run against) and `ptyHarness` (spawns whatever CLI the machine's owner already has installed and authenticated — `claude`/`codex`/`gemini` — as a real pseudo-terminal process via `node-pty`, matching D1's "each agent's model API key comes from its own owner's node" without a second, separate credential). The CLI defaults to the fake harness; a real one is opt-in only (`--harness real` / `AGENT_HARNESS=real`), so spending actual money is never accidental.

A PTY-wrapped CLI can't hook individual tool calls the way an SDK's `canUseTool` callback can — there's no interception point between the CLI and the tools it runs. So `allowTools`/`denyPaths` are expressed the way the CLI itself understands them: `ptyHarness` writes a project-scoped `.claude/settings.local.json` fresh from the *current* policy immediately before every spawn, never trusted to already be correct on disk from a previous run.

**Why:** the harness boundary keeps `TaskRunner` (leases, budget kill, honest process-observed status — all of M2) completely ignorant of which agent CLI is actually running. That's what let the Wi-Fi-drop test keep passing unmodified through this change, and what lets the same runner code path serve both the test suite and a real `claude` invocation.
**Verification gap, stated plainly:** `ptyHarness.ts`'s exact CLI flags (`-p`, `--output-format stream-json`) and its `emitLine()` field-detection match Claude Code's documented headless mode as of when it was written, but it has never been run against a real `claude` binary — no dev machine in this project has had the CLI or an API key installed. `ptyHarness.test.ts` proves the PTY plumbing itself (spawn/stream/kill/interrupt) against a fake CLI script, not the real one's actual output shape.
**Would change it:** getting access to a real `claude`/`codex`/`gemini` install to confirm the flags and `emitLine()` parsing before ever pointing this at a real budget.
