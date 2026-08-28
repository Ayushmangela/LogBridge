# LogBridge Phase 1 Multi-Agent Coordination Engine

## Overview
LogBridge Phase 1 establishes a deterministic, crash-resilient multi-agent coordination foundation directly integrated into the core server and runner architecture.

It separates logical task objectives from physical execution attempts, introduces zero-copy artifact references, and enables bounded WebSocket event replay on network reconnection—all while preserving 100% backward compatibility and adhering strictly to legal Task Finite State Machine (FSM) invariants.

---

## 1. Key Architectural Components

### A. Task Execution Attempts (`task_attempts`)
A single logical task can undergo multiple execution runs (e.g. initial run, retry after network drop, or lease timeout). 
- Historical execution records are preserved in `task_attempts`.
- Each attempt records `attempt_number`, `agent_id`, `state`, `started_at`, `ended_at`, `exit_code`, `error_message`, and `cost_usd`.
- Duplicate runner messages (`task.accept` and `task.result`) are handled idempotently.

```
┌─────────────────────────────────────────────────────────────┐
│                      LOGICAL TASK                           │
│  id: "tsk_101", title: "Build JWT Auth", state: "completed" │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
  ┌─────────────────────────┐     ┌─────────────────────────┐
  │     TASK ATTEMPT #1     │     │     TASK ATTEMPT #2     │
  │ attempt_number: 1       │     │ attempt_number: 2       │
  │ state: "failed"         │     │ state: "completed"      │
  │ exit_code: 1            │     │ exit_code: 0            │
  │ error: "Conn reset"     │     │ cost_usd: 0.08          │
  └─────────────────────────┘     └─────────────────────────┘
```

### B. Artifact Metadata & Reference Tracking (`artifacts`)
Artifacts represent concrete outputs generated during task execution (git diff patches, unit test logs, code review verdicts, or compilation summaries).
- Stored as lightweight metadata records in the `artifacts` table referencing filesystem paths or inlined summaries.
- Prevents database bloat while providing full auditability and cross-agent sharing.

### C. WebSocket Delta Replay (`sync`)
When a browser client disconnects and reconnects:
1. The client sends `{ type: "sync", roomId: "prj_1", lastSeenSeq: 42 }`.
2. The server queries `events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT 101`.
3. If the delta is within bounds ($\le 100$), the server replays `{ type: "events_replay", events }`.
4. If the gap is $> 100$ events, it transparently sends a fresh full snapshot (`view`), ensuring the UI stays completely synchronized.

---

## 2. Database Schema Additions (`apps/server/src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL, -- 'running' | 'completed' | 'failed' | 'timed_out' | 'canceled'
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  error_message TEXT,
  cost_usd REAL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts (task_id, attempt_number);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  creator_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'diff' | 'test_report' | 'review' | 'log'
  title TEXT NOT NULL,
  summary TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_id);
```

---

## 3. REST API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/tasks/:id/attempts` | Returns execution attempt history for a task. |
| `GET` | `/api/tasks/:id/artifacts` | Returns all artifacts linked to a specific task. |
| `POST` | `/api/tasks/:id/artifacts` | Creates a new artifact record linked to the task. |
| `GET` | `/api/projects/:id/artifacts` | Returns recent artifacts across an entire project. |

---

## 4. Frontend Command Center & Inspector Integration (`apps/web/index.html`)

### A. Command Center Tabs (`Attempts` & `Artifacts`)
- Added dedicated `Attempts` and `Artifacts` tabs to the Command Center view for all agents.
- **Attempts Tab (`ccRenderAttempts`)**: Renders chronological execution attempts with status badges (`✓ Completed`, `✕ Failed`, `⏱ Timed Out`, `⊘ Canceled`, `● Running`), duration, exit codes, costs, and expandable error diagnostics.
- **Artifacts Tab (`ccRenderArtifacts`)**: Displays type badges (`📄 DIFF`, `🧪 TEST REPORT`, `🔍 REVIEW`, `📋 LOG`), inlined summaries, and safe relative file paths.
- **Race-Condition Protection**: Employs monotonic request tokens (`_activeAttemptsReq`, `_activeArtifactsReq`) to eliminate stale overwrites during rapid agent switching.

### B. Inspector Drawer Sub-Panels (`updateInspector`)
- Added inline sub-panel switcher (`[Attempts (N)] [Artifacts (N)]`) directly inside the floating `#inspector` drawer.
- Operators can inspect the active task's retry history and generated outputs immediately upon clicking any agent on the floor without leaving their current view.

---

## 5. Verification & Testing

- Automated unit tests in `apps/server/src/agentCoordination.test.ts` verify:
  - First execution attempt creation and idempotency.
  - History preservation across retries.
  - Active attempt failure on lease timeout.
  - Artifact creation, task retrieval, and project-scoped querying.
  - Path traversal protection on artifact paths.
  - WebSocket delta event queries, project isolation, and sequence ordering.
- Complete test suite: **373 passed tests (100% green)** across all 47 test files.
