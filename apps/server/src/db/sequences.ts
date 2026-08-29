import type { Db, SequenceEventRow, ReviewVerdictRow } from "./types.js";

// ─── Normalized Sequence Events DB Helpers ───────────────────────────────────

export function insertSequenceEvent(
  db: Db,
  event: {
    id?: string;
    projectId: string;
    taskId?: string | null;
    correlationId?: string | null;
    type: string;
    source: { type: string; id: string; label: string };
    target?: { type: string; id: string; label: string } | null;
    summary: string;
    metadata?: Record<string, any> | null;
    timestamp?: string;
  }
): SequenceEventRow {
  const id = event.id ?? `seq_evt_${crypto.randomUUID()}`;
  const now = event.timestamp ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO sequence_events (
      id, project_id, task_id, correlation_id, type,
      source_type, source_id, source_label,
      target_type, target_id, target_label,
      summary, metadata_json, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    event.projectId,
    event.taskId ?? null,
    event.correlationId ?? null,
    event.type,
    event.source.type,
    event.source.id,
    event.source.label,
    event.target?.type ?? null,
    event.target?.id ?? null,
    event.target?.label ?? null,
    event.summary,
    event.metadata ? JSON.stringify(event.metadata) : null,
    now
  );

  return {
    id,
    project_id: event.projectId,
    task_id: event.taskId ?? null,
    correlation_id: event.correlationId ?? null,
    type: event.type,
    source_type: event.source.type,
    source_id: event.source.id,
    source_label: event.source.label,
    target_type: event.target?.type ?? null,
    target_id: event.target?.id ?? null,
    target_label: event.target?.label ?? null,
    summary: event.summary,
    metadata_json: event.metadata ? JSON.stringify(event.metadata) : null,
    timestamp: now,
  };
}

export function getSequenceEventsByProject(
  db: Db,
  projectId: string,
  limit: number = 100
): SequenceEventRow[] {
  return db
    .prepare("SELECT * FROM sequence_events WHERE project_id = ? ORDER BY timestamp ASC LIMIT ?")
    .all(projectId, limit) as SequenceEventRow[];
}

export function getSequenceEventsByTask(
  db: Db,
  taskId: string
): SequenceEventRow[] {
  return db
    .prepare("SELECT * FROM sequence_events WHERE task_id = ? ORDER BY timestamp ASC")
    .all(taskId) as SequenceEventRow[];
}

// ─── Review Verdicts DB Helpers ──────────────────────────────────────────────

export function createReviewVerdict(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    taskId: string;
    reviewerAgentId: string;
    status: "ACCEPT" | "REJECT";
    comments: string[];
    artifactId?: string | null;
    findings?: Array<{ severity: "INFO" | "WARNING" | "ERROR"; message: string; file?: string; line?: number }> | null;
    reworkTaskId?: string | null;
    correlationId?: string | null;
  }
): ReviewVerdictRow {
  const id = opts.id ?? `rev_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO review_verdicts (
      id, project_id, task_id, reviewer_agent_id, status,
      comments_json, artifact_id, findings_json, rework_task_id,
      correlation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.taskId,
    opts.reviewerAgentId,
    opts.status,
    JSON.stringify(opts.comments),
    opts.artifactId ?? null,
    opts.findings ? JSON.stringify(opts.findings) : null,
    opts.reworkTaskId ?? null,
    opts.correlationId ?? null,
    now
  );

  return {
    id,
    project_id: opts.projectId,
    task_id: opts.taskId,
    reviewer_agent_id: opts.reviewerAgentId,
    status: opts.status,
    comments_json: JSON.stringify(opts.comments),
    artifact_id: opts.artifactId ?? null,
    findings_json: opts.findings ? JSON.stringify(opts.findings) : null,
    rework_task_id: opts.reworkTaskId ?? null,
    correlation_id: opts.correlationId ?? null,
    created_at: now,
  };
}

export function getTaskReviewVerdicts(db: Db, taskId: string): ReviewVerdictRow[] {
  return db.prepare("SELECT * FROM review_verdicts WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as ReviewVerdictRow[];
}
