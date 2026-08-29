# Server Phase 1 — Agent lifecycle: edit, note, pause, retire, delete — Result

## What was built

Agent lifecycle control endpoints and database persistence were added so an agent is no longer permanently unchangeable once created. The endpoints support both REST and browser-action aliases:

- `PATCH /api/agents/:id` & `POST /api/agents/:id/edit` — updates name, description, goal, character, color, capabilities, note, role. Broadcasts view.
- `POST /api/agents/:id/note` — updates scratch note (`agents.note`). Broadcasts view.
- `POST /api/agents/:id/pause` & `POST /api/agents/:id/resume` — toggles `paused` flag (and records `paused_at`). The orchestrator explicitly excludes paused agents (`candidateAgents` filters `COALESCE(a.paused, 0) = 0`).
- `POST /api/agents/:id/retire` & `POST /api/agents/:id/unretire` — toggles `retired` flag (and records `retired_at`). Soft-delete that keeps history and memories while excluding from routed work.
- `DELETE /api/agents/:id` & `POST /api/agents/:id/delete` — removes agent from roster and records in `deleted_agents`. Memories and task history are kept.
- `apps/server/src/nodeGateway.ts` — `agent.card` handler checks `isAgentDeleted(db, body.id)` to prevent runner reconnects from resurrecting deleted agents.

## Method chosen and what was rejected

**Chosen: Retain memories on delete, record hard-deletes in `deleted_agents`.**

- Memories accumulate team knowledge across tasks; deleting them would lose learned fixes and facts.
- Recording deleted agent IDs in `deleted_agents` solves the split-brain problem (D1): if an agent is deleted server-side, a reconnecting runner publishing an `agent.card` for that ID is ignored rather than resurrecting the deleted row.
- Both `PATCH` and `POST /edit`, `DELETE` and `POST /delete` are wired so that standard API clients and browser `postAgent()` calls both work seamlessly.

**Rejected:**

- **Cascading delete of memories and tasks:** Rejected because it destroys codebase knowledge that other agents rely on.
- **In-memory deleted agent set:** Rejected because a server restart would forget deleted IDs and resurrect agents on the next runner handshake.

## Decisions forced

- **Memory retention on delete:** Memories belong to the project and citations remain attributable to the agent's historical name. Deleting the agent removes it from the live floor roster, while historical tasks and memories persist.
- **Orchestrator gating:** Paused and retired agents remain visible in the office (with `paused: true` or `retired: true` on `AgentView`) but are filtered out of `candidateAgents`, ensuring zero tasks are offered to them.

## Test count

- **Before**: 203 server tests, 42 protocol tests.
- **After**: 220 server tests (across 21 test files), 45 protocol tests (6 test files). Added `agentLifecycle.test.ts` covering edit, note, pause, retire, delete, and orchestrator exclusion.

## Revert-proof

Reverting the orchestrator filter (`COALESCE(a.paused, 0) = 0`) in `db.ts` causes `src/agentLifecycle.test.ts > pause and resume toggle paused flag and orchestrator excludes paused agent` to fail, assigning the task to the paused agent.

## Shapes for Stream A

```ts
// PATCH /api/agents/:id or POST /api/agents/:id/edit
{ name?: string, description?: string, goal?: string, character?: string, color?: string, capabilities?: string[], role?: string, note?: string }
// -> { ok: true }

// POST /api/agents/:id/note
{ note: string }
// -> { ok: true }

// POST /api/agents/:id/pause | resume | retire | unretire | delete
{} or { agentId: string }
// -> { ok: true }
```
