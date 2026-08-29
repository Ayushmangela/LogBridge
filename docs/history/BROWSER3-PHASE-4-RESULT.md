# Browser3 Phase 4 — Split the orchestrator from the employees — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

The Command Center now has two surfaces, chosen purely from data Stream A already has:

- **Orchestrator** — `agent.role === 'planner'` (the only `AgentRole` that is not a direct worker role; `planner` is stored in `agents.role` and the roster already groups by role). `isOrchestrator(a)` is the predicate. No new server column was added — if a real `isOrchestrator` boolean is wanted, that is Stream B's and the reviewer owns the call.
- **Employee** — every other role (`developer`, `research`, `qa`, `review`, `docs`).

`getCCTabs(a)` returns the tab set per surface, and `renderCommandCenter` keeps `ccTab` valid for the current surface (if you were on `triggers` as a planner and click an employee, `triggers` is not in the employee set, so `ccTab` resets to the first available tab for that surface). The header’s manage row now shows a subtle surface label (`Orchestrator · floor` vs `Employee · <name>`) so the split is visible without being noisy.

- **Orchestrator (planner):** `Commands`, `Activity`, `Memory`, `Triggers`, `Tasks` — the floor-wide console. `Steer`/`Traces` are *not* shown here because they are per-agent controls that are meaningless for a floor view.
- **Employee (others):** `Tasks`, `Steer`, `Traces`, plus `Commands`/`Activity` kept for continuity — every tab that worked before is still reachable via one of the two surfaces, and `Tasks` is on both so no work is stranded. Nothing was deleted.

If the split is judged worse than the single set, it can be reverted to `return all` in one line — the result file says so, and leaving it alone is legitimate.

## Method and what was rejected

- **Role, not a new column:** `AgentRole` already has `planner`; it is the cheapest honest orchestrator marker because it is stored, the `view` already ships it, and the `Add Agent` wizard already lets you pick it. Adding a `isOrchestrator` boolean would need Stream B to add a column, a way to set it, and a migration — all for a decision the browser can already make from `role`. Rejected a new column.
- **Tab filter, not a rewrite:** `CC_TABS` became `getCCTabs(a)` (with `CC_TABS` kept as `getCCTabs(null)` for back-compat). `renderCommandCenter` now does `availTabs = getCCTabs(a)` and resets `ccTab` if it is not in the available set. No tab was deleted; `Memory`, `Triggers`, `Commands`, `Activity` all still function, they are just on the floor surface.
- **Keep the manage row:** `Edit`/`Note`/`Pause`/`Retire`/`Delete` stay on both surfaces — they are per-agent lifecycle controls and the brief says not to delete anything that works.
- **Rejected: a full ten-tab orchestrator with `terminal`/`monitor`/`graph`/`workers` etc.:** those tabs do not exist yet (monitor is Phase 5, git is Phase 6, graph is Phase 8, terminal is deliberately blocked on enrolment). Building empty tabs that say “not built yet” would be worse than the current split, which at least shows the five tabs that actually have data.

## What I clicked and what I observed

Verified in Chrome 151 via `dispatchMouseEvent`:

- With an agent `planner-1` (`role: planner`) selected, Command Center tabs read `Commands · Activity · Memory · Triggers · Tasks` (5), header manage row label `Orchestrator · floor`, `Steer`/`Traces` not present — floor console, not an employee panel.
- Clicked `dev-api` (`role: developer`) in the roster → Center re-rendered, tabs now `Tasks · Steer · Traces · Commands · Activity` (5, with `Tasks` on both), label `Employee · dev-api`, `Memory`/`Triggers` gone — employee panel, not the floor. `Tasks` for `dev-api` still showed its 2 tasks, `Traces` still showed its `task.event` rows, `Steer` still had its input.
- Clicked an employee on `Traces`, then clicked the `planner` again → `Traces` was not in the planner set, so `ccTab` reset to `Commands` (first floor tab) rather than staying on a tab that no longer exists — no blank panel.
- Regression: every tab that existed before is still reachable: `planner` sees `Memory`/`Triggers`, `dev-api` sees `Traces`/`Steer`, both see `Tasks`/`Commands`/`Activity`. No `innerHTML` exception, office still roams/animates, head card and summon still work.

**If the split is worse:** the one-line fallback `return all` in `getCCTabs` restores the single-set behaviour with zero other changes.

## From Stream B — nothing requested

No new field was needed; `AgentView.role` already carries `planner`. If a dedicated `isOrchestrator` is wanted, that is Stream B's column and is noted above, not added.

## Git

Only `git add apps/web/index.html BROWSER3-PHASE-4-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
