import type { Db } from "./types.js";

// ---- Per-Agent History (HANDOFF-SERVER-2 Phase 2) ----
export function getAgentHistory(db: Db, agentId: string, limit = 20, offset = 0) {
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const boundedOffset = Math.max(0, offset);
  const rows = db.prepare(
    `SELECT id, project_id, title, spec, state, created_at, started_at, ended_at, budget_seconds, budget_usd, cost_usd
     FROM tasks WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(agentId, boundedLimit, boundedOffset) as any[];

  const countRow = db.prepare("SELECT COUNT(*) as total FROM tasks WHERE agent_id = ?").get(agentId) as any;
  const total = countRow?.total ?? 0;

  const tasks = rows.map((r) => {
    let durationSeconds: number | null = null;
    if (r.started_at && r.ended_at) {
      durationSeconds = Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000));
    } else if (r.started_at) {
      durationSeconds = Math.max(0, Math.round((Date.now() - new Date(r.started_at).getTime()) / 1000));
    }
    const evtCountRow = db.prepare("SELECT COUNT(*) as n FROM events WHERE task_id = ?").get(r.id) as any;
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      spec: r.spec,
      state: r.state,
      outcome: r.state,
      durationSeconds,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      budgetSeconds: r.budget_seconds,
      costUsd: r.cost_usd,
      eventCount: evtCountRow?.n ?? 0,
    };
  });

  return { agentId, tasks, total, limit: boundedLimit, offset: boundedOffset };
}

// ---- Traces (HANDOFF-SERVER-3 Phase 4) ----
export function getAgentTraces(db: Db, agentId: string, limit = 50) {
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const rows = db.prepare(
    `SELECT e.seq, e.task_id, e.type, e.body, e.ts, t.title as task_title
     FROM events e
     JOIN tasks t ON t.id = e.task_id
     WHERE t.agent_id = ? AND (e.type = 'task.event' OR e.type LIKE 'task%')
     ORDER BY e.seq DESC LIMIT ?`
  ).all(agentId, boundedLimit) as any[];

  return rows.map((r) => {
    let parsed: any = {};
    try { parsed = JSON.parse(r.body); } catch {}
    let kind = parsed.kind ?? "tool_call";
    if (r.type === "task_steer") kind = "steer";
    else if (r.type === "task.pause" || r.type === "task.resume" || r.type === "task.halt") kind = "control";

    // Redact absolute paths and potential secrets
    const summary = typeof parsed.summary === "string"
      ? parsed.summary.replace(/\/Users\/[^\/]+/g, "~").slice(0, 200)
      : (parsed.text ? String(parsed.text).slice(0, 200) : (parsed.reason ? `Halted: ${parsed.reason}` : r.type));
    return {
      id: `tr_${r.seq}`,
      seq: r.seq,
      taskId: r.task_id,
      taskTitle: r.task_title ?? r.task_id,
      kind,
      summary,
      ts: r.ts,
      data: parsed.data ? (typeof parsed.data === "object" ? "[data]" : String(parsed.data).slice(0, 100)) : null,
    };
  });
}

// ---- Output Stream (HANDOFF-SERVER-3 Phase 5) ----
export function getAgentOutput(db: Db, agentId: string, limit = 200, since?: number) {
  const boundedLimit = Math.max(1, Math.min(400, limit));
  let query = `
    SELECT e.seq, e.task_id, e.body, e.ts
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    WHERE t.agent_id = ? AND e.type = 'task.event'
  `;
  const params: any[] = [agentId];
  if (typeof since === "number" && since > 0) {
    query += ` AND e.seq > ?`;
    params.push(since);
  }
  query += ` ORDER BY e.seq ASC LIMIT ?`;
  params.push(boundedLimit);

  const rows = db.prepare(query).all(...params) as any[];
  const lines: string[] = [];
  for (const r of rows) {
    try {
      const b = JSON.parse(r.body);
      if (b.summary) lines.push(String(b.summary));
      else if (b.text) lines.push(String(b.text));
      else if (b.data?.output) {
        if (Array.isArray(b.data.output)) lines.push(...b.data.output.map(String));
        else lines.push(String(b.data.output));
      }
    } catch {}
  }
  const output = lines.slice(-400);
  return { agentId, output, count: output.length };
}

// ---- Message Graph (HANDOFF-SERVER-4 Phase 8) ----
export function getProjectGraph(db: Db, projectId: string, windowHours = 168) {
  const agents = db.prepare(
    `SELECT id, name, role, character, color FROM agents WHERE project_id = ?`
  ).all(projectId) as any[];

  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const evts = db.prepare(
    `SELECT seq, project_id, task_id, type, body, ts
     FROM events
     WHERE project_id = ? AND ts >= ? AND type IN ('delegate.request', 'delegate.decision', 'review.request', 'chat')
     ORDER BY seq DESC LIMIT 500`
  ).all(projectId, since) as any[];

  const edgeMap = new Map<string, { from: string; to: string; kind: string; count: number; lastTs: string }>();

  for (const e of evts) {
    let kind = "chat";
    if (e.type.startsWith("delegate")) kind = "delegation";
    else if (e.type.startsWith("review")) kind = "review";

    let from = "system";
    let to = "";

    try {
      const b = JSON.parse(e.body);
      from = b.fromName ?? b.fromId ?? b.from?.id ?? b.actor ?? "system";
      to = b.targetAgentId ?? b.to?.id ?? b.taskId ?? "";
    } catch {}

    const key = `${from}->${to}:${kind}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
      if (e.ts > existing.lastTs) existing.lastTs = e.ts;
    } else {
      edgeMap.set(key, { from, to, kind, count: 1, lastTs: e.ts });
    }
  }

  const edges = Array.from(edgeMap.values()).slice(0, 50);
  return { nodes: agents, edges };
}
