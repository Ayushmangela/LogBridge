# Phase 6: Production Reliability, Scaling & Enterprise Readiness

## Overview
Phase 6 is the **sixth and final planned phase** of the LogBridge roadmap.

It hardens, scales, observes, and productionizes the complete multi-agent coordination, workflow, planning, and governance platform built across Phases 1 through 5.

---

## 1. Production Architecture Overview

```text
INCOMING REQUESTS / TASKS
             │
             ▼
RATE LIMITER & SECURITY (rateLimit.ts)
   └── Token Bucket protection against API flooding
             │
             ▼
CONCURRENCY & BACKPRESSURE CONTROLS (concurrency.ts)
   ├── Agent concurrency limit (e.g. 2 per agent)
   ├── Project task limit (e.g. 25 concurrent active tasks)
   └── Workflow dispatch throttling
             │
             ▼
SYSTEM HEALTH & OBSERVABILITY (health.ts & metrics.ts)
   ├── Liveness Probe: GET /health/live
   ├── Readiness Probe: GET /health/ready
   ├── Prometheus & JSON Metrics: GET /metrics & /api/system/metrics
   └── Structured Correlation Logger: logger.ts
             │
             ▼
AUTONOMOUS EXECUTION / RECOVERY PIPELINE
   ├── Startup State Reconciliation (recovery.ts)
   ├── Graceful Shutdown (bounded flush & release)
   └── Unrecoverable Failure ──► DEAD LETTER QUEUE (deadLetter.ts)
                                      ├── Preserves complete history & artifacts
                                      ├── Re-dispatch / Reassign / Replan
                                      └── Supervisor & Human Escalation
             │
             ▼
DATA RETENTION & BACKUP (retention.ts & backup.ts)
   ├── Safe Online SQLite Backup & Verification
   └── Non-Destructive Storage Cleanup
```

---

## 2. Core Subsystems & Components

### 1. System Health & Probes ([`apps/server/src/health.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/health.ts))
- **Liveness Probe (`GET /health/live`)**: Confirms process responsiveness and uptime.
- **Readiness Probe (`GET /health/ready` & `GET /health`)**: Verifies database connectivity, table inventory, query latency, and memory metrics.

### 2. Startup Recovery & Graceful Shutdown ([`apps/server/src/recovery.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/recovery.ts))
- **`recoverServerState(db)`**: Automatically triggered during server startup to audit in-flight states:
  - Reconciles stranded `working` / `assigned` tasks.
  - Reconciles running task attempts to `timed_out` with exit code 137.
  - Safely resets task state to `queued` for fresh orchestrator evaluation without mutating historical attempt logs.
  - Emits `task.recovered` event and records an audit log.

### 3. Dead Letter Queue & Permanent Failures ([`apps/server/src/deadLetter.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/deadLetter.ts))
- Captures exhausted retries, unroutable tasks, and fatal execution failures.
- Preserves full diagnostic context: failure category, retry count, last error, and artifact references.
- Supports human reprocessing actions: `RETRY`, `REASSIGN`, `REPLAN`, `ESCALATE_HUMAN`, `DISMISS`.

```sql
CREATE TABLE IF NOT EXISTS dead_letter_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  goal_id TEXT,
  failure_category TEXT NOT NULL,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  artifact_refs_json TEXT,
  recommended_action TEXT NOT NULL DEFAULT 'RETRY',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_project ON dead_letter_tasks (project_id, status);
CREATE INDEX IF NOT EXISTS idx_dead_letter_task ON dead_letter_tasks (task_id);
```

### 4. Concurrency Controls & Backpressure ([`apps/server/src/concurrency.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/concurrency.ts))
- `checkDispatchConcurrency(db, projectId, agentId)`:
  - Agent-level concurrency capping (prevents overloading workers beyond their specified capacity).
  - Project-level active task limits (prevents overwhelming floor orchestrators).

### 5. API Rate Limiting ([`apps/server/src/rateLimit.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/rateLimit.ts))
- Sliding-window token bucket algorithm protecting against API abuse and accidental infinite loop flooding.
- Returns HTTP 429 `Too Many Requests` with `Retry-After` reset intervals.

### 6. Structured Logging & Correlation ([`apps/server/src/logger.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/logger.ts))
- Structured JSON logging with correlation identifiers: `requestId`, `projectId`, `workflowId`, `goalId`, `taskId`, `attemptId`, `agentId`.
- Automatic credential and secret redaction (`password`, `token`, `secret`, `authorization`, `apiKey`, `gh_token`).

### 7. Operational Metrics & Prometheus Telemetry ([`apps/server/src/metrics.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/metrics.ts))
- `GET /metrics` exports Prometheus text format.
- `GET /api/system/metrics` exports structured JSON operational telemetry.

### 8. Data Retention & Safe Cleanup ([`apps/server/src/retention.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/retention.ts))
- `runRetentionCleanup(db, daysToKeep)`:
  - Safely purges resolved temporary records (e.g. resolved escalations and approvals older than 30 days).
  - Strictly protects active tasks, workflows, goals, and all referenced artifacts.

### 9. Database Backup & Verification ([`apps/server/src/backup.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/backup.ts))
- `createDatabaseBackup(db, targetPath)`: Non-blocking SQLite online backup.
- `verifyDatabaseBackup(backupPath)`: Authoritative integrity verification (`PRAGMA integrity_check`).

---

## 3. REST API Surface

- `GET /health` — High-level readiness report
- `GET /health/live` — Process liveness probe
- `GET /health/ready` — Comprehensive readiness check
- `GET /metrics` — Prometheus metrics
- `GET /api/system/metrics` — JSON operational metrics
- `GET /api/projects/:id/dead-letter` — List project dead letter queue
- `POST /api/dead-letter/:id/reprocess` — Reprocess dead-lettered task
- `POST /api/system/backup` — Create database backup
- `POST /api/system/verify-backup` — Verify backup integrity
- `POST /api/system/cleanup` — Run retention cleanup

---

## 4. Command Center UI Experience

- **`📊 System Ops` Tab ([`apps/web/index.html`](file:///Users/ayush/Project/LogBridge/apps/web/index.html))**:
  - Live Health & Readiness badge (`HEALTHY`, `DEGRADED`, `UNHEALTHY`).
  - Active Task Pipeline and Memory telemetry cards.
  - Interactive **Dead Letter Queue (DLQ)** view with one-click `[ 🔄 Retry ]` and `[ ❌ Dismiss ]` action buttons.
  - One-click Retention Cleanup tool.
