import type { Db } from "./types.js";
import { appendEvent } from "./schema.js";

// ---------------- tasks: the queue IS the tasks table ----------------
// A task in `submitted` assigned to one of a machine's agents is an offer
// waiting for that machine to come online. A task still `working`/`blocked`
// when a machine reconnects is what reconciliation resumes.
export function tasksForMachine(db: Db, machineId: string, states: string[]) {
  const placeholders = states.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT t.*, a.machine_id AS _machineId FROM tasks t
       JOIN agents a ON a.id = t.agent_id
       WHERE a.machine_id = ? AND t.state IN (${placeholders})
       ORDER BY t.id`
    )
    .all(machineId, ...states) as any[];
}

export function getTask(db: Db, id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any | undefined;
}

export function setTaskState(db: Db, id: string, state: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  const setSql = ["state = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(state, ...cols.map((c) => extra[c]), id);
}

export function renewLease(db: Db, id: string, leaseSeconds: number) {
  const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  db.prepare("UPDATE tasks SET lease_expires = ? WHERE id = ?").run(expires, id);
  return expires;
}

// Tasks whose lease has silently expired — the runner went away without
// telling anyone. See SYSTEM.md "the idempotency trap".
export function expiredLeaseTasks(db: Db) {
  return db
    .prepare("SELECT * FROM tasks WHERE state IN ('working','blocked') AND lease_expires < ?")
    .all(new Date().toISOString()) as any[];
}

// A task proposed via chat (D16: natural language in, typed contract out)
// sits in `submitted` without being offered to the runner yet — the human
// has to approve it first. See M4-KICKOFF.md.
export function createTask(
  db: Db,
  opts: {
    projectId: string;
    title: string;
    spec?: string | null;
    creatorId: string;
    agentId?: string | null;        // null = let the orchestrator decide
    requiredCapability?: string | null;
    kind?: string | null;           // 'plan' = its output is a task list
    parentTask?: string | null;     // subtask link to parent goal
    retryOf?: string | null;
    workflowId?: string | null;
    budgetSeconds?: number;
    budgetUsd?: number;
    /** Idempotency key. A second call with the same key returns the FIRST
     *  task's id instead of creating another — which is what makes a firing
     *  loop safe across a restart that lands between "task created" and
     *  "bookkeeping written". */
    idem?: string | null;
  }
): string {
  if (opts.idem) {
    const existing = db.prepare("SELECT id FROM tasks WHERE idem = ?").get(opts.idem) as any;
    if (existing) return existing.id;
  }
  // A task against a project that does not exist is orphaned: it is in no
  // room, no view renders it, and the orchestrator will never route it — it
  // simply sits in the table looking like work. The same reasoning already
  // guards agent creation (see the 404 in /api/agents); SQLite will not
  // enforce it for us here because tasks carries no foreign key.
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(opts.projectId)) {
    throw new Error(`no such project "${opts.projectId}"`);
  }
  const taskId = `tsk_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, required_capability, created_at, kind, parent_task, retry_of, workflow_id, idem)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    taskId, opts.projectId, opts.title, opts.spec ?? null, opts.creatorId, opts.agentId ?? null,
    opts.budgetSeconds ?? 60, opts.budgetUsd ?? 1.0, opts.requiredCapability ?? null, new Date().toISOString(),
    opts.kind ?? null, opts.parentTask ?? null, opts.retryOf ?? null, opts.workflowId ?? null, opts.idem ?? null
  );
  return taskId;
}

// The Kanban board's data source — every task in the project, most recent
// first, capped so a long-lived project's board doesn't ship its entire
// history on every view update (see CONTRACT.md invariant 1: full snapshot,
// no deltas — that only stays cheap if the snapshot itself stays bounded).
export function tasksForProject(db: Db, projectId: string, limit = 100) {
  return db
    .prepare(
      `SELECT t.*, a.name AS agent_name FROM tasks t
       LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.project_id = ?
       ORDER BY t.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as any[];
}

export function pauseTask(db: Db, taskId: string): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return false;
  db.prepare("UPDATE tasks SET state = 'paused' WHERE id = ?").run(taskId);
  if (task.agent_id) {
    db.prepare("UPDATE agents SET status = 'waiting' WHERE id = ?").run(task.agent_id);
  }
  appendEvent(db, task.project_id, taskId, "task.pause", { taskId, agentId: task.agent_id, at: new Date().toISOString() });
  return true;
}

export function resumeTask(db: Db, taskId: string): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return false;
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(taskId);
  if (task.agent_id) {
    db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(task.agent_id);
  }
  appendEvent(db, task.project_id, taskId, "task.resume", { taskId, agentId: task.agent_id, at: new Date().toISOString() });
  return true;
}

export function haltTask(db: Db, taskId: string, reason = "User halted task"): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return false;
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET state = 'cancelled', ended_at = ? WHERE id = ?").run(now, taskId);
  if (task.agent_id) {
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(task.agent_id);
  }
  appendEvent(db, task.project_id, taskId, "task.halt", { taskId, agentId: task.agent_id, reason, at: now });
  return true;
}

export function getAgentTasks(db: Db, agentId: string, limit = 50): any[] {
  return db.prepare(
    `SELECT id, project_id, title, spec, state, budget_seconds, budget_usd, cost_usd, created_at, started_at, ended_at, parent_task
     FROM tasks
     WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(agentId, limit) as any[];
}

export function getTaskTraces(db: Db, taskId: string): any[] {
  const rows = db.prepare(
    `SELECT seq, project_id, task_id, type, body, ts
     FROM events
     WHERE task_id = ?
     ORDER BY seq ASC`
  ).all(taskId) as any[];

  return rows.map((r) => {
    let parsed: any = {};
    try { parsed = JSON.parse(r.body); } catch { parsed = { raw: r.body }; }
    return {
      seq: r.seq,
      taskId: r.task_id,
      type: r.type,
      data: parsed,
      ts: r.ts,
    };
  });
}
