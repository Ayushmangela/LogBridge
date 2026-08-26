# Server Phase 5 — A read-only output stream — Result

## What was built

- `GET /api/agents/:id/output?limit=200&since=N` — read-only output stream endpoint returning parsed lines produced by the agent during tasks.
- Supports incremental polling via `?since=seq` to fetch only new lines since the last read.
- Capped at 400 lines max per request to prevent buffer overflow and excessive DOM load.

## Method chosen and what was rejected

**Chosen: Parsed structured lines from `task.event`, never raw PTY streams.**

- LogBridge is an unauthenticated web application over a network (D23). A raw interactive PTY stream is a remote shell on someone's workstation.
- Structured output lines parsed by the runner's harness provide visibility into compiler, linter, and test outputs without exposing an interactive shell.

**Rejected:**

- **WebSockets xterm.js shell:** Explicitly rejected per security invariants (D23).
- **Unbounded line streaming:** A runaway CLI producing megabytes of logs could crash the browser. Strict line caps protect memory.

## Decisions forced

- **Line capping:** Hard-capped at 400 lines.
- **Incremental polling:** Supported via `?since=seq` matching the browser's poll loop in `index.html`.

## Test count

- Covered in `apps/server/src/agentWatching.test.ts`. Verified line extraction, capping, and since parameter.

## Shapes for Stream A

```ts
// GET /api/agents/:id/output?limit=200&since=N
// -> {
//   ok: true,
//   agentId: string,
//   output: string[],
//   lines: string[],
//   count: number
// }
```
