// Dynamic Replanning & Impact Analysis Engine (Phase 4).
// Analyzes failure impact, computes downstream blocked tasks, and generates
// non-destructive plan revisions that preserve completed historical tasks.

import type { Db } from "./db.js";
import {
  getGoal,
  getLatestPlanRevision,
  createPlanRevision,
  setPlanRevisionState,
  setGoalState,
  getTask,
  createTask,
  addTaskDependency,
  getTaskDependencies,
  getTaskDependents,
  appendEvent,
} from "./db.js";
import { deriveExecutionWaves, type PlanStep, type AgentRole } from "./planner.js";

export interface ReplanningOption {
  optionId: string;
  title: string;
  description: string;
  revisedSteps: PlanStep[];
}

export interface ImpactAnalysis {
  goalId: string;
  workflowId: string | null;
  failedTaskId: string;
  failedTaskTitle: string;
  failureReason: string;
  completedTasksCount: number;
  blockedTasks: Array<{ taskId: string; title: string }>;
  options: ReplanningOption[];
}

/**
 * Perform impact analysis when a task fails in a goal's active workflow.
 */
export function analyzePlanImpact(
  db: Db,
  goalId: string,
  failedTaskId?: string | null
): ImpactAnalysis | null {
  const goal = getGoal(db, goalId);
  if (!goal) return null;

  const workflowId = goal.workflowId;
  const tasks = workflowId
    ? (db.prepare("SELECT * FROM tasks WHERE workflow_id = ?").all(workflowId) as any[])
    : (db.prepare("SELECT * FROM tasks WHERE goal_id = ?").all(goalId) as any[]);

  let targetFailedTask: any = null;
  if (failedTaskId) {
    targetFailedTask = tasks.find((t) => t.id === failedTaskId) || getTask(db, failedTaskId);
  } else {
    targetFailedTask = tasks.find((t) => t.state === "failed" || t.state === "rejected");
  }

  if (!targetFailedTask && tasks.length > 0) {
    targetFailedTask = tasks[0];
  }

  const fId = targetFailedTask?.id ?? "unknown";
  const fTitle = targetFailedTask?.title ?? "Unknown task";

  // Find last error message from attempts or events
  const lastAttempt = db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1")
    .get(fId) as any;
  const failureReason = lastAttempt?.error_message || "Task execution failed or timed out";

  // BFS downstream traversal to find all transitively blocked tasks
  const blockedTaskMap = new Map<string, string>();
  const queue = [fId];
  const visited = new Set<string>([fId]);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const dependents = getTaskDependents(db, curr);
    for (const dep of dependents) {
      if (!visited.has(dep.taskId)) {
        visited.add(dep.taskId);
        queue.push(dep.taskId);
        const depTask = tasks.find((t) => t.id === dep.taskId) || getTask(db, dep.taskId);
        if (depTask && depTask.state !== "completed") {
          blockedTaskMap.set(dep.taskId, depTask.title);
        }
      }
    }
  }

  const completedCount = tasks.filter((t) => t.state === "completed").length;
  const blockedTasksList = Array.from(blockedTaskMap.entries()).map(([taskId, title]) => ({
    taskId,
    title,
  }));

  // Fetch current plan revision
  const latestRev = getLatestPlanRevision(db, goalId);
  const currentSteps: PlanStep[] = latestRev
    ? (() => {
        try {
          return JSON.parse(latestRev.stepsJson);
        } catch {
          return [];
        }
      })()
    : [];

  // Formulate 3 distinct remediation options
  const options: ReplanningOption[] = [];

  // Option 1: Targeted retry with alternative role/agent specialization
  const opt1Steps: PlanStep[] = currentSteps.map((s) => {
    if (s.materializedTaskId === fId || s.title.includes(fTitle)) {
      return {
        ...s,
        id: `${s.id}_rev1`,
        title: `[Remediation] ${s.title.replace(/^\[Remediation\]\s*/, "")} (Alternative Strategy)`,
        description: `Retry execution taking into account previous failure: "${failureReason}". Focus on robustness and fallback handling.`,
        suggestedRole: (s.suggestedRole === "backend" ? "architect" : "backend") as AgentRole,
        riskLevel: "medium" as const,
      };
    }
    return s;
  });
  options.push({
    optionId: "opt_specialist_retry",
    title: "Specialist Worker Rework",
    description: "Re-execute the failed step using an alternative architectural strategy and re-assigned specialist worker.",
    revisedSteps: deriveExecutionWaves(opt1Steps).steps,
  });

  // Option 2: Step Decomposition (Split into 2 focused sub-steps)
  const opt2Steps: PlanStep[] = [];
  for (const s of currentSteps) {
    if (s.materializedTaskId === fId || s.title.includes(fTitle)) {
      const part1Id = `${s.id}_part1`;
      const part2Id = `${s.id}_part2`;
      opt2Steps.push({
        id: part1Id,
        stepNumber: s.stepNumber,
        title: `[Part 1] Prepare & isolate ${s.title.replace(/^\[.*?\]\s*/, "")}`,
        description: `Decomposed step part 1: Validate dependencies, isolate environment, and verify contracts.`,
        requiredCapabilities: s.requiredCapabilities,
        suggestedRole: s.suggestedRole,
        dependencies: s.dependencies,
        expectedOutputs: ["diff"],
        riskLevel: "low",
        estimatedSeconds: 300,
      });
      opt2Steps.push({
        id: part2Id,
        stepNumber: s.stepNumber + 1,
        title: `[Part 2] Execute core implementation for ${s.title.replace(/^\[.*?\]\s*/, "")}`,
        description: `Decomposed step part 2: Implement core functionality with integrated tests.`,
        requiredCapabilities: s.requiredCapabilities,
        suggestedRole: s.suggestedRole,
        dependencies: [part1Id],
        expectedOutputs: s.expectedOutputs,
        riskLevel: "medium",
        estimatedSeconds: 300,
      });
    } else {
      opt2Steps.push(s);
    }
  }
  options.push({
    optionId: "opt_decompose_step",
    title: "Decompose Step into Sub-tasks",
    description: "Split the problematic step into two smaller, lower-risk verification and implementation sub-steps.",
    revisedSteps: deriveExecutionWaves(opt2Steps).steps,
  });

  // Option 3: Architectural Path Rework
  const opt3Steps: PlanStep[] = currentSteps.map((s) => {
    if (s.materializedTaskId === fId || blockedTaskMap.has(s.materializedTaskId ?? "")) {
      return {
        ...s,
        id: `${s.id}_rev3`,
        title: `[Reworked] ${s.title.replace(/^\[.*?\]\s*/, "")}`,
        description: `Architectural rework avoiding failed path: ${failureReason}`,
        riskLevel: "low" as const,
      };
    }
    return s;
  });
  options.push({
    optionId: "opt_path_rework",
    title: "Rework Downstream Architecture",
    description: "Redesign the downstream dependency path to bypass the blocked implementation constraint.",
    revisedSteps: deriveExecutionWaves(opt3Steps).steps,
  });

  return {
    goalId,
    workflowId,
    failedTaskId: fId,
    failedTaskTitle: fTitle,
    failureReason,
    completedTasksCount: completedCount,
    blockedTasks: blockedTasksList,
    options,
  };
}

