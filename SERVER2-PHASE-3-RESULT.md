# Server Phase 3 — Steer, and move between projects — Result

## What was built

- `POST /api/agents/:id/steer` — injects one line of context into the agent's *next* task prompt without opening an interactive terminal or remote shell. Stored in `agents.steer_context` and consumed when `sendTaskOffer` dispatches a task to the runner, prepending `[Steer Context]: ...` to the task specification.
- `POST /api/agents/:id/move` — moves an agent to another project (`project_id`). Validates target project exists (404 otherwise).
- `POST /api/agents/:id/clone` — duplicates an agent's configuration (role, capabilities, concurrency, character, color, folder, isolation, description, goal, provider, model) into a target project with a new ID.

## Method chosen and what was rejected

**Chosen: Memories remain with the original project.**

- Memories are project-scoped team knowledge ("the deploy script needs sudo", repo architecture, specific quirks). An agent moving to another project starts fresh in that project's codebase context, while the original project retains the knowledge the team accumulated.
- Steer lands cleanly in `task.offer` body without requiring any shell session or PTY protocol extensions.

**Rejected:**

- **Copying or moving memories with the agent:** Would pollute project B with project A's specific code findings and repo paths.
- **Terminal emulation for steering:** Opening an interactive PTY to a remote browser has severe security implications (D23). Steer delivers 90% of the practical utility safely via the task prompt channel.

## Decisions forced

- **Memory project-scoping:** Confirmed that memories are tied to `project_id`, not `agent_id`.
- **Target project validation:** Move and clone strictly verify that the target project exists before updating the database.

## Test count

- Covered in `apps/server/src/agentLifecycle.test.ts` (`POST /steer`, `POST /move`, `POST /clone`). All tests green.

## Shapes for Stream A

```ts
// POST /api/agents/:id/steer
{ text: string }
// -> { ok: true, steered: true }

// POST /api/agents/:id/move
{ projectId: string }
// -> { ok: true, agentId: string, projectId: string }

// POST /api/agents/:id/clone
{ projectId: string, name?: string }
// -> { ok: true, agent: AgentRow }
```
