# Browser2 Phase 3 — Steer, traces, and the employee panel — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

Two new tabs in the Command Center, beside Tasks:

- **Steer** — a single-line `input` (`prefer pnpm, check staging first…`) plus **Steer next task** button. Text is `POST`ed to `/api/agents/:id/steer` as `{text}`; on `200` the input clears and a green `Steered — next task will include it.` flash appears, on `404` it degrades to `Steer not available yet — server has no steer endpoint.` The label and note say `One line of context for the next task — it lands in the prompt, not in a running process. This is not a terminal.` Draft text is kept in `window._ccSteerDraft` per `agentId` so a view broadcast mid-typing does not reset the input.
- **Traces** — `Tool calls and step boundaries from task.event rows — what the agent actually did, not a live terminal.` On open it `fetch`es `GET /api/agents/:id/traces?limit=50`; while loading it shows `Loading traces…`, on `404` it degrades to `Traces not available yet — server has no traces endpoint…`, on empty it shows `No tool calls yet…`, and on success it renders each `ev` as a `cmd-row` with `kind` and `summary` (first 120 chars). No terminal, no prompt, no input box.

Both tabs use `textContent`, `innerHTML` never touches wire data.

## Method and what was rejected

- **Steer as prompt injection, not PTY:** the text is sent as JSON to be merged into the *next* task’s `spec`, not written to a running process. The button says `Steer next task`, not `Send`, and the note explicitly says `not in a running process`. Rejected a `textarea` that looked like a terminal or an `xterm.js` embed — that would imply a live shell on someone’s laptop over the network, which the brief forbids until enrolment (D23). The current implementation is the honest, buildable half of “steer” without the remote-shell risk.
- **Traces from `task.event` rows, not a new log:** `task.event` is already appended by the runner (`runInBash` tool calls, `step` boundaries) and excluded from `activity` as noise. Fetching `GET /api/agents/:id/traces` would return those rows filtered by the agent’s task ids; the tab degrades to the known 404 message when the endpoint is absent, rather than inventing a second store. Rejected a WebSocket stream of live output — it would need a PTY on the runner and a sign-in, both blocked.
- **Draft kept across broadcasts:** like the triggers tab, the steer input’s value is saved on `oninput` to `window._ccSteerDraft` and restored on `ccRenderSteer` if `agentId` matches, so a broadcast that rebuilds the panel does not steal focus. Rejected an optimistic `steeredText` in the view — the server’s next task `spec` is the source of truth, and the UI shows a transient green flash, not a local copy.

## Two-surface split — recommendation, not a rewrite

`FEATURE-INVENTORY.md:60` is correct that the reference has an **orchestrator console** (ten tabs: terminal, monitor, tasks, ask me, triggers, memory, graph, activity, commands, workers) and an **employee panel** (terminal/git/messages/traces + pause/halt/steer), while LogBridge gives every agent the same tabs. The cheapest honest split that does **not** need a server field is to treat `role:"planner"` as the orchestrator — `AgentRole` already has `planner`, `agents.role` is stored and the roster already groups by role. Employee panels would then show `traces`/`tasks`/`steer`/`pause` and the orchestrator would show `triggers`/`memory`/`activity`/`graph`/`monitor`. A new `isOrchestrator` boolean would be more explicit but would require Stream B to add a column and a way to set it, which cannot be done from the browser. **Do not restructure unasked** — the reviewer owns the call. If the split is kept as-is, the only cost is that nine agents see tabs that are meaningless for them (e.g., `triggers` on a `qa` agent) and the useful per-agent controls have no dedicated surface. Leaving it alone is legitimate and better than shipping a worse layout because a document asked for it.

## What I clicked and what I observed

Verified in Chrome 151 via `dispatchMouseEvent` at element centers:

- Clicked **dev-api** → Command Center tabs now read `Commands · Activity · Memory · Triggers · Tasks · Steer · Traces`.
- Clicked **Steer** → saw the note and a single-line input `e.g. prefer pnpm…` plus `Steer next task`; typed `check staging first`, clicked the button → `POST /api/agents/agt_1/steer` returned `404` → inline red `Steer not available yet — server has no steer endpoint.`; input kept `check staging first` and focus, no view was mutated.
- Clicked **Traces** → `Loading traces…` → `GET /api/agents/agt_1/traces?limit=50` returned `404` → `Traces not available yet — server has no traces endpoint. What is here is the honest, buildable part…`; no exception in the render loop, office still roams and animates.
- Regression: **Tasks** still shows that agent’s tasks, **Memory** still filters, **Triggers** still toggles, **Commands/Activity** unchanged. No blank panels beyond the honest empty states.

**Could not reach:** a successful `200` for steer/traces, because Stream B has not yet implemented `POST /api/agents/:id/steer` or `GET /api/agents/:id/traces`. The `404` paths are the honest states and are verified.

## From Stream B — nothing added

No new `POST /api/agents/:id/steer` or `GET /api/agents/:id/traces` was added — Stream A owns only `apps/web/index.html`. Both tabs degrade via the `404` branches and log nothing to the server. If Stream B later adds those endpoints in the shape above (`{text}` for steer, `?limit` for traces returning `{traces:[{kind,summary}]}`), the tabs will work without a browser change.

## Git

Only `git add apps/web/index.html BROWSER2-PHASE-3-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
