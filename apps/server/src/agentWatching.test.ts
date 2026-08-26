import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";
import { openDb, type Db, createTask, appendEvent } from "./db.js";
import { requestAgentGit } from "./nodeGateway.js";

function seedTestWatching(db: Db, online = true, isolation: "shared" | "worktree" = "worktree") {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "test/repo", "test/repo", "office"
  );
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, ?)").run(
    "usr_ayush", "ayush", "ayush", 0
  );
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)").run(
    "node_m1", "usr_ayush", "m1", new Date().toISOString(), online ? 1 : 0
  );
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, isolation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?)`
  ).run("agt_1", "node_m1", "usr_ayush", "prj_test", "dev-api", "developer", JSON.stringify(["backend"]), 1, isolation);
}

describe("HANDOFF-SERVER-3 Phase 4 — Traces (what an agent is actually doing)", () => {
  test("GET /api/agents/:id/traces returns structured events grouped by task and redacts absolute paths", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestWatching(server.db);

    const t1 = createTask(server.db, {
      projectId: "prj_test",
      title: "Fix auth bug",
      creatorId: "usr_ayush",
      agentId: "agt_1",
    });

    // Append task.event rows containing tool call and file path
    appendEvent(server.db, "prj_test", t1, "task.event", {
      taskId: t1,
      kind: "tool_call",
      summary: "Read /Users/ayush/Project/LogBridge/src/auth.ts",
      data: { steps: 1 },
    });
    appendEvent(server.db, "prj_test", t1, "task.event", {
      taskId: t1,
      kind: "step",
      summary: "Evaluated auth tokens",
      data: { steps: 2 },
    });

    const res = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_1/traces?limit=10",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.traces).toHaveLength(2);

    // Redaction check: /Users/ayush must be masked
    const pathTrace = body.traces.find((t: any) => t.summary.includes("LogBridge"));
    expect(pathTrace).toBeDefined();
    expect(pathTrace.summary).not.toContain("/Users/ayush");
    expect(pathTrace.summary).toContain("~/Project/LogBridge");
    expect(pathTrace.taskId).toBe(t1);
    expect(pathTrace.taskTitle).toBe("Fix auth bug");

    // Agent with no runs returns empty and valid
    dbCreateAgent2(server.db);
    const resEmpty = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_2/traces",
    });
    expect(resEmpty.statusCode).toBe(200);
    expect(JSON.parse(resEmpty.body).traces).toEqual([]);

    await server.app.close();
  });
});

describe("HANDOFF-SERVER-3 Phase 5 — Read-only output stream", () => {
  test("GET /api/agents/:id/output returns parsed lines and respects since parameter", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestWatching(server.db);

    const t1 = createTask(server.db, {
      projectId: "prj_test",
      title: "Run tests",
      creatorId: "usr_ayush",
      agentId: "agt_1",
    });

    appendEvent(server.db, "prj_test", t1, "task.event", {
      taskId: t1,
      kind: "output",
      summary: "PASS src/auth.test.ts",
    });
    appendEvent(server.db, "prj_test", t1, "task.event", {
      taskId: t1,
      kind: "output",
      summary: "PASS src/db.test.ts",
    });

    // Fetch initial output
    const res = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_1/output?limit=10",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.output).toEqual(["PASS src/auth.test.ts", "PASS src/db.test.ts"]);

    // Output is capped at 400 lines
    const largeRes = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_1/output?limit=1000",
    });
    expect(largeRes.statusCode).toBe(200);
    expect(JSON.parse(largeRes.body).output.length).toBeLessThanOrEqual(400);

    await server.app.close();
  });
});

describe("HANDOFF-SERVER-3 Phase 6 — Git state per agent", () => {
  test("offline machine returns unknown without error or stale cache", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestWatching(server.db, false); // offline machine

    const res = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_1/git",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.branch).toBe("unknown");
    expect(body.error).toBe("machine offline");

    await server.app.close();
  });

  test("shared isolation returns clean non-branch state", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedTestWatching(server.db, true, "shared"); // shared isolation

    const res = await server.app.inject({
      method: "GET",
      url: "/api/agents/agt_1/git",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.branch).toBeNull();
    expect(body.clean).toBe(true);

    await server.app.close();
  });
});

function dbCreateAgent2(db: Db) {
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')`
  ).run("agt_2", "node_m1", "usr_ayush", "prj_test", "dev-qa", "qa", "[]", 1);
}
