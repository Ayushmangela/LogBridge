import { describe, expect, test } from "vitest";
import {
  openDb,
  createGoal,
  getGoal,
  getProjectGoals,
  setGoalState,
  createPlanRevision,
  getLatestPlanRevision,
  getTask,
  setTaskState,
  type Db,
} from "./db.js";
import { generatePlanDraft, deriveExecutionWaves, materializePlan, type PlanStep } from "./planner.js";
import { analyzePlanImpact, applyPlanRevision } from "./replanning.js";
import { buildAgentContext } from "./contextBuilder.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_plan") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_${id}`, `u_${id}`, "Commander", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run(`m_${id}`, `usr_${id}`, "Machine 1", new Date().toISOString(), 1);
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_arch_${id}`, `m_${id}`, `usr_${id}`, id, "Lead Architect", "planner", "idle", JSON.stringify(["research", "code_review"]), 2
  );
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_backend_${id}`, `m_${id}`, `usr_${id}`, id, "Backend Specialist", "developer", "idle", JSON.stringify(["backend", "database", "api"]), 2
  );
}

describe("Goal Management & Lifecycle", () => {
  test("creates goal, enforces project isolation, and transitions lifecycle states", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_alpha");
    seedProject(db, "prj_beta");

    const goalId = createGoal(db, {
      projectId: "prj_alpha",
      title: "Add OAuth Authentication",
      description: "Implement Google and GitHub OAuth providers with session management.",
      creatorId: "usr_prj_alpha",
    });

    expect(goalId).toMatch(/^gol_/);
    const goal = getGoal(db, goalId);
    expect(goal?.title).toBe("Add OAuth Authentication");
    expect(goal?.state).toBe("draft");

    // Project isolation check
    const alphaGoals = getProjectGoals(db, "prj_alpha");
    const betaGoals = getProjectGoals(db, "prj_beta");
    expect(alphaGoals.some((g) => g.id === goalId)).toBe(true);
    expect(betaGoals.some((g) => g.id === goalId)).toBe(false);

    // Lifecycle transitions
    setGoalState(db, goalId, "planning");
    expect(getGoal(db, goalId)?.state).toBe("planning");

    setGoalState(db, goalId, "awaiting_approval");
    expect(getGoal(db, goalId)?.state).toBe("awaiting_approval");

    setGoalState(db, goalId, "paused");
    expect(getGoal(db, goalId)?.state).toBe("paused");

    db.close();
  });
});

describe("Autonomous Planning Engine & Execution Waves", () => {
  test("decomposes goal into multi-role plan with parallel execution waves", () => {
    const { summary, steps } = generatePlanDraft(
      "Add OAuth Authentication",
      "Implement backend OAuth endpoints, frontend login modal, and integration test suite."
    );

    expect(summary).toContain("execution plan");
    expect(steps.length).toBeGreaterThanOrEqual(4);

    const roles = steps.map((s) => s.suggestedRole);
    expect(roles).toContain("architect");
    expect(roles).toContain("backend");
    expect(roles).toContain("qa");
    expect(roles).toContain("reviewer");

    // Check execution wave derivation
    const waves = deriveExecutionWaves(steps);
    expect(waves.hasCycle).toBe(false);
    expect(waves.maxWave).toBeGreaterThanOrEqual(3);

    // Wave 1 step has no dependencies
    const wave1Steps = waves.waves.find((w) => w.waveNumber === 1)?.steps;
    expect(wave1Steps?.length).toBeGreaterThanOrEqual(1);
    expect(wave1Steps![0].dependencies.length).toBe(0);

    // Downstream steps have dependencies and higher wave numbers
    const finalStep = waves.steps[waves.steps.length - 1];
    expect(finalStep.wave).toBe(waves.maxWave);
  });

  test("detects cyclical dependencies in plan steps", () => {
    const cyclicSteps: PlanStep[] = [
      {
        id: "stp_1",
        stepNumber: 1,
        title: "Step 1",
        description: "Desc 1",
        requiredCapabilities: ["backend"],
        suggestedRole: "backend",
        dependencies: ["stp_2"], // depends on 2
        expectedOutputs: ["diff"],
        riskLevel: "low",
      },
      {
        id: "stp_2",
        stepNumber: 2,
        title: "Step 2",
        description: "Desc 2",
        requiredCapabilities: ["backend"],
        suggestedRole: "backend",
        dependencies: ["stp_1"], // depends on 1 (cycle!)
        expectedOutputs: ["diff"],
        riskLevel: "low",
      },
    ];

    const result = deriveExecutionWaves(cyclicSteps);
    expect(result.hasCycle).toBe(true);
  });
});

describe("Plan Materialization & Workflow Creation", () => {
  test("materializes approved plan into concrete workflow, tasks, and dependency DAG", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_mat");

    const goalId = createGoal(db, {
      projectId: "prj_mat",
      title: "Materialize Test Goal",
      creatorId: "usr_prj_mat",
    });

    const { summary, steps } = generatePlanDraft("Materialize Test Goal");
    const revId = createPlanRevision(db, {
      goalId,
      projectId: "prj_mat",
      state: "awaiting_approval",
      summary,
      steps,
      createdBy: "usr_prj_mat",
    });

    // Before approval: 0 tasks exist in workflow
    const initialTasks = db.prepare("SELECT * FROM tasks WHERE goal_id = ?").all(goalId) as any[];
    expect(initialTasks.length).toBe(0);

    // Materialize plan
    const result = materializePlan(db, goalId, revId, "usr_prj_mat");
    expect(result).not.toBeNull();
    expect(result?.workflowId).toMatch(/^wf_/);
    expect(result?.taskIds.length).toBe(steps.length);

    // Verify tasks are tagged with goal, suggested_role, and wave
    const materializedTasks = db.prepare("SELECT * FROM tasks WHERE workflow_id = ?").all(result!.workflowId) as any[];
    expect(materializedTasks.length).toBe(steps.length);
    for (const t of materializedTasks) {
      expect(t.goal_id).toBe(goalId);
      expect(t.suggested_role).toBeDefined();
      expect(t.wave).toBeGreaterThanOrEqual(1);
    }

    // Verify goal state updated to executing
    const updatedGoal = getGoal(db, goalId);
    expect(updatedGoal?.state).toBe("executing");
    expect(updatedGoal?.workflowId).toBe(result!.workflowId);

    db.close();
  });
});

describe("Dynamic Replanning & Impact Analysis", () => {
  test("analyzes failure impact, computes downstream blocked tasks, and applies non-destructive plan revision", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_replan");

    const goalId = createGoal(db, {
      projectId: "prj_replan",
      title: "Resilient Auth Pipeline",
      creatorId: "usr_prj_replan",
    });

    const { summary, steps } = generatePlanDraft("Resilient Auth Pipeline");
    const revId = createPlanRevision(db, {
      goalId,
      projectId: "prj_replan",
      state: "awaiting_approval",
      summary,
      steps,
      createdBy: "usr_prj_replan",
    });

    const mat = materializePlan(db, goalId, revId, "usr_prj_replan");
    expect(mat).not.toBeNull();

    const t1 = mat!.taskIds[0];
    const t2 = mat!.taskIds[1];

    // Complete t1, fail t2
    setTaskState(db, t1, "completed");
    setTaskState(db, t2, "failed");

    // Perform Impact Analysis
    const impact = analyzePlanImpact(db, goalId, t2);
    expect(impact).not.toBeNull();
    expect(impact?.failedTaskId).toBe(t2);
    expect(impact?.completedTasksCount).toBe(1);
    expect(impact?.blockedTasks.length).toBeGreaterThan(0);
    expect(impact?.options.length).toBe(3);

    // Apply Revision Option 2 (Decompose step)
    const replanResult = applyPlanRevision(db, goalId, "opt_decompose_step", "usr_prj_replan");
    expect(replanResult).not.toBeNull();
    expect(replanResult?.revisionNumber).toBe(2);
    expect(replanResult?.newTasksCount).toBeGreaterThanOrEqual(2);

    // Historical completed task t1 remains intact and unmodified
    expect(getTask(db, t1)?.state).toBe("completed");

    // Goal state returns to executing
    expect(getGoal(db, goalId)?.state).toBe("executing");

    // Latest plan revision is revision 2
    const latestRev = getLatestPlanRevision(db, goalId);
    expect(latestRev?.revisionNumber).toBe(2);
    expect(latestRev?.state).toBe("approved");

    db.close();
  });
});

describe("Context Integration with Goals & Planned Steps", () => {
  test("assembles deterministic context with goal specification, suggested role, and wave", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_ctx_plan");

    const goalId = createGoal(db, {
      projectId: "prj_ctx_plan",
      title: "Enterprise SSO Integration",
      description: "Implement SAML 2.0 and OAuth2 enterprise login connectors.",
      creatorId: "usr_prj_ctx_plan",
    });

    const { summary, steps } = generatePlanDraft("Enterprise SSO Integration", "SAML 2.0 & OAuth2");
    const revId = createPlanRevision(db, {
      goalId,
      projectId: "prj_ctx_plan",
      state: "awaiting_approval",
      summary,
      steps,
      createdBy: "usr_prj_ctx_plan",
    });

    const mat = materializePlan(db, goalId, revId, "usr_prj_ctx_plan");
    const taskId = mat!.taskIds[1];

    const context = buildAgentContext(db, taskId, "agt_backend_prj_ctx_plan", { maxChars: 5000 });
    expect(context).not.toBeNull();
    expect(context?.formattedContext).toContain("=== PROJECT GOAL ===");
    expect(context?.formattedContext).toContain("Enterprise SSO Integration");
    expect(context?.formattedContext).toContain("=== TASK SPECIFICATION ===");
    expect(context?.formattedContext).toContain("Suggested Role:");
    expect(context?.formattedContext).toContain("Execution Wave: Wave");

    db.close();
  });
});

describe("Phase 4 REST API Endpoints", () => {
  test("verifies full goal lifecycle, plan generation, editing, approval, and replanning APIs", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_api_plan");

    // 1. POST /api/projects/:id/goals
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/projects/prj_api_plan/goals",
      payload: {
        title: "REST Goal OAuth",
        description: "Full end-to-end API verification for Phase 4 planning.",
      },
    });
    expect(createRes.statusCode).toBe(200);
    const goalId = createRes.json().goalId;
    expect(goalId).toMatch(/^gol_/);

    // 2. GET /api/projects/:id/goals
    const listRes = await server.app.inject({
      method: "GET",
      url: "/api/projects/prj_api_plan/goals",
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().goals.length).toBe(1);

    // 3. POST /api/goals/:id/generate-plan
    const genRes = await server.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/generate-plan`,
      payload: {},
    });
    expect(genRes.statusCode).toBe(200);
    expect(genRes.json().steps.length).toBeGreaterThanOrEqual(4);

    // 4. GET /api/goals/:id
    const getRes = await server.app.inject({
      method: "GET",
      url: `/api/goals/${goalId}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().goal.state).toBe("awaiting_approval");
    expect(getRes.json().plan.steps.length).toBeGreaterThanOrEqual(4);

    // 5. POST /api/goals/:id/plan/approve
    const appRes = await server.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/plan/approve`,
      payload: {},
    });
    expect(appRes.statusCode).toBe(200);
    expect(appRes.json().workflowId).toMatch(/^wf_/);

    // 6. POST /api/goals/:id/pause & resume
    const pauseRes = await server.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/pause`,
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().state).toBe("paused");

    const resumeRes = await server.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/resume`,
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().state).toBe("executing");

    // 7. GET /api/goals/:id/impact
    const impactRes = await server.app.inject({
      method: "GET",
      url: `/api/goals/${goalId}/impact`,
    });
    expect(impactRes.statusCode).toBe(200);
    expect(impactRes.json().options.length).toBe(3);

    // 8. POST /api/goals/:id/replan
    const replanRes = await server.app.inject({
      method: "POST",
      url: `/api/goals/${goalId}/replan`,
      payload: { optionId: "opt_specialist_retry" },
    });
    expect(replanRes.statusCode).toBe(200);
    expect(replanRes.json().revisionNumber).toBe(2);

    await server.app.close();
  });
});
