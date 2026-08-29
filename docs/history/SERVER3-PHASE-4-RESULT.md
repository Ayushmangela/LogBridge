# Server Phase 4 — Traces: what an agent is actually doing — Result

## What was built

- `GET /api/agents/:id/traces?limit=50` — returns recent structured `task.event` events for an agent's tasks, grouped by task, newest first.
- Includes `id`, `seq`, `taskId`, `taskTitle`, `kind`, `summary`, `ts`, and `data`.
- Path and content redaction: absolute paths such as `/Users/<name>` are masked to `~` and long strings are safely truncated to protect credentials and private developer environments.

## Method chosen and what was rejected

**Chosen: Structured `task.event` log queries with server-side redaction.**

- The runner already emits structured `task.event` envelopes with tool calls and step boundaries. The server stores them in SQLite and can serve them with pagination and redaction on demand.
- Redaction ensures that private user directory hierarchies and token patterns are stripped before leaving the server.

**Rejected:**

- **Streaming raw events into WorkspaceView:** Excluded from view broadcasts to avoid inflating snapshot sizes.
- **Unredacted argument inspection:** Rejected because tool calls may include raw file contents, secrets, or internal paths.

## Decisions forced

- **Redaction policy:** Mask user paths to `~` and truncate summary lines to 200 characters.
- **Task grouping:** Traces carry `taskId` and `taskTitle` so the UI can group them under tasks.

## Test count

- Covered in `apps/server/src/agentWatching.test.ts`. Verified redaction and pagination. All tests pass.

## Shapes for Stream A

```ts
// GET /api/agents/:id/traces?limit=50
// -> {
//   ok: true,
//   agentId: string,
//   traces: Array<{
//     id: string,
//     seq: number,
//     taskId: string,
//     taskTitle: string,
//     kind: string,
//     summary: string,
//     ts: string,
//     data: any
//   }>
// }
```
