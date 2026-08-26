# Browser2 Phase 2 — Tasks tab, and the ask-me check — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

A new **Tasks** tab in the Command Center, beside Commands/Activity/Memory/Triggers, that shows **that agent's tasks** — current, queued, recent — from `Room.tasks` already in the view. The tab lists tasks where `t.agentId === a.id || t.agentName === a.name`, newest-first (the view’s order), each row with `title`, `state` (10 px uppercase), and `relativeTime(t.startedAt ?? t.createdAt)`. An honest empty state reads *“No tasks for this agent yet — queued work, current runs and recent finishes appear here.”* The list rebuilds on every `view` broadcast, so a new task appears without a refresh.

A minimal **ask-me surface** was added inside the same tab: if `chatLog` contains a `ChatMessage` with `ask.taskId === t.id`, a small `askBox` (`#fffbf0` / `#f5d99b`) shows `ask.text` under that task. This is not a second inbox — it is a filtered view of the existing `ChatMessage.ask` flow.

## Method and what was rejected

- **Filtered `Room.tasks`**, not a new fetch — `Room.tasks` is already the full Kanban board (`tasksForProject` capped at 100, newest first). Filtering client-side on `agentId`/`agentName` is rendering, not deciding, so it respects invariant 2. Rejected a separate `GET /api/agents/:id/tasks` — it would duplicate the view and need its own limit/order.
- **One `ccRenderTasks` function**, same `cmd-row`/`cmd-main`/`cmd-name`/`cmd-desc` structure as `ccRenderActivity`/`ccRenderMemory`, so the tab visually matches the other Command Center tabs. `textContent` everywhere, `innerHTML` never touches task titles.
- **Ask-me check first:** searched `apps/server` for `human.ask`/`human.answer`, `ask` handling in `gateway.ts` (`human.ask` → `human.answer` → `task.status`), and `chatLog` in `apps/web/index.html` (`ChatMessage.ask` with `approve`/`edit`/`reject`/`answer`). The M4 mid-task question flow **already exists end-to-end**: an agent stops, `ChatMessage.ask` is broadcast, the room sees `ask.options`, the human answers via `ClientMessage.answer`, the runner resumes. Building a second, parallel “ask me” inbox would be a genuine bug (two places to answer the same question), not a feature. Chose to surface the existing `ask` as a small box under the relevant task in the Tasks tab, rather than a new tab or a duplicate store.

## What I clicked and what I observed

Verified in Chrome 151 via `Input.dispatchMouseEvent` at element centers:

- With an agent `dev-api` that had 1 `working` task and 1 queued `submitted` task for it (from `Room.tasks`), clicked **dev-api** → Command Center opened, tabs read `Commands · Activity · Memory · Triggers · Tasks`.
- Clicked **Tasks** → 2 rows, newest first, each with `title`, `STATE` pill, and `Xs ago`; the `working` task showed its title and `working` state, the queued task showed `submitted`.
- Clicked **qa-api** (no tasks) → Tasks tab still active, empty state read *“No tasks for this agent yet…”* (honest, not blank), counter not needed.
- Triggered a mid-task question (agent `dev-api` in `needs_input` with a `ChatMessage.ask` containing `approve, answer` for its task) → Tasks tab for `dev-api` showed the task row plus the `askBox` with the question text (`Proposed: "..." or mid-task question`); the same question also appeared in **Chat** as the existing flow — confirming it is the same `ask`, not a second copy. Answering from Chat cleared the `ask` and the Tasks tab’s `askBox` disappeared on the next view (the task moved from `submitted` to `working`).
- **Ask-me is a re-skin, not new work:** evidence is `apps/server/src/gateway.ts:251` (`human.ask` → `human.answer` relay), `apps/web/index.html` `chatLog` `ask` handling (`answerAsk` → `ws.send({type:"answer",...})`), and `Room.activity` showing `human.answer`. The Tasks tab’s `askBox` is a filtered view of `chatLog.find(m => m.ask.taskId === t.id)`, not a new store.

**Could not reach:** a `task.result` → `failed` → `canceled` transition that would test the `Closed` column mapping, and a flood of 100 tasks (view cap) — both would need a long-lived DB with many tasks, not producible from the current dev store without seeding.

## From Stream B — nothing requested

`Room.tasks` already carries every task; no new field was needed. The `ask` flow already existed, so no new endpoint was requested. Nothing was added to `apps/server/**` or `packages/protocol/**`.

## Git

Only `git add apps/web/index.html BROWSER2-PHASE-2-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
