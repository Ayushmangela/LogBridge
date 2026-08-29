import type { Db, WorkflowRow } from "./types.js";
import { getTask } from "./tasks.js";

// ─── Workflows & Task Dependencies (Phase 2) ─────────────────────────

export function createWorkflow(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    title: string;
    description?: string | null;
    creatorId: string;
  }
): string {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(opts.projectId);
  if (!project) throw new Error(`Project "${opts.projectId}" does not exist`);

  const id = opts.id || `wf_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflows (id, project_id, title, description, creator_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, opts.projectId, opts.title.trim(), opts.description?.trim() ?? null, opts.creatorId, now, now);
  return id;
}

export function getWorkflow(db: Db, id: string): WorkflowRow | undefined {
  return db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | undefined;
}

export function getProjectWorkflows(db: Db, projectId: string): WorkflowRow[] {
  return db
    .prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as WorkflowRow[];
}

export function setWorkflowState(
  db: Db,
  id: string,
  state: "active" | "paused" | "completed" | "failed" | "canceled"
): boolean {
  const res = db
    .prepare("UPDATE workflows SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, new Date().toISOString(), id);
  return res.changes > 0;
}

export function updateTaskWorkflow(db: Db, taskId: string, workflowId: string | null): boolean {
  const res = db.prepare("UPDATE tasks SET workflow_id = ? WHERE id = ?").run(workflowId, taskId);
  return res.changes > 0;
}

export function hasDependencyCycle(db: Db, taskId: string, dependsOnTaskId: string): boolean {
  if (taskId === dependsOnTaskId) return true;
  const visited = new Set<string>();
  const queue: string[] = [dependsOnTaskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = db
      .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
      .all(current) as { depends_on_task_id: string }[];

    for (const d of deps) {
      if (!visited.has(d.depends_on_task_id)) {
        queue.push(d.depends_on_task_id);
      }
    }
  }
  return false;
}

export function addTaskDependency(
  db: Db,
  taskId: string,
  dependsOnTaskId: string
): { ok: boolean; error?: string } {
  if (taskId === dependsOnTaskId) {
    return { ok: false, error: "Task cannot depend on itself" };
  }
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: `Task "${taskId}" not found` };
  const depTask = getTask(db, dependsOnTaskId);
  if (!depTask) return { ok: false, error: `Dependency task "${dependsOnTaskId}" not found` };

  if (task.project_id !== depTask.project_id) {
    return { ok: false, error: "Cross-project dependencies are forbidden" };
  }

  if (hasDependencyCycle(db, taskId, dependsOnTaskId)) {
    return { ok: false, error: "Circular dependency detected" };
  }

  db.prepare(
    `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
     VALUES (?, ?, ?)`
  ).run(taskId, dependsOnTaskId, new Date().toISOString());

  return { ok: true };
}

export function removeTaskDependency(db: Db, taskId: string, dependsOnTaskId: string): boolean {
  const res = db
    .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
    .run(taskId, dependsOnTaskId);
  return res.changes > 0;
}

export function getTaskDependencies(
  db: Db,
  taskId: string
): Array<{ taskId: string; dependsOnTaskId: string; title: string; state: string; agentId: string | null }> {
  return db
    .prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId, t.title, t.state, t.agent_id AS agentId
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(taskId) as any[];
}

export function getTaskDependents(
  db: Db,
  taskId: string
): Array<{ taskId: string; dependsOnTaskId: string; title: string; state: string; agentId: string | null }> {
  return db
    .prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId, t.title, t.state, t.agent_id AS agentId
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ?`
    )
    .all(taskId) as any[];
}

export function isTaskDependenciesSatisfied(db: Db, taskId: string): boolean {
  const deps = db
    .prepare(
      `SELECT t.state FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(taskId) as { state: string }[];

  if (deps.length === 0) return true;
  return deps.every((d) => d.state === "completed");
}

export function getTaskDependencyStatus(db: Db, taskId: string) {
  const deps = db
    .prepare(
      `SELECT d.depends_on_task_id AS dependsOnTaskId, t.title, t.state, t.agent_id AS agentId
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(taskId) as Array<{ dependsOnTaskId: string; title: string; state: string; agentId: string | null }>;

  const completedCount = deps.filter((d) => d.state === "completed").length;
  const failedCount = deps.filter((d) => ["failed", "canceled", "rejected"].includes(d.state)).length;
  const pendingCount = deps.length - completedCount - failedCount;
  const isSatisfied = deps.length === 0 || completedCount === deps.length;
  const isBlocked = failedCount > 0;

  return {
    satisfied: isSatisfied,
    blocked: isBlocked,
    totalDependencies: deps.length,
    completedCount,
    failedCount,
    pendingCount,
    dependencies: deps,
  };
}

export function getWorkflowGraph(db: Db, workflowId: string) {
  const wf = getWorkflow(db, workflowId);
  if (!wf) return null;

  const tasks = db
    .prepare(
      `SELECT t.*, a.name AS agent_name FROM tasks t
       LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.workflow_id = ?
       ORDER BY t.created_at ASC`
    )
    .all(workflowId) as any[];

  const taskIds = tasks.map((t) => t.id);
  let dependencies: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => "?").join(",");
    dependencies = db
      .prepare(
        `SELECT task_id AS taskId, depends_on_task_id AS dependsOnTaskId
         FROM task_dependencies
         WHERE task_id IN (${placeholders})`
      )
      .all(...taskIds) as any[];
  }

  const nodes = tasks.map((t) => {
    const depStatus = getTaskDependencyStatus(db, t.id);
    let derivedStatus = t.state;
    if (t.state === "submitted") {
      if (depStatus.blocked) derivedStatus = "blocked";
      else if (!depStatus.satisfied) derivedStatus = "waiting";
      else derivedStatus = "ready";
    }
    return {
      ...t,
      derivedStatus,
      dependencyStatus: depStatus,
    };
  });

  return {
    workflow: wf,
    tasks: nodes,
    edges: dependencies,
  };
}

export function updateWorkflowStatusFromTasks(db: Db, workflowId: string): string {
  const wf = getWorkflow(db, workflowId);
  if (!wf || wf.state === "paused" || wf.state === "canceled") return wf?.state ?? "active";

  const tasks = db.prepare("SELECT state FROM tasks WHERE workflow_id = ?").all(workflowId) as { state: string }[];
  if (tasks.length === 0) return wf.state;

  const allCompleted = tasks.every((t) => t.state === "completed");
  const anyFailed = tasks.some((t) => t.state === "failed" || t.state === "rejected");

  let newState = wf.state;
  if (allCompleted) {
    newState = "completed";
  } else if (anyFailed) {
    const allTerminal = tasks.every((t) => ["completed", "failed", "canceled", "rejected"].includes(t.state));
    if (allTerminal) newState = "failed";
  }

  if (newState !== wf.state) {
    setWorkflowState(db, workflowId, newState as any);
  }
  return newState;
}
