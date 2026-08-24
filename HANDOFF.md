# Handoff — prompts for continuing this work

Eight self-contained prompts. Each is written to be pasted into a **fresh
session with zero context**. They are ordered by dependency, but 2, 7 and 8
can be done at any time.

**Read "House rules" below before running any of them.** They are what make
this codebase coherent; work that ignores them will not fit.

---

## House rules — non-negotiable

**1. Never commit or push.** The repo owner does all git operations. Finish the
work, run the tests, then hand over a ready-to-paste
`git add … && git commit -m "…"` command. Do not stage, commit, or push.

**2. `CONTRACT.md` is the source of truth** for anything crossing the wire.
Changing a message or view shape means: edit `packages/protocol/src/`, bump the
version at the top of `CONTRACT.md`, and add a changelog row saying *why*.

**3. The server decides; the UI renders.** Invariant 2. `zone` (`view.ts`) and
activity wording (`activity.ts`) are computed server-side specifically so the
browser cannot invent a story the event log doesn't support. Keep new
derivations on the server.

**4. Full snapshot, no deltas, and keep it bounded.** Invariant 1. Anything
added to `Room` must be capped like `tasks` (100), `memories` (30) and
`activity` (30).

**5. Verify against reality, never against your own assumptions.** This
project has been bitten three times by parsers written from documentation:
- Claude's text is at `message.content[].text`, not a top-level `text`
- opencode's `reason: "tool-calls"` is an *intermediate* step, not a failure
- opencode's tool envelope is `tool_use` with args at `part.state.input`, not
  `tool` / `part.input`

Each looked right and silently did the wrong thing. When integrating anything
external: **capture real output into `apps/runner/test-support/` and write the
parser against that file.** Never write a fixture to match your code.

**6. Never fake data to make a screen look finished.** If something isn't
built, render a labelled placeholder saying what's missing and why (there are
existing examples in `apps/web/index.html` — search for `class="temp"`).
Existing deliberate honesty you must not "fix" by faking:
- the Current Task progress bar shows **elapsed time**, not completion, because
  a task reports start and finish and nothing between
- chat history is client-side only; a late joiner sees nothing until the next
  message

**7. State gaps plainly** in code comments, docs, and your summary. Do not
describe something as working when only part of it is.

**8. Verify before claiming.** Run `npm run test --workspaces` and
`npm run typecheck --workspaces` from the repo root. For UI work, drive the
real app in a browser and confirm the change; don't ask the user to check.

### Orientation (30 seconds)

| Read | For |
|---|---|
| `CONTRACT.md` | every wire shape |
| `DECISIONS.md` | why things are the way they are (D1–D27) |
| `PHASES.md` | the six original milestones M1–M6 |
| `UI-PHASES.md` | the UI rebuild, phases 1–7 |
| `PROVIDERS.md` | the agent-CLI registry |
| `MEMORY.md`, `SEALED.md`, `ORCHESTRATOR.md` | those three subsystems |

Run it: `npm run dev:server` (port 8787), then in `apps/runner`:
`npx tsx src/cli.ts start` (fake harness — safe, no spend).

---

# Prompt 1 — Add Agent, part B: runtime registration + the dialog

> **Context.** LogBridge is a virtual pixel office where each character is a
> real AI coding agent running on someone's own machine. I want to create an
> agent from the browser: pick a provider (Claude Code / OpenCode / Codex / …),
> pick a model, name it, and have it appear on the office floor.
>
> **Already done — do not rebuild:**
> - `apps/runner/src/harness/providers.ts` — the CLI registry. Each provider
>   has `command`, `buildArgs`, `parseLine`, `policy`, `verified`, `models`.
>   `detectInstalled()` reports which are actually on `PATH`.
> - Multi-agent machines work. `task.offer` carries `agentId`, the runner
>   resolves the addressed agent, and each agent gets its own harness.
>   `--agents-file <json>` declares several agents at startup.
>
> **Build:**
> 1. An `agent.create` protocol message (server → node) carrying name, role,
>    provider, model, capabilities, cwd, allowTools/denyPaths.
> 2. A runner handler that registers the agent at runtime and publishes its
>    card — so it appears in the office without a restart.
> 3. A server endpoint the browser calls, which routes to the right machine.
> 4. The dialog in `apps/web/index.html` (the Agents view already has a
>    labelled "not built yet" placeholder — replace it). Providers not
>    installed on that machine must be shown as unavailable, not offered.
>
> **Critical constraint.** This lets a browser start a real CLI on someone's
> machine. That must be **opt-in per machine, defaulting to off**, exactly like
> `acceptDelegations` in `apps/runner/src/connection.ts` — copy that pattern
> including the refusal path. Read `DECISIONS.md` D1 and D3 first; they are the
> reason this gate exists.
>
> Also: a provider whose `policy` is `"none"` cannot enforce allowTools/
> denyPaths. `ptyHarness` already refuses to spawn those unless
> `allowUnsandboxed` is set. Surface that honestly in the dialog rather than
> letting someone create an agent that will refuse every task.
>
> **Verify:** create an agent from the browser, watch it appear in the sidebar
> roster and on the office floor, give it a task, watch it run. Then confirm a
> machine that hasn't opted in refuses.

