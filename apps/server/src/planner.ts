// Autonomous Agent Teams & Planning Engine (Phase 4).
// Turns high-level goals into structured, multi-role, wave-partitioned execution plans,
// and materializes approved plans into executable workflows, tasks, and dependency DAGs.

import type { Db } from "./db.js";
import { listRoles } from "./roles/loader.js";
import {
  getGoal,
  getPlanRevision,
  getLatestPlanRevision,
  createWorkflow,
  createTask,
  addTaskDependency,
  setGoalState,
  setPlanRevisionState,
  appendEvent,
} from "./db.js";

/**
 * A role a step can be given to — the `name` of a role definition file
 * (roles/loader.ts), so it is an arbitrary string rather than an enum.
 *
 * This was the project's FOURTH role vocabulary, and the one that did real
 * damage. It listed `architect · backend · frontend · devops · generalist`,
 * none of which any agent can ever be, and each step's first
 * `requiredCapabilities` entry becomes the task's `required_capability`
 * (below). Routing matches that against the agent's own capabilities
 * (`orchestrator.ts:82`), so a planned "backend" task matched nobody and
 * `supervisor.ts:151` blocked it with "No online agent has required
 * capability". Four of every five planned tasks were unassignable.
 *
 * Now steps declare an INTENT and the role registry answers it, so the two
 * vocabularies cannot drift apart again: a project that adds `frontend.md`
 * gets a real frontend agent, and one that does not falls back to a role that
 * actually exists.
 */
export type AgentRole = string;

/**
 * What a step needs, in preference order. The first role that exists wins.
 *
 * The last entry of each list must be a built-in, so resolution always lands
 * somewhere real — that is the property that makes an unroutable task
 * impossible rather than merely unlikely.
 */
const ROLE_PREFERENCE: Record<string, string[]> = {
  analyze:   ["architect", "researcher"],
  implement: ["backend", "developer"],
  ui:        ["frontend", "ui-engineer", "developer"],
  test:      ["qa"],
  review:    ["security-auditor", "reviewer"],
};

/**
 * Resolve a step intent to a real role plus the capabilities that role
 * declares. `projectFolder` lets a project's own roles win, same as everywhere
 * else roles are resolved.
 */
function roleFor(
  intent: keyof typeof ROLE_PREFERENCE | string,
  projectFolder?: string | null
): { role: AgentRole; capabilities: string[] } {
  const available = listRoles(projectFolder);
  const byName = new Map(available.map((r) => [r.name.toLowerCase(), r]));
  for (const want of ROLE_PREFERENCE[intent] ?? []) {
    const hit = byName.get(want);
    // A role with no declared capabilities cannot carry a routing constraint,
    // so it is a valid assignee but contributes no required_capability.
    if (hit) return { role: hit.name, capabilities: hit.capabilities };
  }
  // Nothing resolved (an operator deleted the built-ins). Name no capability
  // rather than one nobody has: an unconstrained task is offered to everyone,
  // which is a far better failure than a task offered to no one.
  return { role: available[0]?.name ?? "developer", capabilities: [] };
}

export interface PlanStep {
  id: string; // e.g. "stp_1"
  stepNumber: number;
  title: string;
  description: string;
  requiredCapabilities: string[];
  suggestedRole: AgentRole;
  dependencies: string[]; // step IDs that must complete first
  expectedOutputs: string[]; // e.g. ["diff", "test_report", "architecture_doc"]
  riskLevel: "low" | "medium" | "high";
  estimatedSeconds?: number;
  wave?: number; // derived execution wave
  materializedTaskId?: string;
}

export interface ExecutionWave {
  waveNumber: number;
  steps: PlanStep[];
}

export interface WaveDerivationResult {
  steps: PlanStep[];
  waves: ExecutionWave[];
  maxWave: number;
  hasCycle: boolean;
}

/**
 * Topologically partition plan steps into parallel execution waves.
 * Steps with no dependencies are placed in Wave 1.
 * Downstream steps are placed in Wave max(dep.wave) + 1.
 */
