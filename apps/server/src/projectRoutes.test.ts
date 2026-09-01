import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";
import { createSession } from "./sessions.js";

describe("Project Management & Single Commander Architecture", () => {
  test("POST /api/projects creates a project and spawns exactly ONE Commander agent", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    // Seed machine & user
    server.db.prepare("INSERT INTO users (id, name, avatar) VALUES ('usr_ayush', 'Ayush', 0)").run();
    server.db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES ('node_1', 'usr_ayush', 'ayush-mac', 1)").run();

    // /api/projects is scoped to the caller's memberships now, so the request
    // has to say who is asking. The auth gate itself is off under vitest, but
    // the route still reads the session to decide what this user may see.
    const auth = { authorization: `Bearer ${createSession(server.db, "usr_ayush")}` };

    // 1. Initially projects list is empty
    const res1 = await server.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: auth,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.projects).toEqual([]);

    // 2. Create a new project: "Nike Global Store"
    const res2 = await server.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        name: "Nike Global Store",
        commanderName: "nike-commander",
      }),
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.ok).toBe(true);
    expect(body2.project.name).toBe("Nike Global Store");
    expect(body2.project.slug).toBe("nike-global-store");
    expect(body2.commander.name).toBe("nike-commander");
    expect(body2.commander.role).toBe("planner");

    // 3. Verify exactly ONE agent exists for this project in the database
    const agents = server.db.prepare("SELECT * FROM agents WHERE project_id = ?").all(body2.project.id) as any[];
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe("nike-commander");
    expect(agents[0].role).toBe("planner");

    // Verify Commander received orientation message in Hive mailbox and has memory initialized
    const messages = server.hive.getAgentMessages(body2.commander.id);
    expect(messages.inbox.length).toBe(1);
    expect(messages.inbox[0].from).toBe("operator");
    expect(messages.inbox[0].subject).toContain("Welcome, Commander");
    const memory = server.hive.getAgentMemory(body2.commander.id);
    expect(memory).toContain("Central Operations Commander Memory");

    // 4. Verify project list returns the new project with commander
    const res3 = await server.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: auth,
    });
    const body3 = JSON.parse(res3.body);
    expect(body3.projects.length).toBe(1);
    expect(body3.projects[0].name).toBe("Nike Global Store");
    expect(body3.projects[0].agentCount).toBe(1);
    expect(body3.projects[0].commanderName).toBe("nike-commander");

    // 5. Delete project
    const res4 = await server.app.inject({
      method: "DELETE",
      url: `/api/projects/${body2.project.id}`,
    });
    expect(res4.statusCode).toBe(200);
    const remaining = server.db.prepare("SELECT * FROM projects WHERE id = ?").all(body2.project.id);
    expect(remaining.length).toBe(0);
    const remainingAgents = server.db.prepare("SELECT * FROM agents WHERE project_id = ?").all(body2.project.id);
    expect(remainingAgents.length).toBe(0);
  });
});
