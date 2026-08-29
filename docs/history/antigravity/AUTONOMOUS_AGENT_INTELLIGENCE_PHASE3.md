# Phase 3: Autonomous Agent Intelligence, Reliability & Recovery

## Overview
Phase 3 elevates LogBridge from a reactive multi-agent coordinator into an **autonomous, intelligent, self-healing, and observable multi-agent collaboration platform**.

Building on the durability of Phase 1 (`task_attempts`, `artifacts`, delta sync) and the structural orchestration of Phase 2 (Workflows, DAGs, Handoffs, Reviews), Phase 3 introduces:
1. **Intelligent & Explainable Deterministic Routing**: Multi-factor scoring engine evaluating capabilities, load, historical reliability, and previous failure penalties with full candidate audit trails.
2. **Failure Classification & Policy-Driven Recovery**: Automatic categorization (`TIMEOUT`, `MACHINE_OFFLINE`, `TRANSIENT`, `AGENT_FAILURE`, `INVALID_TASK`) with automated, policy-governed retries that switch broken agents while preserving terminal FSM invariants.
3. **Autonomous Workflow Supervisor**: Continuous health diagnosis (`HEALTHY`, `DEGRADED`, `BLOCKED`, `STALLED`, `FAILED`) with automated recovery recommendations and one-click operator remediations.
4. **Deterministic Project-Scoped Agent Context Builder**: Prioritized, bounded compilation of task specs, dependency outputs, artifact diffs, failure history, and project memories.
5. **Full Performance & Observability Telemetry**: Real-time metrics across agents, workflows, and projects.
6. **Command Center & Inspector UI Upgrades**: Live supervisor diagnostics, routing explanations, and context preview panels.

---

## 1. Intelligent Scoring & Explainable Routing

### Architecture
Located in [`apps/server/src/orchestrator.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/orchestrator.ts):
- Evaluates candidate agents deterministically using `evaluateAgentCandidates`:
  - **Capability Score (0 - 40 pts)**: Exact match earns 40 pts; general developer earns 30 pts; missing required capability yields 0 pts (disqualified).
  - **Availability Score (0 - 20 pts)**: Machine online and capacity free earns 20 pts.
  - **Load Penalty (-10 to 0 pts)**: Penalizes heavily loaded workers proportionally to `-(load / concurrency) * 10`.
  - **Reliability Score (0 - 20 pts)**: `Math.round(successRate * 20)` based on verified completion history in `task_attempts`.
  - **Previous Failure Penalty (-15 pts)**: Penalizes agents that previously failed the task or its retry ancestors to avoid infinite loops on broken environments.
  - **Tie-Breaker**: Stable sorting on `agent.id.localeCompare` ensures 100% deterministic reproducibility.
- Emits event `task.routing_evaluated` containing the complete candidate breakdown and transparent explanation.

```typescript
export interface CandidateScore {
  agentId: string;
  agentName: string;
  eligible: boolean;
  score: number;
  breakdown: RoutingScoreBreakdown;
  disqualificationReason?: string;
}
```

---

## 2. Failure Classification & Policy-Driven Recovery Engine

### Architecture
Located in [`apps/server/src/db.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/db.ts) and [`apps/server/src/nodeGateway.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/nodeGateway.ts):
- **Classifier (`classifyFailure`)**:
  - `TIMEOUT`: Runner lease expiration or silent heartbeats.
  - `MACHINE_OFFLINE`: Socket disconnections and dropped network links.
  - `TRANSIENT`: Network reset, 502/503/504, 429 rate limit exceptions.
  - `AGENT_FAILURE`: Unhandled process crashes, non-zero exit codes.
  - `INVALID_TASK`: Bad specs, invalid syntax, permission errors (escalated without retrying).
  - `DEPENDENCY_FAILURE`: Blocked by predecessor tasks.
- **Retry Policies (`retry_policies` table)**:
  - Configurable at project or task level (`maxAttempts`, `backoffMs`, `retryOn`, `preferDifferentAgent`).
  - Terminal states (`completed`, `failed`) remain strictly immutable. Retries spawn linked descendant tasks (`parent_task`, `retry_of`), automatically switching to an alternate capable worker if configured.

---

## 3. Autonomous Workflow Supervisor

### Architecture
Located in [`apps/server/src/supervisor.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/supervisor.ts):
- **Continuous Health Assessment (`evaluateWorkflowHealth`)**:
  - Evaluates all workflow tasks, dependencies, attempts, and agent states.
  - Detects anomalies: `TASK_FAILED_MAX_RETRIES`, `DEPENDENCY_BLOCKED`, `AGENT_UNAVAILABLE`, `WORKFLOW_STALLED`, `HIGH_FAILURE_RATE`.
  - Classifies overall workflow health: `HEALTHY` ➔ `DEGRADED` ➔ `BLOCKED` ➔ `STALLED` ➔ `FAILED` ➔ `COMPLETED`.
- **Autonomous Recovery Actions (`executeSupervisorAction`)**:
  - Proposes and executes remediation actions: `RETRY`, `REASSIGN`, `PAUSE`, `RESUME`, `CANCEL`, `ESCALATE_HUMAN`.
  - Emits `supervisor.action` events for complete auditability.

---

## 4. Deterministic Project-Scoped Context Builder

### Architecture
Located in [`apps/server/src/contextBuilder.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/contextBuilder.ts):
- Assembles a clean, structured, bounded text context payload for any task dispatch:
  1. **Priority 1**: Task specification, constraints, and capability requirements.
  2. **Priority 2**: Predecessor outputs and artifact summaries from satisfied dependencies.
  3. **Priority 3**: Attached artifact references (diffs, test logs, code reviews).
  4. **Priority 4**: Lineage & failure diagnostics from previous attempts (ensuring agents don't repeat mistakes).
  5. **Priority 5**: Relevant project memories and blackboard entries.
- Guarantees strict character/token budget enforcement and 100% project boundary isolation.

---

## 5. Performance, Reliability & Observability Metrics

### Architecture
Located in [`apps/server/src/db.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/db.ts) and [`apps/server/src/index.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/index.ts):
- `getAgentMetrics(db, agentId)`: Calculates success rate %, total attempts, completions, failures, timeouts, average execution duration (sec), total USD cost, and active load.
- `getProjectMetrics(db, projectId)`: Calculates overall workflow states, task breakdown, attempt totals, aggregate success rate, and active agent availability.

---

## 6. REST APIs & Command Center UI

### Endpoints
- `GET /api/agents/:id/profile` — Full agent profile, capabilities, and performance metrics.
- `GET /api/tasks/:id/routing-explanation` — Explainable routing audit with candidate scoring breakdown.
- `GET /api/tasks/:id/context` — Deterministic assembled context payload.
- `POST /api/tasks/:id/retry` — Manual or operator-triggered retry dispatch.
- `GET /api/workflows/:id/health` — Supervisor health evaluation and recovery recommendations.
- `POST /api/workflows/:id/supervisor-action` — Execute supervisor remediation routine.
- `GET /api/projects/:id/metrics` — Project-wide performance and cost telemetry.
- `POST /api/projects/:id/retry-policy` — Update task/project retry policies.

### Command Center UI
- **Workflows Tab**: Supervisor Health status pills (`🏥 HEALTHY`, `🏥 DEGRADED`, `🏥 BLOCKED`, `🏥 STALLED`) with interactive remediation action banners.
- **Inspector Drawer**: Extended sub-section tabs for `[Attempts]`, `[Artifacts]`, `[Routing]` (candidate scores & explanations), and `[Context]` (deterministic context preview).
