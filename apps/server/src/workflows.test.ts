import { describe, expect, test } from "vitest";
import {
  openDb,
  createTask,
  createWorkflow,
  getWorkflow,
  getProjectWorkflows,
  setWorkflowState,
  updateTaskWorkflow,
  addTaskDependency,
  removeTaskDependency,
  getTaskDependencies,
  getTaskDependents,
  isTaskDependenciesSatisfied,
  getTaskDependencyStatus,
  hasDependencyCycle,
  getWorkflowGraph,
  updateWorkflowStatusFromTasks,
  setTaskState,
  getTask,
  storeArtifact,
  getArtifact,
  type Db,
} from "./db.js";
import { assignPendingTasks } from "./orchestrator.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_wf") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_${id}`, `u_${id}`, "Coordinator", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run(`m_${id}`, `usr_${id}`, "Machine 1", new Date().toISOString(), 1);
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?,?,?,?,?,?,?)").run(
    `agt_dev_${id}`, `m_${id}`, `usr_${id}`, id, "Developer", "developer", "idle"
  );
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?,?,?,?,?,?,?)").run(
    `agt_rev_${id}`, `m_${id}`, `usr_${id}`, id, "Reviewer", "review", "idle"
  );
}

describe("Task Dependency Validation & Cycle Detection", () => {
  test("self-dependency is rejected", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const t1 = createTask(db, { projectId: "prj_wf", title: "Task 1", creatorId: "usr_coord" });
    const res = addTaskDependency(db, t1, t1);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/itself/i);
    expect(hasDependencyCycle(db, t1, t1)).toBe(true);

    db.close();
  });

  test("cross-project dependency is rejected", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_1");
    seedProject(db, "prj_2");

    const t1 = createTask(db, { projectId: "prj_1", title: "Task 1", creatorId: "usr_coord" });
    const t2 = createTask(db, { projectId: "prj_2", title: "Task 2", creatorId: "usr_coord" });

    const res = addTaskDependency(db, t1, t2);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cross-project/i);

    db.close();
  });

  test("2-node and multi-node circular dependencies are detected and rejected", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const t1 = createTask(db, { projectId: "prj_wf", title: "Task 1", creatorId: "usr_coord" });
    const t2 = createTask(db, { projectId: "prj_wf", title: "Task 2", creatorId: "usr_coord" });
    const t3 = createTask(db, { projectId: "prj_wf", title: "Task 3", creatorId: "usr_coord" });

    // t2 depends on t1
    expect(addTaskDependency(db, t2, t1).ok).toBe(true);

    // t1 depends on t2 -> circular!
    expect(hasDependencyCycle(db, t1, t2)).toBe(true);
    const cycle2 = addTaskDependency(db, t1, t2);
    expect(cycle2.ok).toBe(false);
    expect(cycle2.error).toMatch(/circular/i);

    // t3 depends on t2 (chain: t1 -> t2 -> t3)
    expect(addTaskDependency(db, t3, t2).ok).toBe(true);

    // t1 depends on t3 -> multi-node cycle!
    expect(hasDependencyCycle(db, t1, t3)).toBe(true);
    const cycle3 = addTaskDependency(db, t1, t3);
    expect(cycle3.ok).toBe(false);
    expect(cycle3.error).toMatch(/circular/i);

    db.close();
  });

  test("dependency resolution and status tracking", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const t1 = createTask(db, { projectId: "prj_wf", title: "Backend API", creatorId: "usr_coord" });
    const t2 = createTask(db, { projectId: "prj_wf", title: "Frontend UI", creatorId: "usr_coord" });
    const t3 = createTask(db, { projectId: "prj_wf", title: "Integration Tests", creatorId: "usr_coord" });

    addTaskDependency(db, t3, t1);
    addTaskDependency(db, t3, t2);

    expect(isTaskDependenciesSatisfied(db, t3)).toBe(false);
    let status = getTaskDependencyStatus(db, t3);
    expect(status.satisfied).toBe(false);
    expect(status.blocked).toBe(false);
    expect(status.totalDependencies).toBe(2);
    expect(status.completedCount).toBe(0);

    // Complete t1
    setTaskState(db, t1, "completed");
    expect(isTaskDependenciesSatisfied(db, t3)).toBe(false);

    // Complete t2
    setTaskState(db, t2, "completed");
    expect(isTaskDependenciesSatisfied(db, t3)).toBe(true);
    status = getTaskDependencyStatus(db, t3);
    expect(status.satisfied).toBe(true);
    expect(status.completedCount).toBe(2);

    // Remove dependency
    expect(removeTaskDependency(db, t3, t1)).toBe(true);
    expect(getTaskDependencies(db, t3).length).toBe(1);

    db.close();
  });

  test("failed dependency marks dependent status as blocked", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const t1 = createTask(db, { projectId: "prj_wf", title: "Schema migration", creatorId: "usr_coord" });
    const t2 = createTask(db, { projectId: "prj_wf", title: "Seed database", creatorId: "usr_coord" });

    addTaskDependency(db, t2, t1);
    setTaskState(db, t1, "failed");

    const status = getTaskDependencyStatus(db, t2);
    expect(status.blocked).toBe(true);
    expect(status.satisfied).toBe(false);
    expect(status.failedCount).toBe(1);

    db.close();
  });
});

describe("Workflows & Lifecycle Engine", () => {
  test("creates workflow, attaches tasks, and computes DAG graph", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const wfId = createWorkflow(db, {
      projectId: "prj_wf",
      title: "OAuth 2.0 Feature",
      description: "End-to-end OAuth flow",
      creatorId: "usr_coord",
    });

    expect(wfId).toMatch(/^wf_/);
    const wf = getWorkflow(db, wfId);
    expect(wf?.title).toBe("OAuth 2.0 Feature");
    expect(wf?.state).toBe("active");

    const t1 = createTask(db, { projectId: "prj_wf", title: "1. Arch", creatorId: "usr_coord", workflowId: wfId });
    const t2 = createTask(db, { projectId: "prj_wf", title: "2. Backend", creatorId: "usr_coord", workflowId: wfId });
    addTaskDependency(db, t2, t1);

    const graph = getWorkflowGraph(db, wfId);
    expect(graph).not.toBeNull();
    expect(graph?.tasks.length).toBe(2);
    expect(graph?.edges.length).toBe(1);
    expect(graph?.tasks[0].derivedStatus).toBe("ready");
    expect(graph?.tasks[1].derivedStatus).toBe("waiting");

    // Pause workflow
    setWorkflowState(db, wfId, "paused");
    expect(getWorkflow(db, wfId)?.state).toBe("paused");

    // Resume workflow
    setWorkflowState(db, wfId, "active");
    expect(getWorkflow(db, wfId)?.state).toBe("active");

    // Complete all tasks updates workflow to completed
    setTaskState(db, t1, "completed");
    setTaskState(db, t2, "completed");
    const newWfState = updateWorkflowStatusFromTasks(db, wfId);
    expect(newWfState).toBe("completed");
    expect(getWorkflow(db, wfId)?.state).toBe("completed");

    db.close();
  });
});

describe("Dependency-Aware Orchestration", () => {
  test("orchestrator skips tasks whose dependencies are pending or whose workflow is paused", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const wfId = createWorkflow(db, {
      projectId: "prj_wf",
      title: "Pipeline",
      creatorId: "usr_coord",
    });

    const t1 = createTask(db, { projectId: "prj_wf", title: "Step 1", creatorId: "usr_coord", workflowId: wfId });
    const t2 = createTask(db, { projectId: "prj_wf", title: "Step 2", creatorId: "usr_coord", workflowId: wfId });
    addTaskDependency(db, t2, t1);

    // Initial pass: only t1 is eligible
    const assigned1 = assignPendingTasks(db);
    expect(assigned1.length).toBe(1);
    expect(assigned1[0].taskId).toBe(t1);

    // Finish t1 as working -> completed
    setTaskState(db, t1, "working");
    setTaskState(db, t1, "completed");

    // t2 is now eligible
    const assigned2 = assignPendingTasks(db);
    expect(assigned2.length).toBe(1);
    expect(assigned2[0].taskId).toBe(t2);

    db.close();
  });
});

describe("REST APIs for Workflows, Dependencies, Handoffs & Reviews", () => {
  test("full REST API workflow execution", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_rest");

    // 1. Create workflow
    const wfRes = await server.app.inject({
      method: "POST",
      url: "/api/projects/prj_rest/workflows",
      payload: { title: "Auth Pipeline", description: "JWT & Refresh" },
    });
    expect(wfRes.statusCode).toBe(200);
    const { workflowId } = wfRes.json();
    expect(workflowId).toMatch(/^wf_/);

    // 2. Add tasks to workflow with dependency
    const t1Res = await server.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/tasks`,
      payload: { title: "Design DB" },
    });
    const { taskId: t1 } = t1Res.json();

    const t2Res = await server.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/tasks`,
      payload: { title: "Implement API", dependsOn: [t1] },
    });
    const { taskId: t2 } = t2Res.json();

    // 3. Query workflow graph
    const graphRes = await server.app.inject({
      method: "GET",
      url: `/api/workflows/${workflowId}`,
    });
    expect(graphRes.statusCode).toBe(200);
    const graph = graphRes.json();
    expect(graph.tasks.length).toBe(2);
    expect(graph.edges.length).toBe(1);

    // 4. Query task dependencies
    const depRes = await server.app.inject({
      method: "GET",
      url: `/api/tasks/${t2}/dependencies`,
    });
    expect(depRes.statusCode).toBe(200);
    expect(depRes.json().dependencies.length).toBe(1);

    // 5. Store an artifact for t1
    const artId = storeArtifact(server.db, {
      projectId: "prj_rest",
      taskId: t1,
      creatorId: "agt_dev_prj_rest",
      kind: "diff",
      title: "Schema patch",
      filePath: "migrations/001.sql",
    });

    // 6. Agent Handoff from Developer to Reviewer
    const handoffRes = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${t1}/handoff`,
      payload: {
        fromAgentId: "agt_dev_prj_rest",
        toAgentId: "agt_rev_prj_rest",
        summary: "Schema implementation ready for review",
        instructions: "Please verify indexes and foreign keys",
        artifactRefs: [artId],
      },
    });
    expect(handoffRes.statusCode).toBe(200);
    expect(handoffRes.json().handedTo).toBe("agt_rev_prj_rest");
    expect(getTask(server.db, t1)?.agent_id).toBe("agt_rev_prj_rest");

    // 7. Reject cross-project handoff
    seedProject(server.db, "prj_other");
    const badHandoff = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${t1}/handoff`,
      payload: {
        fromAgentId: "agt_dev_prj_rest",
        toAgentId: "agt_dev_prj_other",
        summary: "Invalid transfer",
      },
    });
    expect(badHandoff.statusCode).toBe(400);

    // 8. Submit Review with Changes Requested -> Creates follow-up rework task
    const reviewRes = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${t1}/review`,
      payload: {
        reviewerId: "agt_rev_prj_rest",
        verdict: "changes_requested",
        summary: "Add unique index on email column",
      },
    });
    expect(reviewRes.statusCode).toBe(200);
    const reviewData = reviewRes.json();
    expect(reviewData.verdict).toBe("changes_requested");
    expect(reviewData.reworkTaskId).toMatch(/^tsk_/);

    const reworkTask = getTask(server.db, reviewData.reworkTaskId);
    expect(reworkTask?.title).toContain("[Rework]");
    expect(reworkTask?.parent_task).toBe(t1);
    expect(reworkTask?.retry_of).toBe(t1);

    // 9. Pause and resume workflow
    const pauseRes = await server.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/pause`,
    });
    expect(pauseRes.json().state).toBe("paused");

    const resumeRes = await server.app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/resume`,
    });
    expect(resumeRes.json().state).toBe("active");

    await server.app.close();
  });
});
