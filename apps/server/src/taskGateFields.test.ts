// `createTask()` has accepted expectedOutputs / acceptanceChecks /
// requiresReview since the completion gate was built. `POST /api/tasks` never
// read them — so a task made by a PERSON bypassed all three gates while a
// task made by the planner was held to them. The verification subsystem was
// unreachable from the product that contains it.
import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";

async function serverWithProject() {
  const server = await buildServer({ dbPath: ":memory:" });
  server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run("prj_1", "P", "org/repo");
  server.db.prepare(
    "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?,?,?,?,?,?,?)"
  ).run("agt_dev", "m1", "usr_1", "prj_1", "Dev", "developer", "idle");
  return server;
}

const post = (server: any, body: any) =>
  server.app.inject({
    method: "POST", url: "/api/tasks",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "prj_1", title: "Work", ...body }),
  });

describe("declaring what done means, from the office", () => {
  test("the three gate fields are stored, not dropped", async () => {
    const server = await serverWithProject();
    server.db.prepare(
      "INSERT INTO project_checks (project_id, name, command, created_by, created_at) VALUES (?,?,?,?,?)"
    ).run("prj_1", "test", "npm test", "usr_1", new Date().toISOString());

    const res = await post(server, {
      expectedOutputs: ["diff", "test_report"],
      acceptanceChecks: ["test"],
      requiresReview: true,
    });
    expect(res.statusCode).toBe(200);

    const row = server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(JSON.parse(res.body).taskId) as any;
    expect(JSON.parse(row.expected_outputs)).toEqual(["diff", "test_report"]);
    expect(JSON.parse(row.acceptance_checks)).toEqual(["test"]);
    expect(row.requires_review).toBe(1);
  });

  test("a check the project has not defined is refused at creation, not at completion", async () => {
    const server = await serverWithProject();
    const res = await post(server, { acceptanceChecks: ["nonexistent"] });
    // Failing later would strand the task for a reason nobody could act on;
    // the person defining it is the one who can still fix it.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("nonexistent");
  });

  test("blank and duplicate entries are cleaned rather than stored", async () => {
    const server = await serverWithProject();
    const res = await post(server, { expectedOutputs: ["diff", "  ", "diff", " test_report "] });
    const row = server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(JSON.parse(res.body).taskId) as any;
    // An empty string would gate the task on an artifact kind no agent can
    // ever produce.
    expect(JSON.parse(row.expected_outputs)).toEqual(["diff", "test_report"]);
  });

  test("omitting them all still creates an ungated task — unchanged behaviour", async () => {
    const server = await serverWithProject();
    const res = await post(server, {});
    const row = server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(JSON.parse(res.body).taskId) as any;
    // NULL, not "[]": "declared nothing" must keep skipping verification
    // entirely, or every existing task starts failing a gate it never had.
    expect(row.expected_outputs).toBeNull();
    expect(row.acceptance_checks).toBeNull();
    expect(row.requires_review).toBe(0);
  });

  test("requiresReview is a real boolean, not any truthy body value", async () => {
    const server = await serverWithProject();
    const res = await post(server, { requiresReview: "no" });
    const row = server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(JSON.parse(res.body).taskId) as any;
    expect(row.requires_review).toBe(0);
  });
});
