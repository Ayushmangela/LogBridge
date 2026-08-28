// First-Class Approval Requests & Human-in-the-Loop Gate Engine (Phase 5).
// Creates durable approval requests, blocks affected workflows, and executes approved payloads.

import type { Db } from "./db.js";
import { appendEvent, setGoalState, setWorkflowState, createTask, getTask } from "./db.js";
import { recordAuditLog } from "./audit.js";
import type { RiskLevel } from "./policyEngine.js";

export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "canceled";

export type ApprovalType =
  | "plan_approval"
  | "execution_approval"
  | "destructive_action"
  | "deployment"
  | "high_cost_action"
  | "retry_override"
  | "workflow_cancel"
  | "policy_exception";

export interface ApprovalRequest {
  id: string;
  projectId: string;
  workflowId: string | null;
  goalId: string | null;
  taskId: string | null;
  requesterId: string;
  requesterType: "agent" | "user" | "supervisor";
  approvalType: ApprovalType;
  title: string;
  description: string | null;
  reason: string;
  riskLevel: RiskLevel;
  proposedAction: any | null;
  state: ApprovalState;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionComment: string | null;
  expiresAt: string | null;
}

export function createApprovalRequest(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    workflowId?: string | null;
    goalId?: string | null;
    taskId?: string | null;
    requesterId: string;
    requesterType?: "agent" | "user" | "supervisor";
    approvalType: ApprovalType;
    title: string;
    description?: string | null;
    reason: string;
    riskLevel?: RiskLevel;
    proposedAction?: any | null;
    expiresAt?: string | null;
  }
): string {
  const id = opts.id || `appr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const risk = opts.riskLevel ?? "medium";

  db.prepare(
    `INSERT INTO approval_requests (
      id, project_id, workflow_id, goal_id, task_id,
      requester_id, requester_type, approval_type, title, description,
      reason, risk_level, proposed_action_json, state, requested_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.workflowId ?? null,
    opts.goalId ?? null,
    opts.taskId ?? null,
    opts.requesterId,
    opts.requesterType ?? "agent",
    opts.approvalType,
    opts.title,
    opts.description ?? null,
    opts.reason,
    risk,
    opts.proposedAction ? JSON.stringify(opts.proposedAction) : null,
    now,
    opts.expiresAt ?? null
  );

  appendEvent(db, opts.projectId, opts.taskId ?? null, "approval.requested", {
    approvalId: id,
    approvalType: opts.approvalType,
    title: opts.title,
    riskLevel: risk,
    requesterId: opts.requesterId,
  });

  recordAuditLog(db, {
    projectId: opts.projectId,
    actorType: opts.requesterType ?? "agent",
    actorId: opts.requesterId,
    action: "approval.requested",
    resourceType: "approval",
    resourceId: id,
    metadata: {
      title: opts.title,
      riskLevel: risk,
      approvalType: opts.approvalType,
    },
  });

  return id;
}

export function getApprovalRequest(db: Db, id: string): ApprovalRequest | null {
  const row = db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    requesterId: row.requester_id,
    requesterType: row.requester_type,
    approvalType: row.approval_type,
    title: row.title,
    description: row.description,
    reason: row.reason,
    riskLevel: row.risk_level,
    proposedAction: row.proposed_action_json ? JSON.parse(row.proposed_action_json) : null,
    state: row.state,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionComment: row.resolution_comment,
    expiresAt: row.expires_at,
  };
}

export function getProjectApprovals(
  db: Db,
  projectId: string,
  state?: ApprovalState
): ApprovalRequest[] {
  let sql = "SELECT * FROM approval_requests WHERE project_id = ?";
  const params: any[] = [projectId];
  if (state) {
    sql += " AND state = ?";
    params.push(state);
  }
  sql += " ORDER BY requested_at DESC";

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    requesterId: row.requester_id,
    requesterType: row.requester_type,
    approvalType: row.approval_type,
    title: row.title,
    description: row.description,
    reason: row.reason,
    riskLevel: row.risk_level,
    proposedAction: row.proposed_action_json ? JSON.parse(row.proposed_action_json) : null,
    state: row.state,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionComment: row.resolution_comment,
    expiresAt: row.expires_at,
  }));
}

export function resolveApprovalRequest(
  db: Db,
  approvalId: string,
  userId: string,
  resolution: "approved" | "rejected",
  comment?: string
): { ok: boolean; executedAction?: boolean; error?: string } {
  const req = getApprovalRequest(db, approvalId);
  if (!req) return { ok: false, error: "approval request not found" };
  if (req.state !== "pending") return { ok: false, error: `approval request is already ${req.state}` };

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE approval_requests SET state = ?, resolved_at = ?, resolved_by = ?, resolution_comment = ? WHERE id = ?"
  ).run(resolution, now, userId, comment ?? null, approvalId);

  appendEvent(db, req.projectId, req.taskId ?? null, `approval.${resolution}`, {
    approvalId,
    resolvedBy: userId,
    comment: comment ?? null,
  });

  recordAuditLog(db, {
    projectId: req.projectId,
    actorType: "user",
    actorId: userId,
    action: `approval.${resolution}`,
    resourceType: "approval",
    resourceId: approvalId,
    metadata: {
      title: req.title,
      approvalType: req.approvalType,
      comment: comment ?? null,
    },
  });

  let executedAction = false;
  // If approved, execute proposed action payload if specified
  if (resolution === "approved" && req.proposedAction) {
    const act = req.proposedAction;
    if (act.action === "resume_goal" && act.goalId) {
      setGoalState(db, act.goalId, "executing");
      executedAction = true;
    } else if (act.action === "cancel_workflow" && act.workflowId) {
      setWorkflowState(db, act.workflowId, "canceled");
      executedAction = true;
    } else if (act.action === "retry_task" && act.taskId) {
      const orig = getTask(db, act.taskId);
      if (orig) {
        createTask(db, {
          projectId: orig.project_id,
          title: `[Approved Retry] ${orig.title.replace(/^\[.*?\]\s*/, "")}`,
          spec: orig.spec,
          creatorId: userId,
          parentTask: orig.parent_task || orig.id,
          retryOf: orig.id,
          workflowId: orig.workflow_id,
          requiredCapability: orig.required_capability,
        });
        executedAction = true;
      }
    }
  }

  return { ok: true, executedAction };
}
