# Browser3 Phase 5 — Monitor tab — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

A new **Monitor** tab in the Command Center (employee surface) that shows per-agent live use, plus dispatch and engine controls:

- **Context** bar — `contextUsed / contextLimit` with a real denominator the runner reports (`a.contextUsed` / `a.contextLimit` or `a.context.used/limit`), rendered as a `bar` with `pct = used/limit`. When the machine is `offline` it shows `Unknown — machine offline` rather than a stale number; when the fields are absent it shows `No context data yet — shows as work runs` (honest, not a fake 0%). This is the bar the brief calls honest, unlike a progress bar.
- **Tool calls, working directory, engine** — three `row(Tool calls, Working dir, Engine)` cards. Tool calls from `(a.toolCalls ?? a.task.steps)`; directory from `a.cwd ?? a.folder`; engine from `a.provider` (+ `model` if present). Offline shows `Unknown` for all three.
- **Dispatch** — a `Dispatch` input (`What should this agent do next?`) + `Dispatch` button that `POST`s to `/debug/submit-task` (`{projectId, title, spec, requiredCapability: null}`) — the existing task-creation path. On `200` it clears and shows `Queued` or `Dispatched to <agent>` in green; on error it shows the server’s own message. No new server field was added.
- **Engine picker** — a `select` filled from `room.machines.find(m.id===a.machineId).providers` (degrades to `Unknown — machine offline` / `No providers reported` and disables when offline), plus **Change engine** button that `confirm()`s `Change <name>'s engine to <provider>? This restarts its harness…` and `POST`s to `/api/agents/:id/engine` (`{provider}`). The button and note say `Changing provider/model restarts this agent’s harness. The agent will briefly go offline.` On `404` it degrades to `Engine change not available yet — server has no engine endpoint.` No silent restart.

The tab is on the **employee** surface (`getCCTabs`).

## Method and what was rejected

- **Context bar is not a progress bar:** the denominator is `limit` from the runner, not an invented total. Rejected reusing the same bar for task progress (no CLI reports a total, so the task card already shows `elapsed` + `step count`). The monitor bar is `used/limit`, the task card is `elapsed/min` + `step N`.
- **Offline degrades to `Unknown`, not stale:** `isOffline = !machine?.online` is checked first for every field. Rejected caching the last known `contextUsed` when the machine goes offline — that would imply the number is still current while the agent is unreachable (D28). `Unknown` is the correct reading for an offline machine and is also the honest state for a non-git/shared workspace.
- **Dispatch via `POST /debug/submit-task`:** the only task-creation path that already exists and is project-scoped. Rejected a new `POST /api/agents/:id/dispatch` that would duplicate it and need a new body shape. The dispatch input is single-line (not a terminal) and its placeholder says `What should this agent do next?` — it creates work, it does not type into a running process.
- **Engine picker warns:** the `confirm()` and the note `Changing provider/model restarts…` are the trap the brief calls out. Rejected a silent `onchange` on the `select` — a control that restarts a running agent without saying so is a trap.

## What I clicked and what I observed

In Chrome 151 via `dispatchMouseEvent`:

- Clicked an employee `dev-api` (online) → tabs `Tasks · Steer · Traces · Monitor` (+ floor tabs for planner). Clicked **Monitor** → saw `Context` `No context data yet…` (no `contextUsed` in the view yet — Stream B Phase 7), `Tool calls: 0` / `Working dir: /Users/.../repo` / `Engine: opencode`, plus `Dispatch` input and `Engine` select with `opencode (current)` and other providers.
- Typed `triage flakies` in **Dispatch**, clicked **Dispatch** → `POST /debug/submit-task` `200` → green `Queued — orchestrator will route it.` and input cleared; a new task `triage flakies` appeared in `Room.tasks` and in the **Tasks** tab for that agent.
- Picked `claude` in the engine select, clicked **Change engine** → `confirm()` showed `Change dev-api's engine to claude? This restarts its harness…` → confirmed → `POST /api/agents/agt_1/engine` returned `404` → red `Engine change not available yet — server has no engine endpoint.`; the agent did not go offline, no optimistic provider switch.
- Clicked an agent on an **offline** machine (`dev-off`) → **Monitor** showed `Context: Unknown — machine offline`, `Tool calls: Unknown`, `Working dir: unknown`, `Engine: Unknown`, `Dispatch` still present but `Engine` select disabled with `Unknown — machine offline`. No stale numbers.
- Regression: **Tasks**, **Traces**, **Steer**, **Commands** still render; `ccTab` stayed valid when switching from an employee on `Monitor` to a planner (planner has no `Monitor` — `getCCTabs` reset `ccTab` to `Commands`).

**Could not reach:** a live `contextUsed`/`limit` bar that moves as work runs, because Stream B Phase 7 (context usage, tool-call counts, engine change) is not yet in the view. The `404` degraded states are the honest ones and are verified.

## From Stream B — nothing added

No new `context`/`toolCalls`/`engine` field was added; the tab reads `a.contextUsed`/`a.contextLimit`/`a.toolCalls`/`a.cwd`/`a.provider` if they ever appear, otherwise `Unknown`/`No data yet`. The two `404` endpoints (`POST /api/agents/:id/engine` and the `traces` fetch already in Phase 3) are the ones the tab expects; nothing was added to `apps/server/**` or `packages/protocol/**`.

## Git

Only `git add apps/web/index.html BROWSER3-PHASE-5-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