export function deriveExecutionWaves(steps: PlanStep[]): WaveDerivationResult {
  if (steps.length === 0) {
    return { steps: [], waves: [], maxWave: 0, hasCycle: false };
  }

  const stepMap = new Map<string, PlanStep>();
  for (const s of steps) stepMap.set(s.id, { ...s });

  const waveMap = new Map<string, number>();
  let hasCycle = false;

  function calculateWave(stepId: string, visited: Set<string>): number {
    if (visited.has(stepId)) {
      hasCycle = true;
      return 1;
    }
    if (waveMap.has(stepId)) return waveMap.get(stepId)!;

    const step = stepMap.get(stepId);
    if (!step || !step.dependencies || step.dependencies.length === 0) {
      waveMap.set(stepId, 1);
      return 1;
    }

    visited.add(stepId);
    let maxDepWave = 0;
    for (const depId of step.dependencies) {
      if (stepMap.has(depId)) {
        const depWave = calculateWave(depId, new Set(visited));
        if (depWave > maxDepWave) maxDepWave = depWave;
      }
    }
    visited.delete(stepId);

    const stepWave = maxDepWave + 1;
    waveMap.set(stepId, stepWave);
    return stepWave;
  }

  for (const s of steps) {
    calculateWave(s.id, new Set());
  }

  const updatedSteps: PlanStep[] = [];
  const waveBuckets = new Map<number, PlanStep[]>();
  let maxWave = 1;

  for (const s of steps) {
    const wave = waveMap.get(s.id) ?? 1;
    if (wave > maxWave) maxWave = wave;
    const updated = { ...s, wave };
    updatedSteps.push(updated);

    if (!waveBuckets.has(wave)) waveBuckets.set(wave, []);
    waveBuckets.get(wave)!.push(updated);
  }

  const waves: ExecutionWave[] = [];
  for (let w = 1; w <= maxWave; w++) {
    if (waveBuckets.has(w)) {
      waves.push({ waveNumber: w, steps: waveBuckets.get(w)! });
    }
  }

  return { steps: updatedSteps, waves, maxWave, hasCycle };
}

/**
 * Generate a structured multi-role engineering plan from a goal specification.
 */
export function generatePlanDraft(
  goalTitle: string,
  goalDescription?: string | null,
  projectContext?: string,
  /** Where to resolve roles from, so a project's own roles win. */
  projectFolder?: string | null
): { summary: string; steps: PlanStep[] } {
  const titleLower = (goalTitle + " " + (goalDescription ?? "")).toLowerCase();

  // Resolved once: every step below names a role that exists and a capability
  // some agent can actually hold. See roleFor().
  const analyze = roleFor("analyze", projectFolder);
  const implement = roleFor("implement", projectFolder);
  const ui = roleFor("ui", projectFolder);
  const test = roleFor("test", projectFolder);
  const review = roleFor("review", projectFolder);

  // Intelligent decomposition based on goal intent
  const steps: PlanStep[] = [];

  // Wave 1: Research / Architecture
  steps.push({
    id: "stp_1",
    stepNumber: 1,
    title: `Analyze codebase & design architecture for ${goalTitle}`,
    description: `Inspect existing codebase, audit integration points, and formulate implementation specification for: ${goalTitle}. ${goalDescription ? `\n\nContext: ${goalDescription}` : ""}`,
    requiredCapabilities: analyze.capabilities,
    suggestedRole: analyze.role,
    dependencies: [],
    expectedOutputs: ["architecture_doc", "plan"],
    riskLevel: "low",
    estimatedSeconds: 300,
  });

  // Wave 2: Core Backend / Engine Implementation
  if (titleLower.includes("auth") || titleLower.includes("api") || titleLower.includes("backend") || titleLower.includes("db") || titleLower.includes("oauth")) {
    steps.push({
      id: "stp_2",
      stepNumber: 2,
      title: `Implement backend core & database schema for ${goalTitle}`,
      description: `Create data schemas, API routes, authentication logic, and service handlers required for ${goalTitle}.`,
      requiredCapabilities: implement.capabilities,
      suggestedRole: implement.role,
      dependencies: ["stp_1"],
      expectedOutputs: ["diff", "migration"],
      riskLevel: "medium",
      estimatedSeconds: 600,
    });
  } else {
    steps.push({
      id: "stp_2",
      stepNumber: 2,
      title: `Implement core logic for ${goalTitle}`,
      description: `Implement core business logic, helpers, and integration points for ${goalTitle}.`,
      requiredCapabilities: implement.capabilities,
      suggestedRole: implement.role,
      dependencies: ["stp_1"],
      expectedOutputs: ["diff"],
      riskLevel: "medium",
      estimatedSeconds: 600,
    });
  }

  // Wave 3: Frontend / UI / Client integration (if applicable or general)
  if (titleLower.includes("frontend") || titleLower.includes("ui") || titleLower.includes("oauth") || titleLower.includes("dashboard") || titleLower.includes("client")) {
    steps.push({
      id: "stp_3",
      stepNumber: 3,
      title: `Build frontend components & client integration for ${goalTitle}`,
      description: `Create responsive UI views, state hooks, and client API bindings for ${goalTitle}.`,
      requiredCapabilities: ui.capabilities,
      suggestedRole: ui.role,
      dependencies: ["stp_2"],
      expectedOutputs: ["diff"],
      riskLevel: "low",
      estimatedSeconds: 450,
    });
  }

  // Wave 3 or 4: Automated Testing & Verification
  const testDeps = steps.length === 3 ? ["stp_2", "stp_3"] : ["stp_2"];
  steps.push({
    id: `stp_${steps.length + 1}`,
    stepNumber: steps.length + 1,
    title: `Implement automated test suite & verify ${goalTitle}`,
    description: `Write unit and integration tests verifying all success paths, error states, and regression boundaries for ${goalTitle}.`,
    requiredCapabilities: test.capabilities,
    suggestedRole: test.role,
    dependencies: testDeps,
    expectedOutputs: ["test_report"],
    riskLevel: "low",
    estimatedSeconds: 300,
  });

  // Final Wave: Comprehensive Code Review & Safety Audit
  steps.push({
    id: `stp_${steps.length + 1}`,
    stepNumber: steps.length + 1,
    title: `Perform code review & security verification for ${goalTitle}`,
    description: `Review all modified files, verify project isolation, security boundaries, and verify test coverage.`,
    requiredCapabilities: review.capabilities,
    suggestedRole: review.role,
    dependencies: [`stp_${steps.length}`],
    expectedOutputs: ["review_verdict"],
    riskLevel: "low",
    estimatedSeconds: 240,
  });

  const waveResult = deriveExecutionWaves(steps);
  const summary = `Structured ${waveResult.steps.length}-step execution plan across ${waveResult.maxWave} parallel waves for “${goalTitle}”.`;

  return { summary, steps: waveResult.steps };
}

