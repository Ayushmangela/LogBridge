import type { Db } from "./types.js";
import { isTaskDependenciesSatisfied } from "./workflows.js";

// ---------------- orchestrator (ORCHESTRATOR.md) ----------------

/** Tasks waiting for someone to run them, oldest first (fair queueing).
 *
 *  Tie-broken on rowid, not id: created_at is only millisecond-resolution, so
 *  several tasks submitted in the same millisecond carry identical timestamps,
 *  and falling back to a random UUID would make the "queue" arbitrary rather
 *  than FIFO. rowid is insertion order by definition. */
export function pendingUnassignedTasks(db: Db) {
  const tasks = db
    .prepare(
      `SELECT id, project_id, required_capability, workflow_id FROM tasks
       WHERE state = 'submitted' AND agent_id IS NULL
       ORDER BY created_at ASC, rowid ASC`
    )
    .all() as { id: string; project_id: string; required_capability: string | null; workflow_id: string | null }[];

  return tasks.filter((t) => {
    // If task is in a workflow, workflow must be active
    if (t.workflow_id) {
      const wf = db.prepare("SELECT state FROM workflows WHERE id = ?").get(t.workflow_id) as any;
      if (!wf || wf.state !== "active") return false;
    }
    // All dependencies must be satisfied (completed)
    return isTaskDependenciesSatisfied(db, t.id);
  });
}

/** How much each agent is already carrying. Only non-terminal, actually-held
 *  work counts — a completed task occupies nobody. */
export function activeTaskCountsByAgent(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT agent_id AS agentId, COUNT(*) AS n FROM tasks
       WHERE agent_id IS NOT NULL AND state IN ('submitted','working','blocked','input-required','auth-required')
       GROUP BY agent_id`
    )
    .all() as any[];
  return new Map(rows.map((r) => [r.agentId, Number(r.n)]));
}

export function candidateAgents(db: Db, projectId: string) {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.capabilities, a.concurrency, m.online
       FROM agents a JOIN machines m ON m.id = a.machine_id
       WHERE a.project_id = ? AND COALESCE(a.paused, 0) = 0 AND COALESCE(a.retired, 0) = 0`
    )
    .all(projectId) as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    capabilities: (() => { try { return JSON.parse(r.capabilities ?? "[]"); } catch { return []; } })(),
    concurrency: Number(r.concurrency ?? 1),
    machineOnline: Boolean(r.online),
  }));
}

/** Claim a task for an agent. The `agent_id IS NULL` guard makes this a no-op
 *  if something else already claimed it, so a double call can't double-assign. */
export function assignTaskToAgent(db: Db, taskId: string, agentId: string): boolean {
  const res = db
    .prepare("UPDATE tasks SET agent_id = ? WHERE id = ? AND agent_id IS NULL AND state = 'submitted'")
    .run(agentId, taskId);
  return res.changes > 0;
}
