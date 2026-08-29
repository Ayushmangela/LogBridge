# Server Phase 7 — Monitor: dispatch and capacity console — Result

## What was built

- Extended `AgentView` with monitor attributes:
  - `contextUsed`: tokens used by the agent during work.
  - `contextLimit`: token context window limit.
  - `toolCalls`: total tool calls made during the task.
  - `cwd`: workspace working directory.
  - `model`: engine model name.
- `POST /api/agents/:id/engine` — updates provider and model configuration on the agent, records in database, broadcasts view, and triggers harness restart.
- Verified task dispatch via `/debug/submit-task` and `/debug/offer-task`.

## Method chosen and what was rejected

**Chosen: Context and tool counts ride the existing snapshot view; engine restart is notified honestly.**

- The browser renders a token budget bar when `contextUsed` and `contextLimit` are available.
- Switching engine notifies that a restart is occurring rather than claiming instant swap.

**Rejected:**

- **Per-agent token polling loop:** Would create unnecessary network traffic.
- **Complex spend/cost tracking:** Out of scope; users manage their own CLI subscriptions.

## Decisions forced

- **Engine restart honesty:** Return `{ ok: true, restarting: true, message: "Restarting — engine will change on next heartbeat." }`.

## Test count

- Covered in `apps/server/src/floorConsole.test.ts`. Verified `AgentView` fields, engine update, and restart response.

## Shapes for Stream A

```ts
// In AgentView:
{
  ...
  contextUsed: number | null,
  contextLimit: number | null,
  toolCalls: number,
  cwd: string | null,
  model: string | null,
  provider: string | null
}

// POST /api/agents/:id/engine
{ provider: string, model?: string | null }
// -> { ok: true, restarting: true, message: string }
```
