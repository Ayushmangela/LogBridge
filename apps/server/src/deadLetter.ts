// Dead Letter Queue & Permanent Failure Engine (Phase 6).
// Captures exhausted retries and unrecoverable failures with rich context and human reprocessing options.

import type { Db } from "./db.js";
import { appendEvent, createTask, getTask, getTaskAttempts, getTaskArtifacts } from "./db.js";
import { recordAuditLog } from "./audit.js";
import { createEscalation } from "./escalations.js";

export type DeadLetterStatus = "pending" | "reprocessed" | "dismissed";
export type DeadLetterAction = "RETRY" | "REASSIGN" | "REPLAN" | "ESCALATE_HUMAN" | "DISMISS";

export interface DeadLetterRecord {
  id: string;
  projectId: string;
  taskId: string;
  workflowId: string | null;
  goalId: string | null;
  failureCategory: string;
  retryAttempts: number;
  lastError: string | null;
  artifactRefs: string[];
  recommendedAction: DeadLetterAction;
  status: DeadLetterStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
}

export function moveToDeadLetter(
  db: Db,
  opts: {
    projectId: string;
    taskId: string;
    workflowId?: string | null;
    goalId?: string | null;
    failureCategory: string;
    retryAttempts?: number;
    lastError?: string | null;
    recommendedAction?: DeadLetterAction;
  }
): string {
  const id = `dlq_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // Gather existing artifacts for diagnostic preservation
  const artifacts = getTaskArtifacts(db, opts.taskId);
  const artifactRefs = artifacts.map((a) => a.id);

  // If retryAttempts not given, count physical attempts in task_attempts
  const attempts = getTaskAttempts(db, opts.taskId);
  const retryCount = opts.retryAttempts ?? Math.max(0, attempts.length - 1);

  const action = opts.recommendedAction ?? "RETRY";

  db.prepare(
    `INSERT INTO dead_letter_tasks (
      id, project_id, task_id, workflow_id, goal_id, failure_category,
      retry_attempts, last_error, artifact_refs_json, recommended_action,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    opts.projectId,
    opts.taskId,
    opts.workflowId ?? null,
    opts.goalId ?? null,
    opts.failureCategory,
    retryCount,
    opts.lastError ?? null,
    JSON.stringify(artifactRefs),
    action,
    now
  );

  appendEvent(db, opts.projectId, opts.taskId, "dead_letter.created", {
    deadLetterId: id,
    taskId: opts.taskId,
    failureCategory: opts.failureCategory,
    recommendedAction: action,
  });

  recordAuditLog(db, {
    projectId: opts.projectId,
    actorType: "system",
    actorId: "dead_letter_engine",
    action: "dead_letter.created",
    resourceType: "task",
    resourceId: opts.taskId,
    metadata: {
      deadLetterId: id,
      failureCategory: opts.failureCategory,
      retryCount,
      lastError: opts.lastError,
    },
  });

  if (action === "ESCALATE_HUMAN") {
    createEscalation(db, {
      projectId: opts.projectId,
      taskId: opts.taskId,
      workflowId: opts.workflowId,
      goalId: opts.goalId,
      urgency: "high",
      title: `Dead Letter Escalation: Task ${opts.taskId}`,
      reason: opts.lastError || `Task moved to dead letter queue (${opts.failureCategory})`,
      recommendedActions: ["Manual Retry", "Reassign to Specialist", "Cancel Workflow"],
    });
  }

  return id;
}

export function getProjectDeadLetters(
  db: Db,
  projectId: string,
  status?: DeadLetterStatus
): DeadLetterRecord[] {
  let sql = "SELECT * FROM dead_letter_tasks WHERE project_id = ?";
  const params: any[] = [projectId];
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    workflowId: r.workflow_id,
    goalId: r.goal_id,
    failureCategory: r.failure_category,
    retryAttempts: r.retry_attempts,
    lastError: r.last_error,
    artifactRefs: r.artifact_refs_json ? JSON.parse(r.artifact_refs_json) : [],
    recommendedAction: r.recommended_action,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolutionNotes: r.resolution_notes,
  }));
}

export function reprocessDeadLetter(
  db: Db,
  deadLetterId: string,
  action: DeadLetterAction,
  userId: string,
  notes?: string
): { ok: boolean; retriedTaskId?: string; error?: string } {
  const row = db.prepare("SELECT * FROM dead_letter_tasks WHERE id = ?").get(deadLetterId) as any;
  if (!row) return { ok: false, error: "dead letter record not found" };
  if (row.status !== "pending") return { ok: false, error: `dead letter task is already ${row.status}` };

  const now = new Date().toISOString();
  const nextStatus = action === "DISMISS" ? "dismissed" : "reprocessed";

  db.prepare(
    "UPDATE dead_letter_tasks SET status = ?, resolved_at = ?, resolved_by = ?, resolution_notes = ? WHERE id = ?"
  ).run(nextStatus, now, userId, notes ?? null, deadLetterId);

  let retriedTaskId: string | undefined;

  if (action === "RETRY" || action === "REASSIGN") {
    const orig = getTask(db, row.task_id);
    if (orig) {
      retriedTaskId = createTask(db, {
        projectId: orig.project_id,
        title: `[Reprocessed] ${orig.title.replace(/^\[.*?\]\s*/, "")}`,
        spec: orig.spec,
        creatorId: userId,
        parentTask: orig.parent_task || orig.id,
        retryOf: orig.id,
        workflowId: orig.workflow_id,
        requiredCapability: orig.required_capability,
      });
    }
  }

  appendEvent(db, row.project_id, row.task_id, "dead_letter.resolved", {
    deadLetterId,
    action,
    resolvedBy: userId,
    retriedTaskId,
  });

  recordAuditLog(db, {
    projectId: row.project_id,
    actorType: "user",
    actorId: userId,
    action: "dead_letter.resolved",
    resourceType: "task",
    resourceId: row.task_id,
    metadata: { deadLetterId, action, notes, retriedTaskId },
  });

  return { ok: true, retriedTaskId };
}
