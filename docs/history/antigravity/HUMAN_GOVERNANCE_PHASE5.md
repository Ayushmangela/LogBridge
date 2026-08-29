# Phase 5: Human Collaboration, Approvals, Governance & Permissions

## Overview
Phase 5 introduces the **Human-in-the-Loop Collaboration, Governance & Permission System** to LogBridge.

It establishes an authoritative security, policy, and human authorization layer that enables autonomous agents to execute independent tasks while systematically gating critical, destructive, expensive, or policy-constrained actions behind human review.

---

## 1. Core Architecture & Modules

```text
AGENT / WORKFLOW / SUPERVISOR
             │
             ▼
POLICY ENGINE (policyEngine.ts)
   ├── Risk Rules (low, medium, high, critical)
   ├── Cost Rules (> $5.00)
   ├── Destructive Rules (workflow cancel, delete)
   └── Autonomous Thresholds (retries >= 3)
             │
             ├── [ALLOW] ──────────► Autonomous Execution Continues
             │
             └── [REQUIRE_APPROVAL]
                       │
                       ▼
             APPROVAL REQUESTS (approvals.ts)
                 ├── Emits approval.requested event
                 ├── Records in immutable audit log
                 └── Blocks only affected action
                       │
                       ▼
             HUMAN OPERATOR / REVIEWER
                 ├── Inspects Reason, Risk, Proposed Action
                 │
                 ├── [APPROVE] ────► Executes Proposed Payload & Resumes Execution
                 │
                 └── [REJECT]  ────► Records Reason & Triggers Recovery/Cancel
```

---

## 2. Database Models ([`apps/server/src/db.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/db.ts))

### Approval Requests (`approval_requests`)
```sql
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_id TEXT,
  goal_id TEXT,
  task_id TEXT,
  requester_id TEXT NOT NULL,
  requester_type TEXT NOT NULL DEFAULT 'agent', -- 'agent' | 'user' | 'supervisor'
  approval_type TEXT NOT NULL, -- 'plan_approval' | 'execution_approval' | 'destructive_action' | 'deployment' | 'high_cost_action' | 'retry_override' | 'workflow_cancel' | 'policy_exception'
  title TEXT NOT NULL,
  description TEXT,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'critical'
  proposed_action_json TEXT, -- JSON payload executed upon approval
  state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'expired' | 'canceled'
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_comment TEXT,
  expires_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_project ON approval_requests (project_id, state);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approval_requests (task_id);
```

### Immutable Project Audit Logs (`audit_logs`)
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_type TEXT NOT NULL, -- 'user' | 'agent' | 'supervisor' | 'system'
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs (project_id, timestamp);
```

### Agent & Supervisor Escalations (`escalations`)
```sql
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  goal_id TEXT,
  agent_id TEXT,
  urgency TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'critical'
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed'
  recommended_actions_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_escalations_project ON escalations (project_id, state);
```

---

## 3. Role-Based Access Control (RBAC) & Permissions ([`apps/server/src/authorization.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/authorization.ts))

### Project Roles
- `owner`: Full unrestricted access (`*`)
- `admin`: Project management, team membership, goal/workflow management, policy management, approvals
- `manager`: Goal/workflow creation, task assignment, approval resolution, escalations
- `operator`: Workflow execution, task controls, approval requests
- `reviewer`: Code reviews, task reviews, approval resolution
- `member`: Standard workspace contributor
- `viewer`: Read-only access to office, tasks, audit logs, and approvals

### Strict Security Invariants
- **Server-Side Authorization**: Every state change and sensitive API asserts permissions (`hasPermission` / `assertPermission`).
- **Strict Project Isolation**: Users from Project A can never access, approve, or query Project B resources.

---

## 4. Policy Engine ([`apps/server/src/policyEngine.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/policyEngine.ts))

- **`CRITICAL_RISK_GATE`**: Actions marked with `riskLevel: "critical"` require explicit human authorization.
- **`COST_THRESHOLD_GATE`**: Actions exceeding `$5.00` in estimated execution cost require operator sign-off.
- **`DESTRUCTIVE_ACTION_GATE`**: Cancelling active multi-task workflows or deleting active resources requires confirmation.
- **`RETRY_LIMIT_GATE`**: Tasks that have failed 3+ times require human override before launching further attempts.

---

## 5. REST APIs & Command Center UI

### REST Endpoints ([`apps/server/src/index.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/index.ts))
- `GET /api/projects/:id/approvals` — List project approvals
- `GET /api/approvals/:id` — Get approval details & payload
- `POST /api/approvals/:id/approve` — Approve request & execute action payload
- `POST /api/approvals/:id/reject` — Reject request with reason
- `POST /api/projects/:id/approvals` — Create manual approval request
- `GET /api/projects/:id/audit` — Get project audit trail
- `GET /api/projects/:id/escalations` — List active escalations
- `POST /api/escalations/:id/resolve` — Resolve escalation
- `GET /api/projects/:id/members` — List members & roles
- `POST /api/projects/:id/members` — Add member with role
- `PUT /api/projects/:id/members/:userId` — Update member role
- `DELETE /api/projects/:id/members/:userId` — Remove member

### Command Center UI ([`apps/web/index.html`](file:///Users/ayush/Project/LogBridge/apps/web/index.html))
- **`🛡️ Approvals` Tab**:
  - **Pending Approvals Queue**: Live cards with Risk badges (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`), requesting agent, reason, proposed action preview, and `[ ✅ Approve ]` / `[ ❌ Reject ]` dialogs.
  - **Active Escalations**: Urgent supervisor notifications for blocked or stalled pipelines with `[ Resolve ]` controls.
  - **Immutable Audit Trail**: Chronological stream of all governance, permission, and workflow state actions.
  - **Team Roles & Permissions**: Interactive project member roster with role pills and permission controls.
