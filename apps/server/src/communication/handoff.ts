// Artifact-Bound Peer-to-Peer Agent Handoffs.
// Passes structured artifact references and context summaries directly between peer agents without payload bloat.

import type { Db } from "../db.js";
import { getTask, appendEvent } from "../db.js";
import { emitSequenceEvent } from "./sequenceEvents.js";
import type { DelegateHandoff } from "./types.js";

export function delegateHandoff(
  db: Db,
  opts: {
    taskId: string;
    fromAgentId: string;
    toAgentId: string;
    artifacts: {
      diffArtifactId?: string;
      testReportArtifactId?: string;
      buildArtifactId?: string;
      [key: string]: string | undefined;
    };
    contextSummary?: {
      designDecisions?: string[];
      filesModified?: string[];
      knownLimitations?: string[];
    };
    correlationId?: string;
  }
): DelegateHandoff | null {
  const task = getTask(db, opts.taskId);
  if (!task) return null;

  const fromAgent = db.prepare("SELECT name FROM agents WHERE id = ?").get(opts.fromAgentId) as any;
  const toAgent = db.prepare("SELECT name FROM agents WHERE id = ?").get(opts.toAgentId) as any;

  const fromName = fromAgent?.name ?? opts.fromAgentId;
  const toName = toAgent?.name ?? opts.toAgentId;

  const correlationId = opts.correlationId ?? `corr_${crypto.randomUUID()}`;

  const summary = `Handoff from ${fromName} to ${toName} for task "${task.title}" (artifacts: ${Object.keys(opts.artifacts).filter((k) => opts.artifacts[k]).join(", ")})`;

  // Emit Sequence Event: DELEGATE_HANDOFF
  emitSequenceEvent(db, {
    projectId: task.project_id,
    taskId: task.id,
    correlationId,
    type: "DELEGATE_HANDOFF",
    source: { type: "AGENT", id: opts.fromAgentId, label: fromName },
    target: { type: "AGENT", id: opts.toAgentId, label: toName },
    summary,
    metadata: {
      artifacts: opts.artifacts,
      contextSummary: opts.contextSummary,
    },
  });

  appendEvent(db, task.project_id, task.id, "task.handoff", {
    taskId: task.id,
    fromAgentId: opts.fromAgentId,
    toAgentId: opts.toAgentId,
    artifacts: opts.artifacts,
    contextSummary: opts.contextSummary,
  });

  return {
    type: "DELEGATE_HANDOFF",
    taskId: task.id,
    projectId: task.project_id,
    fromAgentId: opts.fromAgentId,
    toAgentId: opts.toAgentId,
    artifacts: opts.artifacts,
    contextSummary: opts.contextSummary ?? {},
    correlationId,
  };
}
