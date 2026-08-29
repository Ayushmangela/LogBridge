import type { Db, TaskAttemptRow, ArtifactRow } from "./types.js";

// ---------------- Task Attempts & Artifacts ----------------

export function createTaskAttempt(
  db: Db,
  opts: {
    taskId: string;
    agentId: string;
    attemptNumber?: number;
  }
): TaskAttemptRow {
  // Idempotency: if an attempt is already running for this task and agent, reuse it
  const existingActive = db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? AND state = 'running' ORDER BY attempt_number DESC LIMIT 1")
    .get(opts.taskId) as TaskAttemptRow | undefined;
  if (existingActive) {
    return existingActive;
  }

  const num = opts.attemptNumber ??
    ((db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextNum FROM task_attempts WHERE task_id = ?").get(opts.taskId) as any)?.nextNum ?? 1);

  const attemptId = `att_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, state, started_at, cost_usd)
     VALUES (?, ?, ?, ?, 'running', ?, 0)`
  ).run(attemptId, opts.taskId, num, opts.agentId, now);

  return {
    id: attemptId,
    task_id: opts.taskId,
    attempt_number: num,
    agent_id: opts.agentId,
    state: "running",
    started_at: now,
    ended_at: null,
    exit_code: null,
    error_message: null,
    cost_usd: 0,
  };
}

export function getActiveTaskAttempt(db: Db, taskId: string): TaskAttemptRow | undefined {
  return db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? AND state = 'running' ORDER BY attempt_number DESC LIMIT 1")
    .get(taskId) as TaskAttemptRow | undefined;
}

export function getTaskAttempts(db: Db, taskId: string): TaskAttemptRow[] {
  return db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC")
    .all(taskId) as TaskAttemptRow[];
}

export function finishTaskAttempt(
  db: Db,
  attemptId: string,
  opts: {
    state?: "completed" | "failed" | "timed_out" | "canceled";
    exitCode?: number | null;
    errorMessage?: string | null;
    costUsd?: number;
  } = {}
): boolean {
  const state = opts.state ?? "completed";
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE task_attempts
       SET state = ?, ended_at = ?, exit_code = ?, error_message = ?, cost_usd = COALESCE(?, cost_usd)
       WHERE id = ? AND state = 'running'`
    )
    .run(state, now, opts.exitCode ?? null, opts.errorMessage ?? null, opts.costUsd ?? null, attemptId);
  return res.changes > 0;
}

export function failActiveTaskAttempt(
  db: Db,
  taskId: string,
  errorMessage: string,
  state: "failed" | "timed_out" | "canceled" = "failed"
): boolean {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE task_attempts
       SET state = ?, ended_at = ?, error_message = ?
       WHERE task_id = ? AND state = 'running'`
    )
    .run(state, now, errorMessage, taskId);
  return res.changes > 0;
}

export function storeArtifact(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    taskId?: string | null;
    attemptId?: string | null;
    creatorId: string;
    kind: string;
    title: string;
    summary?: string | null;
    filePath?: string | null;
  }
): string {
  const id = opts.id || `art_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO artifacts (id, project_id, task_id, attempt_id, creator_id, kind, title, summary, file_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.taskId ?? null,
    opts.attemptId ?? null,
    opts.creatorId,
    opts.kind,
    opts.title,
    opts.summary ?? null,
    opts.filePath ?? null,
    now
  );
  return id;
}

export function getTaskArtifacts(db: Db, taskId: string): ArtifactRow[] {
  return db
    .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as ArtifactRow[];
}

export function getProjectArtifacts(db: Db, projectId: string, limit = 50): ArtifactRow[] {
  return db
    .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(projectId, limit) as ArtifactRow[];
}

export function getArtifact(db: Db, id: string): ArtifactRow | undefined {
  return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
}
