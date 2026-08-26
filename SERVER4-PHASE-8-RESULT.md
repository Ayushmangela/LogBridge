# Server Phase 8 — The message graph — Result

## What was built

- `GET /api/graph?projectId=...` — generates an agent communication network graph from event log metadata:
  - `nodes`: list of agents in the project with `id`, `name`, `role`, `character`, `color`.
  - `edges`: directed communications between agents with `from`, `to`, `kind` (`delegation`, `review`, `chat`), `count`, and `lastTs`.
- Bounded time window: defaults to past 7 days (168 hours) and caps at 500 recent events to prevent unbounded queries.
- Sealed privacy guarantee (D26): graph is constructed purely from envelope metadata (`from`, `to`, `type`, `ts`), never opening or reading sealed content.

## Method chosen and what was rejected

**Chosen: Metadata-only aggregation from SQLite events table.**

- All inter-agent communications (`delegate.request`, `review.request`, `chat`) already land in `events`.
- Respects the cryptographic invariant that the server cannot read sealed bodies.

**Rejected:**

- **Unbounded lifetime queries:** A graph spanning all historical events would become noisy and sluggish.
- **Reading sealed body payloads:** Violates end-to-end encryption guarantees (D26).

## Decisions forced

- **Edge classification:** Distinguish `delegation`, `review`, and `chat` so the browser UI can apply distinctive colors (`#8b5cf6`, `#3b82f6`, `#22c55e`).

## Test count

- Covered in `apps/server/src/floorConsole.test.ts`. Verified node and edge construction, edge classification, and counts.

## Shapes for Stream A

```ts
// GET /api/graph?projectId=prj_...
// -> {
//   ok: true,
//   nodes: Array<{ id: string, name: string, role: string, character: string | null, color: string | null }>,
//   edges: Array<{ from: string, to: string, kind: "delegation" | "review" | "chat", count: number, lastTs: string }>
// }
```
