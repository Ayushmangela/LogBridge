// Normalized Communication Sequence Event Recorder & Projector.
// Provides backend persistence and real-time WebSocket event emission for the Live Sequence Flow Inspector.

import type { Db } from "../db.js";
import { insertSequenceEvent, getSequenceEventsByProject, getSequenceEventsByTask, appendEvent } from "../db.js";
import type { SequenceEvent, CommunicationEventType, SequenceEventActor } from "./types.js";

export function emitSequenceEvent(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    taskId?: string | null;
    correlationId?: string | null;
    type: CommunicationEventType;
    source: SequenceEventActor;
    target?: SequenceEventActor | null;
    summary: string;
    metadata?: Record<string, unknown>;
  }
): SequenceEvent {
  const row = insertSequenceEvent(db, {
    id: opts.id,
    projectId: opts.projectId,
    taskId: opts.taskId,
    correlationId: opts.correlationId,
    type: opts.type,
    source: opts.source,
    target: opts.target,
    summary: opts.summary,
    metadata: opts.metadata,
  });

  const event: SequenceEvent = {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type as CommunicationEventType,
    projectId: row.project_id,
    source: {
      type: row.source_type as any,
      id: row.source_id,
      label: row.source_label,
    },
    target: row.target_type && row.target_id && row.target_label
      ? {
          type: row.target_type as any,
          id: row.target_id,
          label: row.target_label,
        }
      : undefined,
    taskId: row.task_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    summary: row.summary,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  };

  // Broadcast to live WebSocket clients
  appendEvent(db, opts.projectId, opts.taskId ?? null, "sequence.event", event);

  return event;
}

export function getProjectSequenceFlow(
  db: Db,
  projectId: string,
  limit: number = 200
): SequenceEvent[] {
  const rows = getSequenceEventsByProject(db, projectId, limit);
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type as CommunicationEventType,
    projectId: r.project_id,
    source: {
      type: r.source_type as any,
      id: r.source_id,
      label: r.source_label,
    },
    target: r.target_type && r.target_id && r.target_label
      ? {
          type: r.target_type as any,
          id: r.target_id,
          label: r.target_label,
        }
      : undefined,
    taskId: r.task_id ?? undefined,
    correlationId: r.correlation_id ?? undefined,
    summary: r.summary,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
  }));
}

export function getTaskSequenceFlow(
  db: Db,
  taskId: string
): SequenceEvent[] {
  const rows = getSequenceEventsByTask(db, taskId);
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type as CommunicationEventType,
    projectId: r.project_id,
    source: {
      type: r.source_type as any,
      id: r.source_id,
      label: r.source_label,
    },
    target: r.target_type && r.target_id && r.target_label
      ? {
          type: r.target_type as any,
          id: r.target_id,
          label: r.target_label,
        }
      : undefined,
    taskId: r.task_id ?? undefined,
    correlationId: r.correlation_id ?? undefined,
    summary: r.summary,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
  }));
}
