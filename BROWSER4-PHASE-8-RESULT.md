# Browser4 Phase 8 — Graph and messages — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

Two tabs, both deterministic and filtered, not second stores:

- **Graph** (floor surface, `getCCTabs` for `planner`): `Agents as nodes, messages as edges — delegation vs review vs chat, deterministic layout seeded from agent ids.` On open it tries `GET /api/graph?projectId=`. On `200` it uses `data.nodes`/`data.edges` (Stream B Phase 8); on `404` it degrades to *activity-derived edges* (`room.activity` filtered to `delegate`/`review`/`chat`) and shows `Graph not available yet — server has no graph endpoint. Showing activity-derived edges.` No `Math.random()` — layout is `hashString(agent.id)` seeded circle (`angle = (hash % 360)° + i·π/n`, `r = R·(0.7 + hash%30/100)`, `x = cx + r·cos`, `y = cy + r·sin`), sorted by `id` for stability. Edges are `div` lines colored `#8b5cf6` delegation, `#3b82f6` review, `#22c55e` chat, capped at 30. Nodes are 28 px circles with initials, `title` is full name, `onclick` → `openCommandCenter(id)`. Legend at bottom.
- **Messages** (employee surface): `This agent's conversation — what it was asked, what it answered, questions it raised. Filtered from Room chat, not a second store.` It merges `chatLog` (where `m.from.id === a.id` or `m.text` includes `a.name`) and `room.activity` where `it.actor === a.name`, sorts by `ts`, caps at 30, and renders each as `kind` + `text`. Empty shows `No messages for this agent yet…`. The check “what exists before building” was done: `Room chat` (`ChatMessage` + `ChatMessage.ask`) and the `human.ask`/`human.answer` mid-task flow (M4) already exist; `messages` is a filtered view of them, not a new `messages` table.

Both tabs use `textContent`, never `innerHTML` for wire data, and degrade via `404` branches without throwing.

## Method and what was rejected

- **Deterministic circle, not force layout:** a force layout seeded from `Math.random()` would give two browsers different pictures for the same `room.agents`/`room.activity`, violating the standing `Math.random()` rule (also used for roaming). The hash-seeded circle is `O(n)` and identical across browsers because `hashString` is pure and `room.agents` is sorted by `id` (contract invariant 3, stable slot). Rejected `d3-force` with `Math.random()` seed.
- **Edges from `room.activity` as fallback, not a second `messages` store:** `room.activity` already projects `events` into `summary` server-side; filtering it for `actor === a.name` and `type` prefix gives the same edges the graph would, without a new table. The honest endpoint is `GET /api/graph`; until Stream B ships it, the tab shows activity-derived edges and says so. Rejected a new `messages` table that would duplicate `chat` + `human.ask` stores.
- **Nodes clickable:** `dot.onclick = () => openCommandCenter(id)` — the graph is not a dead picture; clicking a node opens that agent, as the brief requires.

## What I clicked and what I observed

In Chrome 151 via `dispatchMouseEvent`:

- As `planner` (`role: planner`) → Command Center tabs now include `Graph` (floor) and not `Messages`; as `dev-api` (`role: developer`) → tabs include `Messages` (employee) and not `Graph` — split is visible. Clicked **Graph** as `planner` with 3 agents in the room and 2 `delegate.request` + 1 `chat` in `room.activity` → saw a 320×220 `wrap` with 3 circles (`DE`, `QA`, `PL`) placed deterministically (re-opening the tab gave the same `x,y` for each `id`), 3 thin lines colored per legend (purple for delegation, green for chat), legend at bottom, and `Graph not available yet…` note above because `GET /api/graph` returned `404` → fallback edges from activity, not a blank panel. Clicked a node (`QA`) → `openCommandCenter('agt_qa')` fired and the Center switched to `qa-api` (verified via `cc-name` text).
- Clicked **Messages** as `dev-api` with 1 `chatLog` entry `from: dev-api, text: "hello"` and 1 `activity` `actor: dev-api, summary: "asked ..."` → saw 2 rows, `chat` + `task.assigned`, sorted by `ts`; `textContent` showed the summaries, no `innerHTML` injection. With an agent that had no chat/activity, **Messages** showed `No messages for this agent yet…`.
- Regression: `Output` still caps at 400 and respects scroll, `Monitor`/`Git` still degrade to `Unknown`, `Tasks`/`Traces` still show that agent’s tasks/events.

**Could not reach:** a live `200` from `GET /api/graph` with `nodes`/`edges` from Stream B Phase 8, because it is not yet in the view. The `404` fallback is the honest state and is verified.

## From Stream B — nothing added

`GET /api/graph?projectId=` is the endpoint the tab expects (`{nodes:[{id,name}], edges:[{from,to,kind}]}`); nothing was added to `apps/server/**` or `packages/protocol/**`. The tab degrades to activity-filtered edges.

## Git

Only `git add apps/web/index.html BROWSER4-PHASE-8-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
