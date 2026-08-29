# Phase 4: Autonomous Agent Teams, Planning & Dynamic Replanning

## Overview
Phase 4 introduces the **Autonomous Agent Teams, Planning & Dynamic Replanning Layer** to LogBridge.

Users can submit high-level product engineering goals (e.g. *"Add OAuth authentication with Google, update the frontend, create tests, and ensure nothing is broken"*). The autonomous planning engine analyzes the goal, constructs a multi-role, wave-partitioned execution plan, enables interactive human review and editing, autonomously materializes and executes the plan across specialized agent roles, and triggers non-destructive dynamic replanning upon failures without ever mutating historical execution records.

---

## 1. Data Model & Architecture

### Database Tables ([`apps/server/src/db.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/db.ts))

```sql
-- Execution Goals
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'planning' | 'awaiting_approval' | 'approved' | 'executing' | 'paused' | 'replanning' | 'completed' | 'failed' | 'canceled'
  workflow_id TEXT,
  creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals (project_id);

-- Plan Revisions (Preserves complete revision and replanning history)
CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'awaiting_approval' | 'approved' | 'superseded' | 'rejected'
  summary TEXT,
  steps_json TEXT NOT NULL, -- JSON array of PlanStep items
  impact_analysis_json TEXT, -- JSON impact analysis when created during replanning
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_revisions_goal ON plan_revisions (goal_id, revision_number);
```

---

## 2. Structured Planning Engine & Execution Waves

### Planning Engine ([`apps/server/src/planner.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/planner.ts))
- **`generatePlanDraft(goalTitle, goalDescription)`**: Decomposes high-level goals into multi-role engineering steps with capabilities, roles, risk levels, and dependencies.
- **Execution Waves (`deriveExecutionWaves`)**: Topologically partitions steps into parallel execution waves:
  - **Wave 1**: Independent steps (zero dependencies) can run immediately in parallel.
  - **Wave 2**: Steps dependent solely on Wave 1 outputs.
  - **Wave N**: Steps dependent on Wave < N outputs.
- **Materialization (`materializePlan`)**:
  - Creates a `Workflow` in `workflows`.
  - Creates executable `Tasks` tagged with `suggested_role`, `wave`, and `goal_id`.
  - Creates `task_dependencies` in SQLite representing the exact DAG.
  - Leaves historical task and attempt records immutable.

```typescript
export interface PlanStep {
  id: string;
  stepNumber: number;
  title: string;
  description: string;
  requiredCapabilities: string[];
  suggestedRole: "planner" | "architect" | "backend" | "frontend" | "reviewer" | "qa" | "devops" | "researcher" | "generalist";
  dependencies: string[];
  expectedOutputs: string[];
  riskLevel: "low" | "medium" | "high";
  estimatedSeconds?: number;
  wave?: number;
  materializedTaskId?: string;
}
```

---

## 3. Dynamic Replanning & Impact Analysis

### Impact Engine ([`apps/server/src/replanning.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/replanning.ts))
- When a task fails or a bottleneck occurs:
  - `analyzePlanImpact(db, goalId, failedTaskId)` traverses the DAG downstream from the failed node to identify all transitively blocked tasks.
  - Guarantees completed tasks are **never deleted or modified**.
  - Formulates 3 actionable remediation strategies:
    1. **Specialist Worker Rework**: Re-executes the failed step with alternative agent specialization.
    2. **Decompose Step into Sub-tasks**: Splits the problematic step into 2 smaller, lower-risk sub-steps.
    3. **Rework Downstream Architecture**: Redesigns the downstream path to bypass the blocked constraint.
- `applyPlanRevision(db, goalId, optionId)`:
  - Creates a new plan revision (`revision_number = current + 1`).
  - Sets previous revision to `superseded`.
  - Materializes replacement tasks for the reworked steps.
  - Restores goal state to `executing`.

---

## 4. Context Builder Integration

### Context Integration ([`apps/server/src/contextBuilder.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/contextBuilder.ts))
- Tasks materialized from Goals automatically receive:
  1. **Goal Specification**: High-level goal directives and user spec.
  2. **Plan Step Metadata**: Suggested role, execution wave, and expected outputs.
  3. **Dependency Outputs & Artifacts**: Predecessor test reports, diffs, and review results.
  4. **Lineage Diagnostics**: Previous failure error messages if retrying or replanning.
  5. **Project Memories**: Team knowledge and architecture decisions.

---

## 5. REST APIs & Command Center UI

### Endpoints ([`apps/server/src/index.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/index.ts))
- `POST /api/projects/:id/goals` — Create Goal
- `GET /api/projects/:id/goals` — List Goals
- `GET /api/goals/:id` — Get Goal details & active plan revision
- `POST /api/goals/:id/generate-plan` — Generate Plan Draft
- `PUT /api/goals/:id/plan` — Edit plan steps
- `POST /api/goals/:id/plan/approve` — Approve Plan & materialize Workflow/Tasks/DAG
- `POST /api/goals/:id/execute` — Execute or resume Goal
- `POST /api/goals/:id/pause` / `POST /api/goals/:id/resume` / `POST /api/goals/:id/cancel` — Lifecycle controls
- `GET /api/goals/:id/impact` — Run Impact Analysis
- `POST /api/goals/:id/replan` — Apply dynamic plan revision

### Command Center UI ([`apps/web/index.html`](file:///Users/ayush/Project/LogBridge/apps/web/index.html))
- **`🎯 Goals` Tab**:
  - Interactive Goal Cards with status pills (`Draft`, `Awaiting Approval`, `Executing`, `Replanning`, `Completed`).
  - Visual **Execution Waves Board** displaying steps, roles, risk levels, and dependencies.
  - Interactive Plan controls (`⚡ Generate Plan`, `🚀 Approve & Execute`, `🔄 Dynamic Replan`).