/**
 * Materialize an approved plan revision into concrete Workflows, Tasks, and Dependencies.
 * Preserves all execution safety, project isolation, and DAG integrity.
 */
export function materializePlan(
  db: Db,
  goalId: string,
  revisionId: string,
  creatorId: string
): { workflowId: string; taskIds: string[]; stepMappings: Map<string, string> } | null {
  const goal = getGoal(db, goalId);
  if (!goal) return null;

  const rev = getPlanRevision(db, revisionId);
  if (!rev || rev.goalId !== goalId) return null;

  const steps: PlanStep[] = (() => {
    try {
      return JSON.parse(rev.stepsJson);
    } catch {
      return [];
    }
  })();

  if (steps.length === 0) return null;

  const waveResult = deriveExecutionWaves(steps);
  if (waveResult.hasCycle) {
    throw new Error("Cannot materialize plan with cyclical dependencies");
  }

  // 1. Create Workflow in workflows table
  const workflowId = createWorkflow(db, {
    projectId: goal.projectId,
    title: goal.title,
    description: goal.description ?? `Autonomous execution for goal ${goal.title}`,
    creatorId,
  });

  // 2. Link goal to workflow and update state to executing
  const now = new Date().toISOString();
  setGoalState(db, goalId, "executing", { workflowId, startedAt: now, approvedAt: now });

  // 3. Materialize Tasks for each PlanStep
  const stepToTaskId = new Map<string, string>();
  const createdTaskIds: string[] = [];

  for (const s of waveResult.steps) {
    const taskId = createTask(db, {
      projectId: goal.projectId,
      title: s.title,
      spec: `${s.description}\n\n[Suggested Role]: ${s.suggestedRole}\n[Expected Outputs]: ${s.expectedOutputs.join(", ")}\n[Risk Level]: ${s.riskLevel}`,
      creatorId,
      workflowId,
      requiredCapability: s.requiredCapabilities?.[0] ?? null,
    });

    // Tag suggested role, wave, and goal_id on task
    db.prepare("UPDATE tasks SET suggested_role = ?, wave = ?, goal_id = ? WHERE id = ?").run(
      s.suggestedRole,
      s.wave ?? 1,
      goalId,
      taskId
    );

    stepToTaskId.set(s.id, taskId);
    createdTaskIds.push(taskId);
    s.materializedTaskId = taskId;
  }

  // 4. Materialize Dependencies
  for (const s of waveResult.steps) {
    const currentTaskId = stepToTaskId.get(s.id);
    if (!currentTaskId) continue;

    for (const depStepId of s.dependencies) {
      const depTaskId = stepToTaskId.get(depStepId);
      if (depTaskId) {
        addTaskDependency(db, currentTaskId, depTaskId);
      }
    }
  }

  // 5. Update plan revision with materialized task IDs and mark approved
  db.prepare(
    "UPDATE plan_revisions SET state = 'approved', steps_json = ?, approved_at = ? WHERE id = ?"
  ).run(JSON.stringify(waveResult.steps), now, revisionId);

  // 6. Record audit events
  appendEvent(db, goal.projectId, null, "plan.approved", {
    goalId,
    revisionId,
    workflowId,
    stepsCount: waveResult.steps.length,
    wavesCount: waveResult.maxWave,
  });

  appendEvent(db, goal.projectId, null, "goal.execution_started", {
    goalId,
    workflowId,
    taskCount: createdTaskIds.length,
  });

  return {
    workflowId,
    taskIds: createdTaskIds,
    stepMappings: stepToTaskId,
  };
}
