# LogBridge Phase 2: Multi-Agent Workflows, Task DAG Engine & Collaboration

## Overview
Building on the Phase 1 coordination foundation, Phase 2 implements a multi-agent workflow and collaboration engine for LogBridge.

It enables multiple autonomous agents within a project to collaborate on complex, multi-stage goals via:
1. **Task Dependency DAGs**: Explicit dependencies between tasks with cycle detection and automatic eligibility evaluation.
2. **Project-Scoped Workflows**: First-class workflows grouping related tasks with lifecycle states (`active`, `paused`, `completed`, `failed`, `canceled`).
3. **Dependency-Aware Orchestration**: Orchestrator automatically gates task dispatch until all dependencies reach terminal `completed` status.
4. **Agent-to-Agent Handoffs**: Direct context, instruction, and artifact transfers delivered directly to agent Hive mailboxes and project event timelines.
5. **Code Review & Rework Workflows**: Formal review verdicts (`approved`, `changes_requested`) generating linked review artifacts and follow-up rework tasks without violating terminal FSM invariants.
6. **Command Center Observability & Human Override**: Visual DAG view in Command Center with live status badges, manual handoff triggers, and workflow control buttons.

---

## 1. Architecture & Schema

### A. Workflows (`workflows`)
```sql
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  creator_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'completed' | 'failed' | 'canceled'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows (project_id);
```

### B. Task Dependencies (`task_dependencies`)
```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies (task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies (depends_on_task_id);
```

### C. Task Model Enhancements (`tasks`)
- `workflow_id TEXT`: Links task to an overarching workflow.
- `retry_of TEXT`: Preserves ancestor lineage when spawning review rework tasks.

---

## 2. Dependency & Orchestration Engine

```text
               Workflow: Add OAuth 2.0
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
[1. Architecture] ───► [2. Backend API] ──► [3. Frontend UI]
 (Planner Agent)         (Developer)             (Dev 2)
                              │                     │
                              └──────────┬──────────┘
                                         ▼
                               [4. Integration Tests]
                                    (QA Agent)
                                         │
                                         ▼
                               [5. Code Review Gate]
                                   (Reviewer)
                                   /       \
                        Approved  /         \ Changes Requested
                                 ▼           ▼
                            [Completed]  [Rework Task]
```

### Dependency Rules:
1. **Self-Dependency Rejection**: `task_id === depends_on_task_id` rejected immediately.
2. **Cross-Project Protection**: Tasks must belong to the identical `project_id`.
3. **Cycle Detection (`hasDependencyCycle`)**: BFS traversal detects 2-node and multi-node cyclic loops before insertion.
4. **Automatic Eligibility**: `pendingUnassignedTasks` filters out tasks with incomplete dependencies or inactive workflows.
5. **Event Triggers**: When a dependency completes, `task.dependency_satisfied` is emitted and ready tasks are dispatched to runners automatically. If a dependency fails, `task.dependency_blocked` is emitted.

---

## 3. Agent-to-Agent Handoffs & Code Reviews

### Handoff Protocol (`POST /api/tasks/:id/handoff`)
- Reassigns task from `fromAgentId` to `toAgentId`.
- Verifies same-project boundaries for agents, tasks, and linked artifacts.
- Posts structured speech act (`act: "request"`) directly into the recipient's Hive mailbox.
- Emits `agent.handoff` with instructions and artifact references (`artifactRefs`).

### Review Protocol (`POST /api/tasks/:id/review`)
- Evaluates task output with verdict: `approved` | `changes_requested`.
- Stores review artifact in `artifacts` table (`kind: "review"`).
- Emits `agent.review_completed`.
- If `changes_requested`, automatically spawns a linked follow-up task (`[Rework] <title>`) with `parent_task` and `retry_of` set to the original task, preserving terminal FSM invariants.

---

## 4. REST API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/projects/:id/workflows` | Create a new workflow for a project. |
| `GET` | `/api/projects/:id/workflows` | List all workflows in a project. |
| `GET` | `/api/workflows/:id` | Get workflow details and complete DAG graph (nodes & edges). |
| `POST` | `/api/workflows/:id/tasks` | Create or attach a task to a workflow with optional dependencies. |
| `POST` | `/api/workflows/:id/pause` | Pause workflow execution (suspends dispatch of its tasks). |
| `POST` | `/api/workflows/:id/resume` | Resume workflow execution (re-triggers orchestrator). |
| `POST` | `/api/workflows/:id/cancel` | Cancel workflow and halts any pending tasks. |
| `POST` | `/api/tasks/:id/dependencies` | Link a dependency (`dependsOnTaskId`) to a task. |
| `GET` | `/api/tasks/:id/dependencies` | Query task dependencies, dependents, and satisfaction status. |
| `DELETE` | `/api/tasks/:id/dependencies/:depId` | Remove a dependency link. |
| `POST` | `/api/tasks/:id/handoff` | Hand off task to another agent with context and artifact refs. |
| `POST` | `/api/tasks/:id/review` | Submit code review with verdict (`approved` / `changes_requested`). |

---

## 5. Verification & Testing

- Comprehensive test suite in `apps/server/src/workflows.test.ts` (8 dedicated tests):
  - Self-dependency and cross-project rejection.
  - 2-node and multi-node circular dependency detection.
  - Dependency completion resolution and failed dependency blocking.
  - Workflow creation, DAG graph projection, and pause/resume lifecycle.
  - Dependency-aware orchestrator task assignment.
  - Full REST API lifecycle execution with handoffs and review rework tasks.
- Complete repository test suite: **381 passed tests (100% green)** across all 48 test files.
