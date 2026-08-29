# Phase 3 Audit Result — Task & TaskAttempt Verification

## Finding: **WIRED AND HONOURED**

`task_attempts` is not ornamental; it is actively integrated into the core task execution pipeline, failure recovery, metric tracking, and agent prompt context. Rebuilding or redefining it would have duplicated existing, working infrastructure.

## Evidence & Verification

### 1. State Machine & Execution Wiring
- **Task Dispatch & Execution (`apps/server/src/nodeGateway/gateway.ts:455`)**:
  When a node runner accepts a task assignment, `createTaskAttempt(db, { taskId, agentId })` creates a new attempt with state `running`.
- **Idempotency (`apps/server/src/db/artifacts.ts:14-19`)**:
  If an attempt is already active (`state = 'running'`) for the given `taskId`, duplicate assignment calls return the active attempt without incrementing attempt numbers or duplicating records.
- **Completion & Exit Recording (`apps/server/src/nodeGateway/gateway.ts:538`)**:
  When an agent finishes execution (`task.result`), `finishTaskAttempt()` records the state (`completed` or `failed`), `ended_at`, `exit_code`, `error_message`, and `cost_usd`.
- **Failure & Lease Expiry (`apps/server/src/nodeGateway/gateway.ts:170`)**:
  When runner heartbeat fails or lease expires, `failActiveTaskAttempt()` transitions active attempts to `timed_out` with `"machine went offline — lease expired"`.
- **Server Startup Recovery (`apps/server/src/recovery.ts:38`)**:
  On server restart, orphaned in-flight running attempts are transitioned to `failed` state with recovery audit events.

### 2. Retry-Class Distinction
- Physical crashes, timeouts, and process terminations are recorded as separate attempts (`attempt_number` 1, 2, ...) on the same `task_id`.
- Review rejections are tracked through the separate `review_verdicts` table (`apps/server/src/db/schema.ts:462`), which links rework tasks via `retry_of` rather than muddying physical execution attempts.
- Reassignments and replanning actions generate explicit replacement tasks linked by `parent_task` and `retry_of`.

### 3. Context & Intelligence Integration
- **Prompt History (`apps/server/src/contextBuilder.ts:88`)**:
  When retrying tasks, previous attempts, exit codes, and error messages from `task_attempts` are queried and injected into the agent prompt so the agent learns from previous failure modes.
- **Dead-Letter Triggers (`apps/server/src/deadLetter.ts:50`)**:
  The dead-letter engine directly calculates attempt counts from physical `task_attempts` history.
- **Metrics Aggregation (`apps/server/src/db/metrics-queries.ts:63, 92`)**:
  Aggregates success rates, attempt distributions, and cost per attempt across projects.

### 4. Test Verification
The lifecycle and REST endpoints (`GET /api/tasks/:id/attempts`) are comprehensively tested in `apps/server/src/agentCoordination.test.ts` and `apps/server/src/production.test.ts` (all passing).

## Conclusion
No build or schema rewrite was required for Phase 3. The `task_attempts` architecture matches the requirements outlined in the design and deep-research specifications.