---

# Prompt 2 — Agent name tags and task bubbles on the office floor

> **Context.** LogBridge draws a pixel office where each character is a real AI
> agent. Right now you can't tell who is who without clicking. I want a name
> label under each agent and a speech bubble showing what it's doing —
> "Researching…", "Testing…" — like a Gather-style office.
>
> **Where:** `apps/web/index.html` (single file, Pixi.js 7, all rendering is in
> the `<script>` block). `renderView()` reconciles sprites against
> `room.agents`; `createAgentSprite`/`updateAgentSprite` own each character.
>
> **The data already exists** in every view broadcast — `AgentView.name`,
> `AgentView.task.title`, `AgentView.status`. No protocol change needed.
>
> **Build:** a name tag under each agent sprite, and a bubble above it when
> `task` is non-null, showing a truncated title. Both must move with the sprite
> and survive the existing tween.
>
> **Watch for:** four agents in one desk pod will overlap. Work out a stacking
> or offset rule and say what you chose. Bubbles must not cover other agents'
> names. Also check zoom — text drawn at scale 1 inside a scaled container goes
> blurry or tiny; `PIXI.Text` resolution matters here.
>
> **Verify:** run the app, offer a task via
> `POST /debug/offer-task {agentId, title}`, and screenshot the floor with an
> agent working. Zoom in and out to confirm the text stays legible.

---

# Prompt 3 — Mid-task questions: an agent asks, a human answers

> **Context.** In LogBridge, AI agents run real coding CLIs on people's
> machines. A human can approve a task before it starts, but once it's running
> the agent cannot ask anything — if it needs a decision it just guesses or
> fails.
>
> **What exists:** `human.ask` and `human.answer` are fully defined in
> `packages/protocol/src/bodies.ts` and have **zero handlers anywhere**.
> `ChatMessage.ask` and the approve/reject UI already work for the
> *pre-task* proposal flow — read `gateway.ts`'s chat handler and the chat
> panel in `apps/web/index.html` before starting; you are extending that
> pattern, not inventing one.
>
> **The real blocker:** the harness cannot express "I am asking something".
> `AgentEvent` in `apps/runner/src/harness/types.ts` has
> `output | tool_call | cost | done | error` and no question kind. Start there.
>
> **Build:** a new `AgentEvent` kind for a question, plumbed through
> `taskRunner.ts` → `connection.ts` → `human.ask` → the server → a chat message
> with `ask` set → the browser's existing answer buttons → back to the waiting
> agent.
>
> **Design decisions to make explicitly and state:**
> - What happens to the task while it waits? (`blocked` and `input-required`
>   both exist in `TaskState` — pick one and justify it.)
> - Does the wall-clock budget keep running while it waits for a human? A
>   budget that expires because someone was at lunch is a bad failure. Decide
>   and say why.
> - How does the answer reach a CLI that has already been spawned? For most
>   providers you cannot inject stdin mid-run. If this can only work for some
>   providers, **say so** rather than shipping something that silently does
>   nothing for the others.
>
> **Verify:** end to end with a real question and answer, and add a test.

---

# Prompt 4 — Editing a proposed task before approving it

