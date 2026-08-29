import type { Db, GoalState, GoalRow, PlanRevisionRow } from "./types.js";

// ─── Phase 4: Goals, Plans & Revisions ──────────────────────────────

export function createGoal(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    title: string;
    description?: string | null;
    creatorId: string;
    workflowId?: string | null;
    state?: GoalState;
  }
): string {
  const id = opts.id || `gol_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO goals (id, project_id, title, description, state, workflow_id, creator_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, opts.projectId, opts.title, opts.description ?? null,
    opts.state ?? "draft", opts.workflowId ?? null, opts.creatorId, now, now
  );
  return id;
}

export function getGoal(db: Db, id: string): GoalRow | null {
  const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, title: row.title,
    description: row.description, state: row.state, workflowId: row.workflow_id,
    creatorId: row.creator_id, createdAt: row.created_at, updatedAt: row.updated_at,
    approvedAt: row.approved_at, startedAt: row.started_at, completedAt: row.completed_at,
  };
}

export function getProjectGoals(db: Db, projectId: string): GoalRow[] {
  const rows = db.prepare("SELECT * FROM goals WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as any[];
  return rows.map((row) => ({
    id: row.id, projectId: row.project_id, title: row.title,
    description: row.description, state: row.state, workflowId: row.workflow_id,
    creatorId: row.creator_id, createdAt: row.created_at, updatedAt: row.updated_at,
    approvedAt: row.approved_at, startedAt: row.started_at, completedAt: row.completed_at,
  }));
}

export function setGoalState(
  db: Db, id: string, state: GoalState,
  extra?: { approvedAt?: string; startedAt?: string; completedAt?: string; workflowId?: string }
): boolean {
  const now = new Date().toISOString();
  let sql = "UPDATE goals SET state = ?, updated_at = ?";
  const params: any[] = [state, now];
  if (extra?.approvedAt !== undefined) { sql += ", approved_at = ?"; params.push(extra.approvedAt); }
  if (extra?.startedAt !== undefined) { sql += ", started_at = ?"; params.push(extra.startedAt); }
  if (extra?.completedAt !== undefined) { sql += ", completed_at = ?"; params.push(extra.completedAt); }
  if (extra?.workflowId !== undefined) { sql += ", workflow_id = ?"; params.push(extra.workflowId); }
  sql += " WHERE id = ?";
  params.push(id);
  const res = db.prepare(sql).run(...params);
  return res.changes > 0;
}

export function updateGoalWorkflow(db: Db, goalId: string, workflowId: string): boolean {
  const res = db.prepare("UPDATE goals SET workflow_id = ?, updated_at = ? WHERE id = ?").run(
    workflowId, new Date().toISOString(), goalId
  );
  return res.changes > 0;
}

export function createPlanRevision(
  db: Db,
  opts: {
    id?: string; goalId: string; projectId: string; revisionNumber?: number;
    state?: "draft" | "awaiting_approval" | "approved" | "superseded" | "rejected";
    summary?: string | null; steps: any[]; impactAnalysis?: any | null; createdBy: string;
  }
): string {
  const id = opts.id || `plnrev_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  let revNum = opts.revisionNumber;
  if (revNum === undefined) {
    const latest = db.prepare("SELECT MAX(revision_number) as max_rev FROM plan_revisions WHERE goal_id = ?").get(opts.goalId) as any;
    revNum = (latest?.max_rev ?? 0) + 1;
  }
  db.prepare(
    `INSERT INTO plan_revisions (id, goal_id, project_id, revision_number, state, summary, steps_json, impact_analysis_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, opts.goalId, opts.projectId, revNum, opts.state ?? "draft", opts.summary ?? null,
    JSON.stringify(opts.steps), opts.impactAnalysis ? JSON.stringify(opts.impactAnalysis) : null, opts.createdBy, now);
  return id;
}

function mapPlanRevisionRow(row: any): PlanRevisionRow {
  return {
    id: row.id, goalId: row.goal_id, projectId: row.project_id,
    revisionNumber: Number(row.revision_number), state: row.state, summary: row.summary,
    stepsJson: row.steps_json, impactAnalysisJson: row.impact_analysis_json,
    createdBy: row.created_by, createdAt: row.created_at, approvedAt: row.approved_at,
  };
}

export function getPlanRevision(db: Db, id: string): PlanRevisionRow | null {
  const row = db.prepare("SELECT * FROM plan_revisions WHERE id = ?").get(id) as any;
  return row ? mapPlanRevisionRow(row) : null;
}

export function getLatestPlanRevision(db: Db, goalId: string): PlanRevisionRow | null {
  const row = db.prepare("SELECT * FROM plan_revisions WHERE goal_id = ? ORDER BY revision_number DESC LIMIT 1").get(goalId) as any;
  return row ? mapPlanRevisionRow(row) : null;
}

export function getPlanRevisions(db: Db, goalId: string): PlanRevisionRow[] {
  const rows = db.prepare("SELECT * FROM plan_revisions WHERE goal_id = ? ORDER BY revision_number ASC").all(goalId) as any[];
  return rows.map(mapPlanRevisionRow);
}

export function setPlanRevisionState(
  db: Db, id: string,
  state: "draft" | "awaiting_approval" | "approved" | "superseded" | "rejected",
  approvedAt?: string
): boolean {
  let sql = "UPDATE plan_revisions SET state = ?";
  const params: any[] = [state];
  if (approvedAt !== undefined) { sql += ", approved_at = ?"; params.push(approvedAt); }
  sql += " WHERE id = ?";
  params.push(id);
  const res = db.prepare(sql).run(...params);
  return res.changes > 0;
}
