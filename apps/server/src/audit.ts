// Immutable Project Audit Trail (Phase 5).
// Centralized logging for all sensitive governance, permissions, and execution events.

import type { Db } from "./db.js";

export interface AuditLogEntry {
  id?: string;
  projectId: string;
  actorType: "user" | "agent" | "supervisor" | "system";
  actorId: string;
  action: string;
  resourceType: "approval" | "workflow" | "goal" | "task" | "agent" | "member" | "policy";
  resourceId: string;
  metadata?: any;
  timestamp?: string;
}

export function recordAuditLog(db: Db, entry: AuditLogEntry): string {
  const id = entry.id || `aud_${crypto.randomUUID()}`;
  const now = entry.timestamp || new Date().toISOString();

  db.prepare(
    `INSERT INTO audit_logs (id, project_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.projectId,
    entry.actorType,
    entry.actorId,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    now
  );

  return id;
}

export function getProjectAuditLogs(
  db: Db,
  projectId: string,
  limit: number = 100
): AuditLogEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?`
    )
    .all(projectId, limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
    timestamp: r.timestamp,
  }));
}