/**
 * Authoritatively apply a plan revision, preserving all historical records.
 */
export function applyPlanRevision(
  db: Db,
  goalId: string,
  optionId: string,
  creatorId: string
): { revisionId: string; revisionNumber: number; newTasksCount: number } | null {
  const goal = getGoal(db, goalId);
  if (!goal) return null;

  const analysis = analyzePlanImpact(db, goalId);
  if (!analysis) return null;

  const selectedOption = analysis.options.find((o) => o.optionId === optionId) || analysis.options[0];
  const latestRev = getLatestPlanRevision(db, goalId);
  if (latestRev) {
    setPlanRevisionState(db, latestRev.id, "superseded");
  }

  // Create new plan revision
  const newRevNumber = (latestRev?.revisionNumber ?? 1) + 1;
  const newRevId = createPlanRevision(db, {
    goalId,
    projectId: goal.projectId,
    revisionNumber: newRevNumber,
    state: "approved",
    summary: `Revision ${newRevNumber}: ${selectedOption.title}`,
    steps: selectedOption.revisedSteps,
    impactAnalysis: analysis,
    createdBy: creatorId,
  });

  // Materialize only the new tasks for the uncompleted/reworked steps
  let newTasksCount = 0;
  const workflowId = goal.workflowId;

  for (const s of selectedOption.revisedSteps) {
    if (!s.materializedTaskId || s.id.includes("_rev") || s.id.includes("_part")) {
      const newTaskId = createTask(db, {
        projectId: goal.projectId,
        title: s.title,
        spec: `${s.description}\n\n[Suggested Role]: ${s.suggestedRole}\n[Expected Outputs]: ${s.expectedOutputs.join(", ")}`,
        creatorId,
        workflowId: workflowId ?? null,
        requiredCapability: s.requiredCapabilities?.[0] ?? null,
      });

      db.prepare("UPDATE tasks SET suggested_role = ?, wave = ?, goal_id = ? WHERE id = ?").run(
        s.suggestedRole,
        s.wave ?? 1,
        goalId,
        newTaskId
      );

      s.materializedTaskId = newTaskId;
      newTasksCount++;
    }
  }

  // Update plan revision steps with new task IDs
  db.prepare("UPDATE plan_revisions SET steps_json = ?, approved_at = ? WHERE id = ?").run(
    JSON.stringify(selectedOption.revisedSteps),
    new Date().toISOString(),
    newRevId
  );

  // Update goal state back to executing
  setGoalState(db, goalId, "executing");

  // Record audit events
  appendEvent(db, goal.projectId, null, "plan.revised", {
    goalId,
    revisionId: newRevId,
    revisionNumber: newRevNumber,
    optionId: selectedOption.optionId,
    newTasksCreated: newTasksCount,
  });

  return {
    revisionId: newRevId,
    revisionNumber: newRevNumber,
    newTasksCount,
  };
}
