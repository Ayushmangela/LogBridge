# Browser3 Phase 6 — Git tab — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

A new **Git** tab in the Command Center (employee surface) that shows the selected agent’s workspace git state, honest about offline and shared:

- **Branch, clean/dirty, ahead/behind, changed files, recent commits** — fetched from `GET /api/agents/:id/git` (expected `{branch, clean, ahead, behind, changedFiles:[], commits:[]}`) and rendered as `row()` cards. While loading it shows `Loading git…`; on `404` it degrades to `Git not available yet — server has no git endpoint.`; on success but missing `branch`/`commits` it shows `No git data — not a git repo or no commits yet.` The tab never renders an empty branch name — it says why.
- **Offline:** `isOffline = !machine?.online` checked first. If the agent’s machine is offline the tab immediately shows `Unknown — machine offline. The agent is unreachable, so git state is not shown.` — not an error, and never numbers cached from earlier (D28). The fetch is not even attempted when offline.
- **Shared isolation:** `a.isolation === 'shared'` checked next. If true it shows `Shared-isolation — this agent has no branch of its own; it works directly in the folder.` — plain language, not a blank branch.

The tab is on the **employee** surface (`getCCTabs`), so a `planner` orchestrator does not see a per-worktree git panel that would be meaningless for the floor.

## Method and what was rejected

- **Fetch, degrade, never cache:** `GET /api/agents/:id/git` is the honest endpoint Stream B Phase 6 will provide; until then the tab shows the `404` empty state. No `localStorage` of the last known `branch` — that would imply the number is still current while the agent is offline, which D28 forbids. The `isOffline` guard returns before the fetch, so no stale commit list is ever shown.
- **Shared checked before fetch:** `isolation === 'shared'` is a property of the `AgentView` that already arrives in the view. Checking it locally avoids a useless `404` and explains the empty branch name before the server is even asked. Rejected rendering an empty `Branch: ` row.
- **No new server field added:** `AgentView.folder`/`isolation` already tell whether the workspace is a git repo; the git state itself is not in the view, so the tab fetches it. Nothing was added to `apps/server/**` or `packages/protocol/**`.

## What I clicked and what I observed

In Chrome 151 via `dispatchMouseEvent`:

- Clicked an employee `dev-api` on a **live** machine with `isolation: worktree` → **Git** tab initially showed `Loading git…` then `GET /api/agents/agt_1/git` returned `404` → `Git not available yet — server has no git endpoint.` No exception, office still animates.
- Clicked the same agent after setting its machine `online=0` (via the view’s `machine.online` flag toggled in the dev DB, then `buildView` rebroadcast) → **Git** immediately showed `Unknown — machine offline.` without a fetch; no `branch` or `ahead` numbers.
- Changed the agent’s `isolation` to `shared` in the DB, rebroadcast → **Git** showed `Shared-isolation — this agent has no branch…` before any fetch; `branch` never rendered as empty.
- Regression: **Monitor** still shows `Unknown — machine offline` for offline, `Traces` still degrades to `404`, `Tasks` still shows that agent’s tasks, and the `planner` orchestrator does not see `Git` (it sees `Commands`/`Activity`/`Memory`/`Triggers`/`Tasks`).

**Could not reach:** a live `200` with `branch: main, clean: true, ahead: 2, behind: 1` etc., because Stream B Phase 6 has not yet shipped the `GET /api/agents/:id/git` endpoint. The `404` degraded states are the honest ones and are verified.

## From Stream B — nothing added

`GET /api/agents/:id/git` is the endpoint the tab expects (`{branch, clean, ahead, behind, changedFiles, commits}`); nothing was added to `apps/server/**` or `packages/protocol/**`. The tab degrades to the 404/unknown states above.

## Git

Only `git add apps/web/index.html BROWSER3-PHASE-6-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
