# Server Phase 2 — Per-agent history and health — Result

## What was built

Surfaced per-agent historical performance and live health metrics:

- `GET /api/agents/:id/history?limit=20&offset=0` — paginated past tasks for an agent with `id`, `projectId`, `title`, `spec`, `state`, `outcome`, `durationSeconds`, `createdAt`, `startedAt`, `endedAt`, `budgetSeconds`, `costUsd`, and `eventCount`. Empty and valid for an agent with no past work.
- `AgentView.health` added to the workspace view:
  - `lastHeartbeat`: ISO timestamp of machine's last seen time.
  - `consecutiveFailures`: computed count of consecutive failed tasks before the latest success.
  - `machineOnline`: boolean indicating if the owning machine is currently connected.
- `AgentView.machineOnline`: direct boolean flag on `AgentView` for easy consumption by the browser.

## Method chosen and what was rejected

**Chosen: History endpoint separate from view; health derived inside `buildView`.**

- `buildView` is broadcast on every movement and chat; keeping history on its own paginated endpoint keeps view snapshot sizes constant and small.
- Health metrics are small, derived scalars that naturally belong on the agent sprite and roster.

**Rejected:**

- **In-view history lists:** Would make the view snapshot grow linearly with completed tasks, degrading WebSocket throughput and frontend parse times.
- **Polling for health:** Unnecessary since the server already tracks machine heartbeats and task completions.

## Decisions forced

- **Snapshot cost:** Kept history strictly off `buildView` to preserve the invariant of lightweight snapshot broadcasts.
- **Consecutive failure calculation:** Scoped to the agent's last 10 terminal states to bound query time in SQLite without expensive scans.

## Test count

- `apps/server/src/agentLifecycle.test.ts` includes dedicated tests for `GET /api/agents/:id/history` pagination and `buildView` health computation. All tests green.

## Shapes for Stream A

```ts
// GET /api/agents/:id/history?limit=N&offset=M
// -> {
//   ok: true,
//   agentId: string,
//   tasks: Array<{
//     id: string,
//     title: string,
//     spec: string | null,
//     state: string,
//     outcome: string,
//     durationSeconds: number | null,
//     createdAt: string,
//     startedAt: string | null,
//     endedAt: string | null,
//     budgetSeconds: number,
//     costUsd: number,
//     eventCount: number
//   }>,
//   total: number,
//   limit: number,
//   offset: number
// }

// In AgentView (buildView snapshot):
{
  ...
  machineOnline: boolean,
  health: {
    lastHeartbeat: string | null,
    consecutiveFailures: number,
    machineOnline: boolean
  }
}
```
