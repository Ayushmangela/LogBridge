// Autonomous Workflow Supervisor & Recovery Engine (Phase 3).
// Evaluates workflow health, detects bottlenecks/stalls, and executes controlled recovery actions.

import type { Db } from "./db.js";
import {
  getWorkflow,
  getTask,
  setWorkflowState,
  createTask,
  addTaskDependency,
  getTaskDependencies,
  getTaskDependencyStatus,
  candidateAgents,
  appendEvent,
  haltTask,
} from "./db.js";

export type WorkflowHealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "BLOCKED"
  | "STALLED"
  | "FAILED"
  | "COMPLETED";

export interface WorkflowIssue {
  code:
    | "TASK_FAILED_MAX_RETRIES"
    | "DEPENDENCY_BLOCKED"
    | "AGENT_UNAVAILABLE"
    | "WORKFLOW_STALLED"
    | "HIGH_FAILURE_RATE";
  severity: "info" | "warning" | "error";
  taskId?: string;
  message: string;
}

export interface SupervisorRecommendation {
  action: "RETRY" | "REASSIGN" | "PAUSE" | "RESUME" | "CANCEL" | "ESCALATE_HUMAN";
  taskId?: string;
  recommendedAgentId?: string;
  reason: string;
}

export interface WorkflowHealthReport {
  workflowId: string;
  projectId: string;
  title: string;
  state: string;
  health: WorkflowHealthState;
  totalTasks: number;
  completedTasks: number;
  workingTasks: number;
  waitingTasks: number;
  blockedTasks: number;
  failedTasks: number;
  issues: WorkflowIssue[];
  recommendations: SupervisorRecommendation[];
}

export function evaluateWorkflowHealth(db: Db, workflowId: string): WorkflowHealthReport | null {
  const wf = getWorkflow(db, workflowId);
  if (!wf) return null;

  const tasks = db
    .prepare("SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC")
    .all(workflowId) as any[];

  const candidates = candidateAgents(db, wf.project_id);
  const onlineAgents = candidates.filter((c) => c.machineOnline);

  let completedTasks = 0;
  let workingTasks = 0;
  let waitingTasks = 0;
  let blockedTasks = 0;
  let failedTasks = 0;

  const issues: WorkflowIssue[] = [];
  const recommendations: SupervisorRecommendation[] = [];

  for (const t of tasks) {
    if (t.state === "completed") {
      completedTasks++;
      continue;
    }
    if (t.state === "working") {
      workingTasks++;
      continue;
    }
    if (t.state === "failed" || t.state === "rejected") {
      failedTasks++;
      // Check attempt count
      const attempts = db.prepare("SELECT * FROM task_attempts WHERE task_id = ?").all(t.id) as any[];
      if (attempts.length >= 3) {
        issues.push({
          code: "TASK_FAILED_MAX_RETRIES",
          severity: "error",
          taskId: t.id,
          message: `Task "${t.title}" exhausted all execution attempts (${attempts.length} attempts).`,
        });
        recommendations.push({
          action: "ESCALATE_HUMAN",
          taskId: t.id,
          reason: "Repeated failures require operator intervention",
        });
      } else {
        // Recommend retry on alternate agent
        const alternateAgent = onlineAgents.find((a) => a.id !== t.agent_id);
        recommendations.push({
          action: "RETRY",
          taskId: t.id,
          recommendedAgentId: alternateAgent?.id,
          reason: alternateAgent
            ? `Retry on alternate worker "${alternateAgent.name}"`
            : "Retry task after failure",
        });
      }
      continue;
    }

    // Submitted state: check dependencies
    const depStatus = getTaskDependencyStatus(db, t.id);
    if (depStatus.blocked) {
      blockedTasks++;
      issues.push({
        code: "DEPENDENCY_BLOCKED",
        severity: "error",
        taskId: t.id,
        message: `Task "${t.title}" is blocked by failed upstream dependencies.`,
      });
      recommendations.push({
        action: "ESCALATE_HUMAN",
        taskId: t.id,
        reason: "Upstream dependency failed, requiring manual resolution",
      });
    } else if (!depStatus.satisfied) {
      waitingTasks++;
    } else {
      // Ready to dispatch: verify capable agent exists
      if (onlineAgents.length === 0) {
        issues.push({
          code: "AGENT_UNAVAILABLE",
          severity: "warning",
          taskId: t.id,
          message: `Task "${t.title}" is ready but all machines are offline.`,
        });
        recommendations.push({
          action: "PAUSE",
          reason: "Pause workflow until machines reconnect",
        });
      } else if (t.required_capability && !onlineAgents.some((a) => a.capabilities.includes(t.required_capability))) {
        issues.push({
          code: "WORKFLOW_STALLED",
          severity: "error",
          taskId: t.id,
          message: `No online agent has required capability "${t.required_capability}".`,
        });
        recommendations.push({
          action: "ESCALATE_HUMAN",
          taskId: t.id,
          reason: `No online worker matches capability "${t.required_capability}"`,
        });
      }
    }
  }

  // Derive health
  let health: WorkflowHealthState = "HEALTHY";
  if (tasks.length > 0 && completedTasks === tasks.length) {
    health = "COMPLETED";
  } else if (blockedTasks > 0) {
    health = "BLOCKED";
  } else if (failedTasks > 0 && workingTasks === 0 && waitingTasks === 0) {
    health = "FAILED";
  } else if (issues.some((i) => i.code === "WORKFLOW_STALLED" || i.code === "AGENT_UNAVAILABLE")) {
    health = "STALLED";
  } else if (failedTasks > 0 || issues.length > 0) {
    health = "DEGRADED";
  }

  return {
    workflowId,
    projectId: wf.project_id,
    title: wf.title,
    state: wf.state,
    health,
    totalTasks: tasks.length,
    completedTasks,
    workingTasks,
    waitingTasks,
    blockedTasks,
    failedTasks,
    issues,
    recommendations,
  };
}

