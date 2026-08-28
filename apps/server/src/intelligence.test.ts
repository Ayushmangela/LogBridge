import { describe, expect, test } from "vitest";
import {
  openDb,
  createTask,
  createWorkflow,
  setWorkflowState,
  addTaskDependency,
  setTaskState,
  getTask,
  storeArtifact,
  classifyFailure,
  getRetryPolicy,
  setRetryPolicy,
  getAgentMetrics,
  getProjectMetrics,
  type Db,
} from "./db.js";
import { evaluateAgentCandidates, assignPendingTasks } from "./orchestrator.js";
import { buildAgentContext } from "./contextBuilder.js";
import { evaluateWorkflowHealth, executeSupervisorAction } from "./supervisor.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_intel") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_${id}`, `u_${id}`, "Coordinator", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run(`m_${id}`, `usr_${id}`, "Machine 1", new Date().toISOString(), 1);
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_backend_${id}`, `m_${id}`, `usr_${id}`, id, "Backend Specialist", "developer", "idle", JSON.stringify(["backend", "database", "api"]), 2
  );
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_frontend_${id}`, `m_${id}`, `usr_${id}`, id, "Frontend Designer", "developer", "idle", JSON.stringify(["frontend", "ui", "css"]), 1
  );
}

describe("Intelligent Scoring & Explainable Routing", () => {
  test("picks agent with exact capability match over generic agent", () => {
    const candidates = [
      { id: "agt_1", name: "Backend Dev", capabilities: ["backend", "api"], concurrency: 2, machineOnline: true },
      { id: "agt_2", name: "Frontend Dev", capabilities: ["frontend", "css"], concurrency: 1, machineOnline: true },
    ];
    const load = new Map<string, number>([["agt_1", 0], ["agt_2", 0]]);

    const result = evaluateAgentCandidates(candidates, load, "backend");
    expect(result.chosen?.id).toBe("agt_1");
    expect(result.explanation).toContain("Backend Dev");

    const agt1Score = result.candidates.find((c) => c.agentId === "agt_1");
    const agt2Score = result.candidates.find((c) => c.agentId === "agt_2");
    expect(agt1Score?.eligible).toBe(true);
    expect(agt2Score?.eligible).toBe(false);
    expect(agt2Score?.disqualificationReason).toContain("Missing required capability");
  });

  test("excludes offline agents and respects max concurrency limits", () => {
    const candidates = [
      { id: "agt_offline", name: "Offline Agent", capabilities: ["backend"], concurrency: 2, machineOnline: false },
      { id: "agt_busy", name: "Busy Agent", capabilities: ["backend"], concurrency: 1, machineOnline: true },
      { id: "agt_free", name: "Free Agent", capabilities: ["backend"], concurrency: 2, machineOnline: true },
    ];
    const load = new Map<string, number>([
      ["agt_offline", 0],
      ["agt_busy", 1], // at max concurrency (1/1)
      ["agt_free", 0], // free (0/2)
    ]);

    const result = evaluateAgentCandidates(candidates, load, "backend");
    expect(result.chosen?.id).toBe("agt_free");

    const offlineCand = result.candidates.find((c) => c.agentId === "agt_offline");
    const busyCand = result.candidates.find((c) => c.agentId === "agt_busy");
    expect(offlineCand?.disqualificationReason).toBe("Machine offline");
    expect(busyCand?.disqualificationReason).toContain("At max concurrency limit");
  });

  test("applies failure penalty when candidate previously failed the task", () => {
    const candidates = [
      { id: "agt_a", name: "Agent A", capabilities: ["backend"], concurrency: 2, machineOnline: true },
      { id: "agt_b", name: "Agent B", capabilities: ["backend"], concurrency: 2, machineOnline: true },
    ];
    const load = new Map<string, number>([["agt_a", 0], ["agt_b", 0]]);
    const failedAgentIds = new Set<string>(["agt_a"]);

    const result = evaluateAgentCandidates(candidates, load, "backend", { failedAgentIds });
    expect(result.chosen?.id).toBe("agt_b");

    const candA = result.candidates.find((c) => c.agentId === "agt_a");
    expect(candA?.breakdown.failurePenalty).toBe(-15);
  });
});

describe("Failure Classification & Retry Policies", () => {
  test("classifies different error types accurately", () => {
    expect(classifyFailure("lease expired after 60s", 1, true)).toBe("TIMEOUT");
    expect(classifyFailure("runner socket closed — offline", 1, false)).toBe("MACHINE_OFFLINE");
    expect(classifyFailure("502 Bad Gateway from upstream API", 1, false)).toBe("TRANSIENT");
    expect(classifyFailure("Invalid parameter 'auth_type' — bad request", 1, false)).toBe("INVALID_TASK");
    expect(classifyFailure("Blocked by upstream dependency", 1, false)).toBe("DEPENDENCY_FAILURE");
    expect(classifyFailure("Unhandled exception at line 42", 1, false)).toBe("AGENT_FAILURE");
  });

  test("stores and retrieves project and task level retry policies", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const defaultPolicy = getRetryPolicy(db, "prj_intel");
    expect(defaultPolicy.maxAttempts).toBe(3);
    expect(defaultPolicy.preferDifferentAgent).toBe(true);

    setRetryPolicy(db, {
      projectId: "prj_intel",
      maxAttempts: 5,
      backoffMs: 2000,
      retryOn: ["TIMEOUT", "TRANSIENT"],
      preferDifferentAgent: false,
    });

    const updatedProjPolicy = getRetryPolicy(db, "prj_intel");
    expect(updatedProjPolicy.maxAttempts).toBe(5);
    expect(updatedProjPolicy.backoffMs).toBe(2000);
    expect(updatedProjPolicy.preferDifferentAgent).toBe(false);

    db.close();
  });
});

describe("Autonomous Workflow Supervisor & Recovery Engine", () => {
  test("diagnoses healthy, blocked, and stalled workflows", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const wfId = createWorkflow(db, {
      projectId: "prj_intel",
      title: "Diagnostic Pipeline",
      creatorId: "usr_prj_intel",
    });

    const t1 = createTask(db, {
      projectId: "prj_intel",
      title: "Setup DB",
      creatorId: "usr_prj_intel",
      workflowId: wfId,
    });
    const t2 = createTask(db, {
      projectId: "prj_intel",
      title: "Build API",
      creatorId: "usr_prj_intel",
      workflowId: wfId,
    });
    addTaskDependency(db, t2, t1);

    // Initial state: t1 ready, t2 waiting -> HEALTHY
    let report = evaluateWorkflowHealth(db, wfId);
    expect(report?.health).toBe("HEALTHY");

    // Fail t1 -> t2 blocked -> BLOCKED
    setTaskState(db, t1, "failed");
    report = evaluateWorkflowHealth(db, wfId);
    expect(report?.health).toBe("BLOCKED");
    expect(report?.issues.some((i) => i.code === "DEPENDENCY_BLOCKED")).toBe(true);

    // Supervisor executes retry action
    const retryRec = report?.recommendations.find((r) => r.action === "RETRY");
    expect(retryRec).toBeDefined();

    const actionRes = executeSupervisorAction(db, wfId, retryRec!);
    expect(actionRes.ok).toBe(true);
    expect(actionRes.resultTaskId).toMatch(/^tsk_/);

    const retryTask = getTask(db, actionRes.resultTaskId!);
    expect(retryTask?.title).toContain("[Supervisor Retry]");
    expect(retryTask?.retry_of).toBe(t1);

    db.close();
  });
});

describe("Deterministic Project-Scoped Agent Context Builder", () => {
  test("assembles layered context with task spec, dependencies, artifacts, and memories within character limit", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const t1 = createTask(db, {
      projectId: "prj_intel",
      title: "Database schema migration",
      spec: "Create users and sessions tables with indexes.",
      creatorId: "usr_prj_intel",
    });

    storeArtifact(db, {
      projectId: "prj_intel",
      taskId: t1,
      creatorId: "agt_backend_prj_intel",
      kind: "diff",
      title: "001_initial_schema.sql",
      summary: "Added users table with unique email index",
      filePath: "migrations/001.sql",
    });

    const t2 = createTask(db, {
      projectId: "prj_intel",
      title: "Build Auth Endpoints",
      spec: "Implement login and signup routes using the schema.",
      creatorId: "usr_prj_intel",
    });
    addTaskDependency(db, t2, t1);

    const context = buildAgentContext(db, t2, "agt_backend_prj_intel", { maxChars: 4000 });
    expect(context).not.toBeNull();
    expect(context?.projectId).toBe("prj_intel");
    expect(context?.formattedContext).toContain("=== TASK SPECIFICATION ===");
    expect(context?.formattedContext).toContain("Build Auth Endpoints");
    expect(context?.formattedContext).toContain("=== PREDECESSOR DEPENDENCY OUTPUTS ===");
    expect(context?.formattedContext).toContain("001_initial_schema.sql");
    expect(context?.totalLength).toBeLessThanOrEqual(4050);

    db.close();
  });
});

describe("Agent & Project Performance Observability Metrics", () => {
  test("computes agent metrics and project-wide telemetry accurately", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const agentId = "agt_backend_prj_intel";
    const t1 = createTask(db, { projectId: "prj_intel", title: "Job 1", creatorId: "usr_prj_intel", agentId });
    setTaskState(db, t1, "completed", { cost_usd: 0.05 });

    const metrics = getAgentMetrics(db, agentId);
    expect(metrics).not.toBeNull();
    expect(metrics?.agentId).toBe(agentId);
    expect(metrics?.machineOnline).toBe(true);

    const projMetrics = getProjectMetrics(db, "prj_intel");
    expect(projMetrics.projectId).toBe("prj_intel");
    expect(projMetrics.totalTasks).toBe(1);
    expect(projMetrics.onlineAgents).toBe(2);

    db.close();
  });
});

describe("Phase 3 REST Endpoints", () => {
  test("verifies profile, routing-explanation, context, and supervisor endpoints", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_api_intel");

    const agentId = "agt_backend_prj_api_intel";
    const taskId = createTask(server.db, {
      projectId: "prj_api_intel",
      title: "REST Auth Task",
      creatorId: "usr_prj_api_intel",
      agentId,
      requiredCapability: "backend",
    });

    // 1. GET /api/agents/:id/profile
    const profRes = await server.app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/profile`,
    });
    expect(profRes.statusCode).toBe(200);
    expect(profRes.json().profile.agentId).toBe(agentId);

    // 2. GET /api/tasks/:id/routing-explanation
    const routeRes = await server.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/routing-explanation`,
    });
    expect(routeRes.statusCode).toBe(200);
    expect(routeRes.json().candidates.length).toBeGreaterThan(0);

    // 3. GET /api/tasks/:id/context
    const ctxRes = await server.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/context`,
    });
    expect(ctxRes.statusCode).toBe(200);
    expect(ctxRes.json().formattedContext).toContain("REST Auth Task");

    // 4. POST /api/tasks/:id/retry
    const retryRes = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/retry`,
      payload: { reason: "Manual testing" },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().retryTaskId).toMatch(/^tsk_/);

    // 5. GET /api/projects/:id/metrics
    const metRes = await server.app.inject({
      method: "GET",
      url: "/api/projects/prj_api_intel/metrics",
    });
    expect(metRes.statusCode).toBe(200);
    expect(metRes.json().totalTasks).toBeGreaterThan(0);

    await server.app.close();
  });
});
