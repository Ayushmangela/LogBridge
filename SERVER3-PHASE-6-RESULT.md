# Server Phase 6 — Git state per agent — Result

## What was built

- `GET /api/agents/:id/git` — surfaces real worktree git state: branch, clean/dirty, ahead/behind, changed files, and recent commits.
- Queries the runner's machine over the node gateway using `agent.git` and `agent.git.result` envelope types.
- The server never reads the filesystem directly (D1).
- Honest degradation:
  - When the agent's machine is offline, reports `branch: "unknown"` with `error: "machine offline"` (D28) rather than returning stale cached state.
  - When the agent uses `shared` isolation without its own branch, reports `branch: null` and clean state rather than erroring.

## Method chosen and what was rejected

**Chosen: Request/response through node gateway, zero server-side filesystem reads.**

- Agents operate in worktrees on their owner's machine. The server process running in a different container/server cannot and should not read the local developer disk.
- Querying via `agent.git` envelope through `nodeSockets` ensures that multi-machine setups work correctly.

**Rejected:**

- **Server-side `git` execution:** Works only in single-machine setups and completely breaks in multi-machine or distributed deployments.
- **Caching git state across disconnects:** D28 dictates that an offline machine is unreachable; pretending to know its git status when offline would be dishonest.

## Decisions forced

- **Offline handling:** Return `{ ok: true, branch: "unknown", error: "machine offline" }` matching browser UI expectations.
- **Shared isolation:** Return `{ ok: true, branch: null, clean: true }` so the UI explains that the agent shares the root directory.

## Test count

- Covered in `apps/server/src/agentWatching.test.ts`. Verified offline unknown state and shared isolation handling.

## Shapes for Stream A

```ts
// GET /api/agents/:id/git
// -> {
//   ok: true,
//   branch: string | null,
//   clean: boolean,
//   ahead: number,
//   behind: number,
//   changedFiles: string[],
//   commits: Array<{ sha: string, message: string, author?: string, ts?: string }>,
//   error?: string | null
// }
```