> **Context.** In LogBridge you mention an agent in chat (`@dev-api fix the
> login bug`) and it proposes a task with **Approve** and **Reject** buttons.
> There is no way to *adjust* the proposal — only take it or leave it.
>
> **What exists:** `ClientMessage.answer` already accepts
> `choice: "approve" | "edit" | "reject" | "answer"` with an optional `text`,
> and the server handles `approve` and `reject` in
> `apps/server/src/gateway.ts`. `edit` is accepted and silently ignored. The
> chat UI renders whatever `ask.options` contains.
>
> **Build:** the `edit` path — an inline editable field on a proposal, and
> server handling that updates the task's title/spec before offering it.
>
> **Constraints:** a task may only be edited while `submitted`. Once a runner
> has accepted it, editing must be refused — read
> `packages/protocol/src/task-state.ts`; the state machine is enforced, not
> advisory. Record the edit in the event log so the activity feed can show that
> the human changed the task, and add wording for it in
> `apps/server/src/activity.ts`.
>
> **Verify:** propose, edit, approve, watch the *edited* text run.

---

# Prompt 5 — Per-request consent for cross-machine work

> **Context.** LogBridge agents on different machines can delegate work to each
> other, end-to-end encrypted. Today consent is per-machine: a machine either
> accepts delegated work or doesn't (`--accept-delegations`, default off). I
> want per-request approval — the owner sees what's being asked and chooses.
>
> **Read first:** `SEALED.md`, and `DECISIONS.md` D26 (which says plainly that
> per-request consent is speced and not built) and D13–D15.
>
> **What exists:**
> - `delegate.request` / `delegate.result` work end to end, sealed. The server
>   routes but **cannot read** the payload — there's a test that dumps the
>   whole database and greps for the plaintext. Do not break that.
> - `delegate.decision` (`approved | denied | once | always | never`) is fully
>   defined and has **zero handlers**.
> - The `grants` table exists in `apps/server/src/db.ts` and is **never
>   queried** — it's there for exactly this.
>
> **Build:** an incoming delegation surfaces to the target machine's owner for
> a decision; `once` runs it, `always`/`never` persist a grant in `grants`,
> `denied` refuses. Then honour stored grants without re-asking.
>
> **The hard part, think it through:** the server cannot read the sealed
> payload, so it cannot show the human what the work actually *is*. Only the
> receiving machine can decrypt it. So either the prompt is shown on the
> receiving side after decryption, or the requester includes a plaintext
> summary alongside the sealed body — which leaks something to the server.
> **Pick one, and write down the trade-off in `SEALED.md`.** Do not quietly
> weaken the encryption to make the UI easier.
>
> **Verify:** two runners, a real delegation, approve once, then `always`, and
> confirm the second request doesn't ask again.

---

# Prompt 6 — Code review and context sharing between agents

> **Context.** LogBridge agents can delegate *work* to each other across
> machines. Two other collaboration flows are fully speced and completely
> unbuilt: asking another agent for a **review** (which returns a judgement,
> not work) and **sharing context** (a decision, a finding, a constraint).
>
> **What exists, with zero handlers:** `review.request`, `review.result`,
> `context.share`, `context.ack` — all in `packages/protocol/src/bodies.ts`.
>
> **Read first:** `DECISIONS.md` D15 explains why review is deliberately a
> separate flow from delegation and not a special case of it. Respect that.
> `SEALED.md` covers how cross-machine payloads are encrypted — review findings
> and shared context are content, so they must be sealed the same way
> delegation payloads are.
>
> **Build:** both flows, following the delegation pattern in
> `apps/runner/src/connection.ts` (`delegate()` / `handleDelegateRequest()`)
> and `apps/server/src/nodeGateway.ts`.
>
> **Also decide:** a review verdict and a shared constraint are both things the
> team should arguably *remember*. `MEMORY.md` describes the shared memory
> store, which already accepts `kind: "decision" | "fact"`. Consider writing
> them there, and say why you did or didn't.
>
> **Verify:** two runners, a real review round trip with findings, and a shared
> context item the receiving agent can recall.

---

# Prompt 7 — GitHub mirror (M6)

