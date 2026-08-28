// Agent & Supervisor Escalation Engine (Phase 5).
// Creates structured human escalations for degraded workflows, exhausted retries, or critical bottlenecks.

import type { Db } from "./db.js";
import { appendEvent } from "./db.js";
import { recordAuditLog } from "./audit.js";

export type EscalationUrgency = "low" | "medium" | "high" | "critical";
export type EscalationState = "open" | "resolved" | "dismissed";

export interface Escalation {
  id: string;
  projectId: string;
  workflowId: string | null;
  taskId: string | null;
  goalId: string | null;
  agentId: string | null;
  urgency: EscalationUrgency;
  title: string;
  reason: string;
  state: EscalationState;
  recommendedActions: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
}

export function createEscalation(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    workflowId?: string | null;
    taskId?: string | null;
    goalId?: string | null;
    agentId?: string | null;
    urgency?: EscalationUrgency;
    title: string;
    reason: string;
    recommendedActions?: string[];
  }
): string {
  const id = opts.id || `esc_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const urgency = opts.urgency ?? "medium";

  db.prepare(
    `INSERT INTO escalations (
      id, project_id, workflow_id, task_id, goal_id, agent_id,
      urgency, title, reason, state, recommended_actions_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.workflowId ?? null,
    opts.taskId ?? null,
    opts.goalId ?? null,
    opts.agentId ?? null,
    urgency,
    opts.title,
    opts.reason,
    JSON.stringify(opts.recommendedActions ?? ["Manual Operator Review", "Reassign Task", "Adjust Retry Policy"]),
    now
  );

  appendEvent(db, opts.projectId, opts.taskId ?? null, "escalation.created", {
    escalationId: id,
    title: opts.title,
    urgency,
    reason: opts.reason,
  });

  recordAuditLog(db, {
    projectId: opts.projectId,
    actorType: opts.agentId ? "agent" : "supervisor",
    actorId: opts.agentId ?? "supervisor",
    action: "escalation.created",
    resourceType: "workflow",
    resourceId: opts.workflowId ?? opts.taskId ?? id,
    metadata: {
      title: opts.title,
      urgency,
      reason: opts.reason,
    },
  });

  return id;
}

export function resolveEscalation(
  db: Db,
  escalationId: string,
  userId: string,
  notes?: string
): boolean {
  const row = db.prepare("SELECT * FROM escalations WHERE id = ?").get(escalationId) as any;
  if (!row || row.state !== "open") return false;

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE escalations SET state = 'resolved', resolved_at = ?, resolved_by = ?, resolution_notes = ? WHERE id = ?"
  ).run(now, userId, notes ?? null, escalationId);

  appendEvent(db, row.project_id, row.task_id, "escalation.resolved", {
    escalationId,
    resolvedBy: userId,
    notes: notes ?? null,
  });

  recordAuditLog(db, {
    projectId: row.project_id,
    actorType: "user",
    actorId: userId,
    action: "escalation.resolved",
    resourceType: "workflow",
    resourceId: escalationId,
    metadata: { notes: notes ?? null },
  });

  return true;
}

export function getProjectEscalations(
  db: Db,
  projectId: string,
  state?: EscalationState
): Escalation[] {
  let sql = "SELECT * FROM escalations WHERE project_id = ?";
  const params: any[] = [projectId];
  if (state) {
    sql += " AND state = ?";
    params.push(state);
  }
  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    workflowId: r.workflow_id,
    taskId: r.task_id,
    goalId: r.goal_id,
    agentId: r.agent_id,
    urgency: r.urgency,
    title: r.title,
    reason: r.reason,
    state: r.state,
    recommendedActions: r.recommended_actions_json ? JSON.parse(r.recommended_actions_json) : [],
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolutionNotes: r.resolution_notes,
  }));
}