export function executeSupervisorAction(
  db: Db,
  workflowId: string,
  recommendation: SupervisorRecommendation
): { ok: boolean; actionApplied: string; resultTaskId?: string; error?: string } {
  const wf = getWorkflow(db, workflowId);
  if (!wf) return { ok: false, actionApplied: recommendation.action, error: "workflow not found" };

  switch (recommendation.action) {
    case "PAUSE": {
      setWorkflowState(db, workflowId, "paused");
      appendEvent(db, wf.project_id, null, "supervisor.action", {
        workflowId,
        action: "PAUSE",
        reason: recommendation.reason,
      });
      return { ok: true, actionApplied: "PAUSE" };
    }
    case "RESUME": {
      setWorkflowState(db, workflowId, "active");
      appendEvent(db, wf.project_id, null, "supervisor.action", {
        workflowId,
        action: "RESUME",
        reason: recommendation.reason,
      });
      return { ok: true, actionApplied: "RESUME" };
    }
    case "CANCEL": {
      setWorkflowState(db, workflowId, "canceled");
      const tasks = db.prepare("SELECT id FROM tasks WHERE workflow_id = ? AND state = 'submitted'").all(workflowId) as any[];
      for (const t of tasks) haltTask(db, t.id, "workflow canceled by supervisor");
      appendEvent(db, wf.project_id, null, "supervisor.action", {
        workflowId,
        action: "CANCEL",
        reason: recommendation.reason,
      });
      return { ok: true, actionApplied: "CANCEL" };
    }
    case "REASSIGN": {
      if (!recommendation.taskId || !recommendation.recommendedAgentId) {
        return { ok: false, actionApplied: "REASSIGN", error: "taskId and recommendedAgentId required" };
      }
      db.prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(
        recommendation.recommendedAgentId,
        recommendation.taskId
      );
      appendEvent(db, wf.project_id, recommendation.taskId, "supervisor.action", {
        workflowId,
        action: "REASSIGN",
        taskId: recommendation.taskId,
        newAgentId: recommendation.recommendedAgentId,
        reason: recommendation.reason,
      });
      return { ok: true, actionApplied: "REASSIGN", resultTaskId: recommendation.taskId };
    }
    case "RETRY": {
      if (!recommendation.taskId) {
        return { ok: false, actionApplied: "RETRY", error: "taskId required" };
      }
      const origTask = getTask(db, recommendation.taskId);
      if (!origTask) return { ok: false, actionApplied: "RETRY", error: "original task not found" };

      const retryTaskId = createTask(db, {
        projectId: wf.project_id,
        title: `[Supervisor Retry] ${origTask.title.replace(/^\[.*?\]\s*/, "")}`,
        spec: origTask.spec,
        creatorId: "supervisor",
        parentTask: origTask.parent_task || origTask.id,
        retryOf: origTask.id,
        agentId: recommendation.recommendedAgentId ?? null,
        workflowId,
        requiredCapability: origTask.required_capability,
      });

      appendEvent(db, wf.project_id, origTask.id, "supervisor.action", {
        workflowId,
        action: "RETRY",
        originalTaskId: origTask.id,
        retryTaskId,
        reason: recommendation.reason,
      });

      return { ok: true, actionApplied: "RETRY", resultTaskId: retryTaskId };
    }
    case "ESCALATE_HUMAN": {
      appendEvent(db, wf.project_id, recommendation.taskId ?? null, "supervisor.action", {
        workflowId,
        action: "ESCALATE_HUMAN",
        taskId: recommendation.taskId,
        reason: recommendation.reason,
      });
      return { ok: true, actionApplied: "ESCALATE_HUMAN" };
    }
    default:
      return { ok: false, actionApplied: recommendation.action, error: "unknown action" };
  }
}
