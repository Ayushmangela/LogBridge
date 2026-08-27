import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";
import { setAgentStatus } from "./db.js";

describe("Agent Task Management, Steering, Traces & Commander Suite", () => {
  test("POST /api/tasks creates a task and dispatches to named agent", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_1", "Test Prj", "org/repo"
    );
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_dev", "m1", "usr_1", "prj_1", "Dev Agent", "developer", "idle");

    const res = await server.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "prj_1",
        agentId: "agt_dev",
        title: "Build the payment API",
        spec: "Implement Stripe webhook",
        budgetSeconds: 90,
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.taskId).toMatch(/^tsk_/);
    expect(body.agentId).toBe("agt_dev");

    const taskRow = server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(body.taskId) as any;
    expect(taskRow).toBeDefined();
    expect(taskRow.title).toBe("Build the payment API");
    expect(taskRow.agent_id).toBe("agt_dev");
    expect(taskRow.budget_seconds).toBe(90);
  });

  test("POST /api/agents/:id/steer injects live context into active running task", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_1", "Test Prj", "org/repo"
    );
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_coder", "m1", "usr_1", "prj_1", "Coder", "developer", "working");

    // Seed active task
    server.db.prepare(
      "INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tsk_running_1", "prj_1", "Active Job", "usr_1", "agt_coder", "in_progress");

    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_coder/steer",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Make sure to write tests first",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("live");
    expect(body.taskId).toBe("tsk_running_1");

    // Verify task_steer event exists in events table
    const ev = server.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'task_steer'").get("tsk_running_1") as any;
    expect(ev).toBeDefined();
    const parsed = JSON.parse(ev.body);
    expect(parsed.text).toBe("Make sure to write tests first");
  });

  test("POST /api/tasks/:id/pause, resume, and halt transition lifecycle", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_1", "Test Prj", "org/repo"
    );
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_worker", "m1", "usr_1", "prj_1", "Worker", "developer", "working");

    server.db.prepare(
      "INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tsk_lifecycle", "prj_1", "Job", "usr_1", "agt_worker", "in_progress");

    // 1. Pause
    const pauseRes = await server.app.inject({
      method: "POST",
      url: "/api/tasks/tsk_lifecycle/pause",
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(JSON.parse(pauseRes.body).state).toBe("paused");
    let tRow = server.db.prepare("SELECT state FROM tasks WHERE id = ?").get("tsk_lifecycle") as any;
    expect(tRow.state).toBe("paused");

    // 2. Resume
    const resumeRes = await server.app.inject({
      method: "POST",
      url: "/api/tasks/tsk_lifecycle/resume",
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(JSON.parse(resumeRes.body).state).toBe("in_progress");
    tRow = server.db.prepare("SELECT state FROM tasks WHERE id = ?").get("tsk_lifecycle") as any;
    expect(tRow.state).toBe("in_progress");

    // 3. Halt
    const haltRes = await server.app.inject({
      method: "POST",
      url: "/api/tasks/tsk_lifecycle/halt",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Took too long" }),
    });
    expect(haltRes.statusCode).toBe(200);
    expect(JSON.parse(haltRes.body).state).toBe("cancelled");
    tRow = server.db.prepare("SELECT state, ended_at FROM tasks WHERE id = ?").get("tsk_lifecycle") as any;
    expect(tRow.state).toBe("cancelled");
    expect(tRow.ended_at).toBeDefined();

    const agt = server.db.prepare("SELECT status FROM agents WHERE id = ?").get("agt_worker") as any;
    expect(agt.status).toBe("idle");
  });

  test("GET /api/agents/:id/traces and GET /api/tasks/:id/traces return structured waterfall", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_1", "Test Prj", "org/repo"
    );
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_trace", "m1", "usr_1", "prj_1", "TraceBot", "developer", "idle");

    server.db.prepare(
      "INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("tsk_traced", "prj_1", "Trace Task", "usr_1", "agt_trace", "completed");

    // Seed events
    server.db.prepare(
      "INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)"
    ).run("prj_1", "tsk_traced", "task.event", JSON.stringify({ kind: "thought", summary: "Analyzing codebase architecture" }), new Date().toISOString());

    server.db.prepare(
      "INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)"
    ).run("prj_1", "tsk_traced", "task.event", JSON.stringify({ kind: "tool_call", tool: "read_file", summary: "Reading package.json" }), new Date().toISOString());

    const res = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_trace/traces",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.traces.length).toBe(2);
    expect(body.traces[0].summary).toBeDefined();

    const taskTracesRes = await server.app.inject({
      method: "GET",
      url: "/api/tasks/tsk_traced/traces",
    });
    expect(taskTracesRes.statusCode).toBe(200);
    const tBody = JSON.parse(taskTracesRes.body);
    expect(tBody.ok).toBe(true);
    expect(tBody.traces.length).toBe(2);
  });

  test("POST /api/commander/breakdown creates parent epic and delegates subtasks to specialists", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_epic", "Epic Project", "org/epic"
    );

    // Seed specialist agents
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_commander", "m1", "usr_1", "prj_epic", "Michael", "planner", "idle");

    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_eng", "m1", "usr_1", "prj_epic", "Dwight", "developer", "idle");

    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_qa", "m1", "usr_1", "prj_epic", "Angela", "reviewer", "idle");

    const res = await server.app.inject({
      method: "POST",
      url: "/api/commander/breakdown",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "prj_epic",
        title: "Real-time Notification System",
        spec: "Deliver WebPush and in-app bell notifications",
        commanderId: "agt_commander",
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.parentTaskId).toMatch(/^tsk_/);
    expect(body.subtasks.length).toBe(3);

    // Verify subtasks have parent_task set
    const subRows = server.db.prepare("SELECT * FROM tasks WHERE parent_task = ?").all(body.parentTaskId) as any[];
    expect(subRows.length).toBe(3);
    const assignedAgentIds = subRows.map((r) => r.agent_id);
    expect(assignedAgentIds).toContain("agt_commander");
    expect(assignedAgentIds).toContain("agt_eng");
    expect(assignedAgentIds).toContain("agt_qa");
  });
});