> **Context.** LogBridge is a virtual office for AI coding agents. It currently
> knows nothing about the repositories the work relates to. M6 in `PHASES.md`
> is connecting it: rooms from repos, tasks from issues, PR and CI state on the
> board.
>
> **Read first:** `DECISIONS.md` **D10** and **D9**, which constrain this
> heavily and are not negotiable:
> - GitHub is **read-only from the server**. Agents write using their own
>   human's credentials, from their own machine. A server that can write to
>   everyone's repos is one bad day from being a commit bot.
> - **No webhooks, no public hostname** — the server is Tailscale-only.
>   GitHub is **polled**, not pushed to.
>
> **Build:** polling that maps repos → rooms and issues → tasks, plus PR/CI
> state surfaced on the board (`Room.tasks`, `BoardTask` in `CONTRACT.md`).
> `AgentView.githubRef` already exists in the contract and is always null —
> populate it.
>
> **Watch for:** rate limits (poll interval and conditional requests), and not
> duplicating a task every poll — `tasks.idem` exists and is UNIQUE; use it.
>
> **This is the most detachable phase** per `PHASES.md`. If it grows, ship
> repos → rooms first and say what you left.

---

# Prompt 8 — Smaller gaps worth closing

> Four independent items. Do them individually; each is small.
>
> **a) Chat history isn't persisted.** The server broadcasts chat but never
> replays it, so anyone opening the app sees an empty room until the next
> message. Chat is already written to the `events` table in
> `apps/server/src/gateway.ts` — add recent messages to the view (capped, like
> `activity`) or replay on connect. Keep invariant 1 in mind. Remove the
> "client-side only" caveat comments in `apps/web/index.html` once it's real.
>
> **b) Office legend and filters** — UI-PHASES.md phase 7. A status legend and
> filters for people/agents/tasks. Filters are client-side only; the server
> keeps sending the full snapshot.
>
> **c) `claude` is installed but not authenticated.** `PROVIDERS.md` documents
> its format as verified from an *unauthenticated* capture, so the `tool_use`
> branch is written from the documented shape rather than an observation. If
> the machine owner has run `claude /login`, re-capture:
> `claude -p "create a file x.txt containing HI" --output-format stream-json
> --verbose > apps/runner/test-support/claude-tools.sample.jsonl`, then verify
> the tool branch against it and update `PROVIDERS.md`. **Ask the owner to log
> in — do not attempt to authenticate anything yourself.**
>
> **d) Seven providers are unverified.** `codex`, `gemini`, `qwen`, `crush`,
> `copilot`, `grok`, `kimi` have commands and args but run through a plain-text
> reader, so no tool calls are visible. For any that are actually installed,
> capture real output and write a real parser. Follow the "Adding a verified
> provider" recipe in `PROVIDERS.md`, and update the test that asserts exactly
> which providers claim `verified` — it exists to stop that claim drifting.

---

## Known-broken / deliberately unfinished

Do not "fix" these by faking them; they are honest gaps.

| Thing | Why |
|---|---|
| Current Task progress bar shows elapsed, not % complete | tasks report start and finish, nothing between |
| Activity feed has no commit aggregation | PRs/issues/CI land via the mirror; "pushed 4 commits" grouping needs a per-push window the poll loop doesn't model yet |
| `opencode` tool policy not enforced | it has no per-run mechanism this runner knows; the harness refuses rather than pretending — see `PROVIDERS.md` |
| No enrolment, no accounts | trust-on-first-sight, `DECISIONS.md` D23 |
| Orchestrator does not decide *what* work exists | routing only; decomposition needs an LLM — `ORCHESTRATOR.md` |
| Memory recall is BM25, not semantic | no embedding model available — `MEMORY.md` |
| No forward secrecy for a sealed-message recipient | sealed box, not a ratchet — `SEALED.md` |
| Seven providers unverified (`codex`…`kimi`) | plain-text readers; capture real output only for CLIs actually installed |
| Chat is broadcast/replayed for **all** rooms to every browser | the server has no notion of which room a browser is in — membership is only implied by `position`. The client filters to the active room, so nothing wrong is displayed, but the data is still sent. Real scoping needs browser room membership |

---

## Status of the eight prompts (updated after completion)

1. **Add Agent** ✅ runtime registration + dialog, opt-in per machine
2. **Name tags + task bubbles** ✅ resolution-3 text, stacked bubbles
3. **Mid-task questions** ✅ input-required + budget pause + PTY stdin answer
4. **Edit proposals** ✅ submitted-only edits, re-proposed to the room
5. **Per-request consent** ✅ hold/approve/always/never via grants table
6. **Reviews + context sharing** ✅ sealed both ways, local-only context store
7. **GitHub mirror** ✅ repos→rooms, issues→tasks, PR/CI feed (commit agg. left)
8. **Smaller gaps** ✅ a) chat replay, b) legend/filters · c) d) blocked as noted above
