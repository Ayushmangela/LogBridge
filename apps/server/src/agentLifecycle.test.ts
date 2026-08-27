import { describe, expect, test } from "vitest";
import { buildServer, type BuiltServer } from "./index.js";
import { openDb, type Db, createTask, appendEvent, writeMemory, isAgentDeleted } from "./db.js";
import { Positions, buildView } from "./view.js";
import { assignPendingTasks } from "./orchestrator.js";
import { WorkspaceView } from "@logbridge/protocol";

function seedTestProject(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "test/repo", "test/repo", "office"
  );
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_other", "test/other", "test/other", "office"
  );
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, ?)").run(
    "usr_ayush", "ayush", "ayush", 0
  );
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)").run(
    "node_m1", "usr_ayush", "m1", new Date().toISOString(), 1
  );
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, character, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 'char_dev', '#3b82f6')`
  ).run("agt_1", "node_m1", "usr_ayush", "prj_test", "dev-api", "developer", JSON.stringify(["backend", "test"]), 1);
}

describe("HANDOFF-SERVER-2 Phase 1 — Agent lifecycle (edit, note, pause, retire, delete)", () => {
  test("PATCH and POST /edit update agent fields and broadcastView reflects changes", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    // PATCH update
    const patchRes = await server.app.inject({
      method: "PATCH",
      url: "/api/agents/agt_1",
      payload: {
        name: "dev-api-updated",
        description: "senior backend agent",
        goal: "zero regressions",
        note: "review before merge",
      },
    });
    expect(patchRes.statusCode).toBe(200);

    const row = server.db.prepare("SELECT * FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.name).toBe("dev-api-updated");
    expect(row.description).toBe("senior backend agent");
    expect(row.goal).toBe("zero regressions");
    expect(row.note).toBe("review before merge");

    // POST /edit alias for browser
    const editRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/edit",
      payload: {
        role: "architect",
        capabilities: ["backend", "arch"],
      },
    });
    expect(editRes.statusCode).toBe(200);
    const row2 = server.db.prepare("SELECT * FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row2.role).toBe("architect");
    expect(JSON.parse(row2.capabilities)).toEqual(["backend", "arch"]);

    await server.app.close();
  });

  test("POST /note updates note field independently", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/note",
      payload: { note: "watch out for flaky tests" },
    });
    expect(res.statusCode).toBe(200);

    const row = server.db.prepare("SELECT note FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.note).toBe("watch out for flaky tests");

    await server.app.close();
  });

  test("pause and resume toggle paused flag and orchestrator excludes paused agent", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    // Pause agent
    const pauseRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/pause",
    });
    expect(pauseRes.statusCode).toBe(200);

    let row = server.db.prepare("SELECT paused, paused_at FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.paused).toBe(1);
    expect(row.paused_at).toBeTruthy();

    // Create unassigned task that requires agent's capability
    const tId = createTask(server.db, {
      projectId: "prj_test",
      title: "critical task",
      spec: "do work",
      creatorId: "usr_ayush",
      requiredCapability: "backend",
    });

    // Orchestrator must not assign it because agt_1 is paused
    const assignments = assignPendingTasks(server.db);
    expect(assignments).toEqual([]);

    // Resume agent
    const resumeRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/resume",
    });
    expect(resumeRes.statusCode).toBe(200);
    row = server.db.prepare("SELECT paused FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.paused).toBe(0);

    // Now orchestrator can assign it
    const assignments2 = assignPendingTasks(server.db);
    expect(assignments2).toHaveLength(1);
    expect(assignments2[0]).toEqual({ taskId: tId, agentId: "agt_1" });

    await server.app.close();
  });

  test("retire and unretire toggle retired flag and exclude from orchestrator", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    const retireRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/retire",
    });
    expect(retireRes.statusCode).toBe(200);
    let row = server.db.prepare("SELECT retired, retired_at FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.retired).toBe(1);
    expect(row.retired_at).toBeTruthy();

    // Create task
    createTask(server.db, {
      projectId: "prj_test",
      title: "retire test task",
      spec: "spec",
      creatorId: "usr_ayush",
      requiredCapability: "backend",
    });
    expect(assignPendingTasks(server.db)).toEqual([]);

    // Unretire
    const unretireRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/unretire",
    });
    expect(unretireRes.statusCode).toBe(200);
    row = server.db.prepare("SELECT retired FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.retired).toBe(0);

    await server.app.close();
  });

  test("DELETE /api/agents/:id removes agent row, keeps memories/history, and deleted_agents prevents resurrect", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    writeMemory(server.db, {
      scope: "project",
      scopeId: null,
      sourceTaskId: null,
      agentId: "agt_1",
      projectId: "prj_test",
      agentName: "dev-api",
      kind: "fact",
      text: "the build script requires node 22",
    });
    const tId = createTask(server.db, {
      projectId: "prj_test",
      title: "old task",
      creatorId: "usr_ayush",
      agentId: "agt_1",
    });

    // Delete agent via DELETE endpoint
    const delRes = await server.app.inject({
      method: "DELETE",
      url: "/api/agents/agt_1",
    });
    expect(delRes.statusCode).toBe(200);

    // Agent row is gone from agents table
    expect(server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get("agt_1")).toBeFalsy();
    // Added to deleted_agents
    expect(isAgentDeleted(server.db, "agt_1")).toBe(true);

    // Memory and past tasks are preserved!
    const mems = server.db.prepare("SELECT * FROM memories WHERE agent_name = ?").all("dev-api");
    expect(mems).toHaveLength(1);
    const tasks = server.db.prepare("SELECT * FROM tasks WHERE id = ?").all(tId);
    expect(tasks).toHaveLength(1);

    await server.app.close();
  });
});

describe("HANDOFF-SERVER-2 Phase 2 — Per-agent history & health", () => {
  test("GET /api/agents/:id/history returns paginated task list with outcome and duration", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    // Create 3 tasks with events
    const t1 = createTask(server.db, {
      projectId: "prj_test",
      title: "Task 1",
      creatorId: "usr_ayush",
      agentId: "agt_1",
    });
    server.db.prepare(
      "UPDATE tasks SET state = 'completed', started_at = '2026-08-26T10:00:00Z', ended_at = '2026-08-26T10:00:15Z' WHERE id = ?"
    ).run(t1);
    appendEvent(server.db, "prj_test", t1, "task.event", { summary: "step 1" });

    const t2 = createTask(server.db, {
      projectId: "prj_test",
      title: "Task 2",
      creatorId: "usr_ayush",
      agentId: "agt_1",
    });
    server.db.prepare("UPDATE tasks SET state = 'failed' WHERE id = ?").run(t2);

    const res = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_1/history?limit=10&offset=0",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe("agt_1");
    expect(body.total).toBe(2);
    expect(body.tasks).toHaveLength(2);
    const first = body.tasks.find((t: any) => t.id === t1);
    expect(first.outcome).toBe("completed");
    expect(first.durationSeconds).toBe(15);
    expect(first.eventCount).toBe(1);

    // Query non-existent agent -> 404
    const errRes = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_unknown/history",
    });
    expect(errRes.statusCode).toBe(404);

    await server.app.close();
  });

  test("Health on AgentView in buildView includes heartbeat, consecutiveFailures, machineOnline", async () => {
    const db = openDb(":memory:");
    seedTestProject(db);

    // Seed two failed tasks for agt_1
    const f1 = createTask(db, { projectId: "prj_test", title: "fail 1", creatorId: "usr", agentId: "agt_1" });
    db.prepare("UPDATE tasks SET state = 'failed' WHERE id = ?").run(f1);
    const f2 = createTask(db, { projectId: "prj_test", title: "fail 2", creatorId: "usr", agentId: "agt_1" });
    db.prepare("UPDATE tasks SET state = 'failed' WHERE id = ?").run(f2);

    const view = buildView(db, new Positions(), "usr_ayush");
    const room = view.rooms.find((r) => r.id === "prj_test")!;
    const ag = room.agents[0];
    expect(ag.machineOnline).toBe(true);
    expect(ag.health).toBeDefined();
    expect(ag.health?.machineOnline).toBe(true);
    expect(ag.health?.consecutiveFailures).toBe(2);
    expect(ag.health?.lastHeartbeat).toBeTruthy();

    expect(WorkspaceView.safeParse(view).success).toBe(true);
    db.close();
  });
});

describe("HANDOFF-SERVER-2 Phase 3 — Steer, Move, Clone", () => {
  test("POST /steer injects context into next task spec", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    const steerRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/steer",
      payload: { text: "focus on unit tests first" },
    });
    expect(steerRes.statusCode).toBe(200);

    const agent = server.db.prepare("SELECT steer_context FROM agents WHERE id = ?").get("agt_1") as any;
    expect(agent.steer_context).toBe("focus on unit tests first");

    await server.app.close();
  });

  test("POST /move changes project_id, refuses non-existent project", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    // Fail if target project doesn't exist
    const failRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/move",
      payload: { projectId: "prj_does_not_exist" },
    });
    expect(failRes.statusCode).toBe(404);

    // Succeed when project exists
    const moveRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/move",
      payload: { projectId: "prj_other" },
    });
    expect(moveRes.statusCode).toBe(200);

    const row = server.db.prepare("SELECT project_id FROM agents WHERE id = ?").get("agt_1") as any;
    expect(row.project_id).toBe("prj_other");

    await server.app.close();
  });

  test("POST /clone creates a duplicate agent in target project", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestProject(server.db);

    const cloneRes = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/clone",
      payload: { projectId: "prj_other", name: "dev-clone" },
    });
    expect(cloneRes.statusCode).toBe(200);
    const body = JSON.parse(cloneRes.body);
    expect(body.ok).toBe(true);
    expect(body.agent.name).toBe("dev-clone");
    expect(body.agent.project_id).toBe("prj_other");
    expect(body.agent.role).toBe("developer");
    expect(body.agent.id).not.toBe("agt_1");

    await server.app.close();
  });
});
