import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createTask } from "./db.js";

/**
 * The actual cold-boot-race fix (a fresh PTY needs time before it's
 * written to) lives in spawnAndSubmit now — see ptySpawnAndSubmit.test.ts.
 * This just checks deliverTaskLocally hands that function the right
 * arguments (agent id, agent name, and the task's spec-or-title), since
 * that's the part specific to this call site.
 */
vi.mock("./ptyGateway.js", () => ({
  spawnAndSubmit: vi.fn(() => true),
}));

describe("deliverTaskLocally delegates to spawnAndSubmit correctly", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "logbridge-local-delivery-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("passes the agent's id, name, and the task's spec through", async () => {
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");

    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T', ?)").run(dir);
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss','m1','u1','prj_t','commando','planner', ?, 'idle', 1)`
    ).run(dir);
    const taskId = createTask(db, {
      projectId: "prj_t", title: "build the homepage", spec: "build the homepage, mobile-first",
      creatorId: "you", agentId: "agt_boss",
    });

    const ok = deliverTaskLocally(db, taskId);
    expect(ok).toBe(true);
    expect(spawnAndSubmit).toHaveBeenCalledWith(db, "agt_boss", "commando", "build the homepage, mobile-first", undefined);

    const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
    expect(task.state).toBe("working");
  });

  test("falls back to the title when the task has no spec", async () => {
    const { spawnAndSubmit } = await import("./ptyGateway.js");
    const { deliverTaskLocally } = await import("./nodeGateway/task-offers.js");

    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t2','T2', ?)").run(dir);
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss2','m1','u1','prj_t2','commando','planner', ?, 'idle', 1)`
    ).run(dir);
    const taskId = createTask(db, {
      projectId: "prj_t2", title: "add a FAQ section",
      creatorId: "you", agentId: "agt_boss2",
    });

    deliverTaskLocally(db, taskId);
    expect(spawnAndSubmit).toHaveBeenCalledWith(db, "agt_boss2", "commando", "add a FAQ section", undefined);
  });
});
