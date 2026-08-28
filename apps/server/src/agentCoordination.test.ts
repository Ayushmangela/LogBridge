import { describe, expect, test } from "vitest";
import {
  openDb,
  createTask,
  createTaskAttempt,
  getActiveTaskAttempt,
  getTaskAttempts,
  finishTaskAttempt,
  failActiveTaskAttempt,
  storeArtifact,
  getTaskArtifacts,
  getProjectArtifacts,
  type Db,
} from "./db.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_coord") {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_coord", "u_coord", "Coordinator", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run("m_coord", "usr_coord", "Machine 1", new Date().toISOString(), 1);
  db.prepare("INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?,?,?,?,?,?,?)").run(
    "agt_dev", "m_coord", "usr_coord", id, "Developer", "developer", "idle"
  );
}

describe("Task Attempts Lifecycle & History", () => {
  test("first execution creates attempt #1, idempotent on duplicate accept", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const taskId = createTask(db, {
      projectId: "prj_coord",
      title: "Implement auth JWT",
      creatorId: "usr_coord",
      agentId: "agt_dev",
    });

    const att1 = createTaskAttempt(db, { taskId, agentId: "agt_dev" });
    expect(att1.attempt_number).toBe(1);
    expect(att1.state).toBe("running");

    // Duplicate accept while running returns the same attempt
    const attDuplicate = createTaskAttempt(db, { taskId, agentId: "agt_dev" });
    expect(attDuplicate.id).toBe(att1.id);
    expect(attDuplicate.attempt_number).toBe(1);

    const allAttempts = getTaskAttempts(db, taskId);
    expect(allAttempts.length).toBe(1);
    db.close();
  });

  test("finishing attempt #1 and running retry creates attempt #2 preserving attempt #1 history", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const taskId = createTask(db, {
      projectId: "prj_coord",
      title: "Run complex migration",
      creatorId: "usr_coord",
      agentId: "agt_dev",
    });

    // Attempt 1 fails
    const att1 = createTaskAttempt(db, { taskId, agentId: "agt_dev" });
    const finished1 = finishTaskAttempt(db, att1.id, {
      state: "failed",
      exitCode: 1,
      errorMessage: "Connection reset by peer",
      costUsd: 0.05,
    });
    expect(finished1).toBe(true);

    // Attempt 2 succeeds
    const att2 = createTaskAttempt(db, { taskId, agentId: "agt_dev" });
    expect(att2.attempt_number).toBe(2);
    expect(att2.id).not.toBe(att1.id);

    const finished2 = finishTaskAttempt(db, att2.id, {
      state: "completed",
      exitCode: 0,
      costUsd: 0.08,
    });
    expect(finished2).toBe(true);

    const history = getTaskAttempts(db, taskId);
    expect(history.length).toBe(2);
    expect(history[0].attempt_number).toBe(1);
    expect(history[0].state).toBe("failed");
    expect(history[0].error_message).toBe("Connection reset by peer");
    expect(history[1].attempt_number).toBe(2);
    expect(history[1].state).toBe("completed");
    db.close();
  });

  test("failActiveTaskAttempt correctly marks running attempt as timed_out", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const taskId = createTask(db, {
      projectId: "prj_coord",
      title: "Long running job",
      creatorId: "usr_coord",
      agentId: "agt_dev",
    });

    createTaskAttempt(db, { taskId, agentId: "agt_dev" });
    expect(getActiveTaskAttempt(db, taskId)?.state).toBe("running");

    failActiveTaskAttempt(db, taskId, "lease expired", "timed_out");
    expect(getActiveTaskAttempt(db, taskId)).toBeUndefined();

    const attempts = getTaskAttempts(db, taskId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].state).toBe("timed_out");
    expect(attempts[0].error_message).toBe("lease expired");
    db.close();
  });
});

describe("Artifacts Storage & Scoping", () => {
  test("stores artifact linked to task and retrieves via getTaskArtifacts & getProjectArtifacts", () => {
    const db = openDb(":memory:");
    seedProject(db);

    const taskId = createTask(db, {
      projectId: "prj_coord",
      title: "Build UI component",
      creatorId: "usr_coord",
    });

    const artId = storeArtifact(db, {
      projectId: "prj_coord",
      taskId,
      creatorId: "agt_dev",
      kind: "diff",
      title: "Header.vue diff patch",
      summary: "Added responsive menu bar",
      filePath: "patches/header_fix.patch",
    });

    expect(artId).toMatch(/^art_/);

    const taskArtifacts = getTaskArtifacts(db, taskId);
    expect(taskArtifacts.length).toBe(1);
    expect(taskArtifacts[0].title).toBe("Header.vue diff patch");
    expect(taskArtifacts[0].file_path).toBe("patches/header_fix.patch");

    const projectArtifacts = getProjectArtifacts(db, "prj_coord");
    expect(projectArtifacts.length).toBe(1);
    expect(projectArtifacts[0].id).toBe(artId);

    // Other project has 0 artifacts
    expect(getProjectArtifacts(db, "prj_other").length).toBe(0);
    db.close();
  });
});

describe("REST APIs for Attempts & Artifacts", () => {
  test("GET /api/tasks/:id/attempts and GET/POST /api/tasks/:id/artifacts", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_api");

    const taskId = createTask(server.db, {
      projectId: "prj_api",
      title: "Task with artifacts",
      creatorId: "usr_coord",
      agentId: "agt_dev",
    });

    createTaskAttempt(server.db, { taskId, agentId: "agt_dev" });

    // 1. GET /api/tasks/:id/attempts
    const attRes = await server.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/attempts`,
    });
    expect(attRes.statusCode).toBe(200);
    const attBody = attRes.json();
    expect(attBody.ok).toBe(true);
    expect(attBody.attempts.length).toBe(1);
    expect(attBody.attempts[0].attempt_number).toBe(1);

    // 2. POST /api/tasks/:id/artifacts
    const postArt = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/artifacts`,
      payload: {
        kind: "test_report",
        title: "Vitest 12/12 passed",
        summary: "All unit tests green",
      },
    });
    expect(postArt.statusCode).toBe(200);
    const postArtBody = postArt.json();
    expect(postArtBody.ok).toBe(true);
    expect(postArtBody.artifactId).toMatch(/^art_/);

    // 3. GET /api/tasks/:id/artifacts
    const getArt = await server.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/artifacts`,
    });
    expect(getArt.statusCode).toBe(200);
    const getArtBody = getArt.json();
    expect(getArtBody.ok).toBe(true);
    expect(getArtBody.artifacts.length).toBe(1);
    expect(getArtBody.artifacts[0].title).toBe("Vitest 12/12 passed");

    // 4. Reject unsafe path traversal
    const badPathRes = await server.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/artifacts`,
      payload: {
        kind: "log",
        title: "System log",
        filePath: "../../etc/passwd",
      },
    });
    expect(badPathRes.statusCode).toBe(400);

    await server.app.close();
  });
});
