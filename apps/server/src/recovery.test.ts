import { describe, expect, test } from "vitest";
import { openDb, createTask, setTaskState, setAgentStatus, createTaskAttempt } from "./db.js";
import { recoverServerState } from "./recovery.js";

/**
 * Every server restart ran this. It "requeued" any task that was `working`
 * into a state literally called `queued` — a value nothing else in the
 * codebase reads. reconcileOnConnect only looks for `submitted`; nothing
 * calls orchestrate() on a bare startup. A task landed there stayed there
 * forever, invisible in the UI, across every future restart too.
 *
 * Worse: the agent's own status was never reset. It stayed `working` with
 * `current_task` pointing at a task that no longer meaningfully was —
 * which silently blocked every future chat instruction to that agent,
 * since parseMention only dispatches to an agent it sees as idle.
 */
describe("recoverServerState makes stranded work usable again, not just consistent", () => {
  function setup() {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T','/tmp/t')").run();
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss','m1','u1','prj_t','commando','planner','/tmp/t','working', 1)`
    ).run();
    const taskId = createTask(db, {
      projectId: "prj_t", title: "build the homepage", spec: "build the homepage",
      creatorId: "you", agentId: "agt_boss",
    });
    setTaskState(db, taskId, "working", { started_at: new Date().toISOString() });
    setAgentStatus(db, "agt_boss", "working", taskId);
    createTaskAttempt(db, { taskId, agentId: "agt_boss" });
    return { db, taskId };
  }

  test("a stranded task lands in a state something can actually dispatch again", () => {
    const { db, taskId } = setup();
    recoverServerState(db);
    const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
    expect(task.state).toBe("submitted");
  });

  test("the agent is freed, not left permanently 'working' with a dead task", () => {
    const { db, taskId } = setup();
    recoverServerState(db);
    const agent = db.prepare("SELECT status, current_task FROM agents WHERE id = 'agt_boss'").get() as any;
    expect(agent.status).toBe("idle");
    expect(agent.current_task).toBeFalsy();
  });

  test("an already-terminal task is left alone", () => {
    const { db, taskId } = setup();
    setTaskState(db, taskId, "completed", { ended_at: new Date().toISOString() });
    recoverServerState(db);
    const task = db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any;
    expect(task.state).toBe("completed");
  });
});
