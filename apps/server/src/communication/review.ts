// Typed Review Verdicts & Automated Rework Lifecycle.
// Manages REVIEW_RESULT processing, downstream dependency unlocking, linked rework tasks, and rework escalation.

import type { Db } from "../db.js";
import {
  getTask,
  setTaskState,
  createTask,
  createReviewVerdict,
  getTaskDependents,
  isTaskDependenciesSatisfied,
  appendEvent,
} from "../db.js";
import { emitSequenceEvent } from "./sequenceEvents.js";
import { createEscalation } from "../escalations.js";
import type { ReviewResult, ReviewFinding } from "./types.js";

export function processReviewResult(
  db: Db,
  opts: {
    taskId: string;
    reviewerAgentId: string;
    status: "ACCEPT" | "REJECT";
    comments: string[];
    artifactId?: string;
    findings?: ReviewFinding[];
    maxReworkAttempts?: number;
    correlationId?: string;
  }
): {
  ok: boolean;
  status: "ACCEPT" | "REJECT";
  reworkTaskId?: string;
  escalated?: boolean;
  reviewResult: ReviewResult;
} {
  const task = getTask(db, opts.taskId);
  if (!task) {
    throw new Error(`Task ${opts.taskId} not found`);
  }

  const reviewer = db.prepare("SELECT name FROM agents WHERE id = ?").get(opts.reviewerAgentId) as any;
  const reviewerName = reviewer?.name ?? opts.reviewerAgentId;
  const correlationId = opts.correlationId ?? `corr_${crypto.randomUUID()}`;

  const verdictRow = createReviewVerdict(db, {
    projectId: task.project_id,
    taskId: task.id,
    reviewerAgentId: opts.reviewerAgentId,
    status: opts.status,
    comments: opts.comments,
    artifactId: opts.artifactId,
    findings: opts.findings,
    correlationId,
  });

  const reviewResult: ReviewResult = {
    type: "REVIEW_RESULT",
    taskId: task.id,
    projectId: task.project_id,
    reviewerAgentId: opts.reviewerAgentId,
    status: opts.status,
    comments: opts.comments,
    artifactId: opts.artifactId,
    findings: opts.findings,
    correlationId,
  };

  const devAgentId = task.agent_id ?? "developer";
  const devAgent = task.agent_id
    ? (db.prepare("SELECT name FROM agents WHERE id = ?").get(task.agent_id) as any)
    : null;
  const devName = devAgent?.name ?? devAgentId;

  if (opts.status === "ACCEPT") {
    // 1. Mark task completed
    setTaskState(db, task.id, "completed", { ended_at: new Date().toISOString() });

    // Emit Sequence Event: REVIEW_RESULT (ACCEPT)
    emitSequenceEvent(db, {
      projectId: task.project_id,
      taskId: task.id,
      correlationId,
      type: "REVIEW_RESULT",
      source: { type: "AGENT", id: opts.reviewerAgentId, label: reviewerName },
      target: { type: "AGENT", id: devAgentId, label: devName },
      summary: `Review ACCEPTED for "${task.title}": ${opts.comments[0] || "Passed verification"}`,
      metadata: { status: "ACCEPT", findings: opts.findings, artifactId: opts.artifactId },
    });

    // Emit Sequence Event: TASK_COMPLETED
    emitSequenceEvent(db, {
      projectId: task.project_id,
      taskId: task.id,
      correlationId,
      type: "TASK_COMPLETED",
      source: { type: "AGENT", id: devAgentId, label: devName },
      target: { type: "AGENT", id: "commander", label: "Commander" },
      summary: `Task "${task.title}" completed successfully`,
      metadata: { taskId: task.id },
    });

    // 2. Unlock downstream workflow DAG dependencies
    const dependents = getTaskDependents(db, task.id);
    for (const dep of dependents) {
      if (isTaskDependenciesSatisfied(db, dep.taskId)) {
        appendEvent(db, task.project_id, dep.taskId, "task.dependency_satisfied", {
          completedDependency: task.id,
          taskId: dep.taskId,
        });
      }
    }

    appendEvent(db, task.project_id, task.id, "task.review_accepted", {
      taskId: task.id,
      reviewerId: opts.reviewerAgentId,
      comments: opts.comments,
    });

    return { ok: true, status: "ACCEPT", reviewResult };
  } else {
    // REJECT path
    // Count previous rework attempts
    const rootTaskId = task.parent_task || task.id;
    const prevReworks = (
      db.prepare("SELECT count(*) as count FROM tasks WHERE retry_of IS NOT NULL AND (parent_task = ? OR id = ?)").get(rootTaskId, rootTaskId) as any
    )?.count ?? 0;

    const maxReworks = opts.maxReworkAttempts ?? 3;

    // Emit Sequence Event: REVIEW_RESULT (REJECT)
    emitSequenceEvent(db, {
      projectId: task.project_id,
      taskId: task.id,
      correlationId,
      type: "REVIEW_RESULT",
      source: { type: "AGENT", id: opts.reviewerAgentId, label: reviewerName },
      target: { type: "AGENT", id: devAgentId, label: devName },
      summary: `Review REJECTED for "${task.title}": ${opts.comments[0] || "Changes requested"} (${opts.findings?.length ?? 0} findings)`,
      metadata: { status: "REJECT", findings: opts.findings, comments: opts.comments },
    });

    if (prevReworks >= maxReworks) {
      // Escalation due to max rework attempts exceeded
      emitSequenceEvent(db, {
        projectId: task.project_id,
        taskId: task.id,
        correlationId,
        type: "REWORK_ESCALATED",
        source: { type: "SYSTEM", id: "review_engine", label: "Review Engine" },
        target: { type: "AGENT", id: "commander", label: "Commander" },
        summary: `Maximum rework attempts (${maxReworks}) exceeded for task "${task.title}". Escalating to human.`,
        metadata: { rootTaskId, attempts: prevReworks + 1 },
      });

      createEscalation(db, {
        projectId: task.project_id,
        taskId: task.id,
        workflowId: task.workflow_id,
        urgency: "high",
        title: `Max Rework Exceeded: Task ${task.id}`,
        reason: `Task failed review ${prevReworks + 1} times: ${opts.comments.join("; ")}`,
        recommendedActions: ["Reassign to Senior Agent", "Modify Task Requirements", "Manual Override"],
      });

      return { ok: true, status: "REJECT", escalated: true, reviewResult };
    }

    // Spawn linked rework task
    const nextAttempt = prevReworks + 2;
    const reworkTitle = `[Rework #${nextAttempt}] ${task.title.replace(/^\[Rework #\d+\]\s*/, "")}`;
    let reworkNotes = `\n\n### Reviewer Notes:\n` + opts.comments.join("\n");
    if (opts.findings && opts.findings.length > 0) {
      reworkNotes += `\n\n### Review Findings to Address:\n` + opts.findings.map((f) => `- [${f.severity}] ${f.message}${f.file ? ` (${f.file}:${f.line ?? 1})` : ""}`).join("\n");
    }

    const reworkSpec = (task.spec ?? "") + reworkNotes;

    const reworkTaskId = createTask(db, {
      projectId: task.project_id,
      title: reworkTitle,
      spec: reworkSpec,
      creatorId: opts.reviewerAgentId,
      parentTask: rootTaskId,
      retryOf: task.id,
      workflowId: task.workflow_id,
      requiredCapability: task.required_capability,
      agentId: task.agent_id ?? undefined,
    });

    // Emit Sequence Event: REWORK_CREATED
    emitSequenceEvent(db, {
      projectId: task.project_id,
      taskId: reworkTaskId,
      correlationId,
      type: "REWORK_CREATED",
      source: { type: "AGENT", id: opts.reviewerAgentId, label: reviewerName },
      target: { type: "AGENT", id: devAgentId, label: devName },
      summary: `Created linked rework task #${nextAttempt} for "${task.title}"`,
      metadata: { originalTaskId: task.id, reworkTaskId, attempt: nextAttempt },
    });

    appendEvent(db, task.project_id, task.id, "task.rework_created", {
      originalTaskId: task.id,
      reworkTaskId,
      attempt: nextAttempt,
      reviewerId: opts.reviewerAgentId,
    });

    return { ok: true, status: "REJECT", reworkTaskId, reviewResult };
  }
}
