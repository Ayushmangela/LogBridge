import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";
import { openDb, type Db, appendEvent } from "./db.js";
import { Positions, buildView } from "./view.js";
import { WorkspaceView } from "@logbridge/protocol";

function seedFloorConsole(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "test/repo", "test/repo", "office"
  );
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, ?)").run(
    "usr_ayush", "ayush", "ayush", 0
  );
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)").run(
    "node_m1", "usr_ayush", "m1", new Date().toISOString(), 1
  );
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, folder, provider, model, context_used, context_limit, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`
  ).run("agt_1", "node_m1", "usr_ayush", "prj_test", "dev-api", "developer", JSON.stringify(["backend"]), 1, "/repo/path", "opencode", "gpt-4", 12500, 100000, 4);

  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, folder, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`
  ).run("agt_2", "node_m1", "usr_ayush", "prj_test", "dev-qa", "qa", JSON.stringify(["test"]), 1, "/repo/path", "claude");
}

describe("HANDOFF-SERVER-4 Phase 7 — Monitor (dispatch and capacity console)", () => {
  test("AgentView exposes context usage, tool calls, cwd, and engine", () => {
    const db = openDb(":memory:");
    seedFloorConsole(db);

    const view = buildView(db, new Positions(), "usr_ayush");
    const room = view.rooms.find((r) => r.id === "prj_test")!;
    const ag1 = room.agents.find((a) => a.id === "agt_1")!;

    expect(ag1.contextUsed).toBe(12500);
    expect(ag1.contextLimit).toBe(100000);
    expect(ag1.toolCalls).toBe(4);
    expect(ag1.cwd).toBe("/repo/path");
    expect(ag1.provider).toBe("opencode");
    expect(ag1.model).toBe("gpt-4");

    expect(WorkspaceView.safeParse(view).success).toBe(true);
    db.close();
  });

  test("POST /api/agents/:id/engine updates engine provider and model", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedFloorConsole(server.db);

    const res = await server.app.inject({
      method: "POST",
      url: "/api/agents/agt_1/engine",
      payload: { provider: "claude", model: "claude-3-5-sonnet" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.restarting).toBe(true);

    const agent = server.db.prepare("SELECT provider, model FROM agents WHERE id = ?").get("agt_1") as any;
    expect(agent.provider).toBe("claude");
    expect(agent.model).toBe("claude-3-5-sonnet");

    await server.app.close();
  });
});

describe("HANDOFF-SERVER-4 Phase 8 — Message graph", () => {
  test("GET /api/graph constructs nodes and edges from envelope metadata", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedFloorConsole(server.db);

    // Seed events between agents: delegation, review, chat
    appendEvent(server.db, "prj_test", "tsk_1", "delegate.request", {
      fromId: "agt_1",
      fromName: "dev-api",
      targetAgentId: "agt_2",
    });
    appendEvent(server.db, "prj_test", "tsk_2", "review.request", {
      fromId: "agt_1",
      fromName: "dev-api",
      targetAgentId: "agt_2",
    });
    appendEvent(server.db, "prj_test", null, "chat", {
      fromId: "usr_ayush",
      fromName: "ayush",
      to: { id: "agt_1" },
    });

    const res = await server.app.inject({
      method: "GET",
      url: "/api/graph?projectId=prj_test",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.nodes).toHaveLength(2); // agt_1, agt_2
    expect(body.edges.length).toBeGreaterThanOrEqual(2);

    const delegationEdge = body.edges.find((e: any) => e.kind === "delegation");
    expect(delegationEdge).toBeDefined();
    expect(delegationEdge.from).toBe("dev-api");
    expect(delegationEdge.to).toBe("agt_2");
    expect(delegationEdge.count).toBe(1);

    const reviewEdge = body.edges.find((e: any) => e.kind === "review");
    expect(reviewEdge).toBeDefined();
    expect(reviewEdge.kind).toBe("review");

    await server.app.close();
  });
});
