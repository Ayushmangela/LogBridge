// Turning an agent's "here is what I made" into evidence on record.
//
// PROTOCOL.md has always instructed agents to reference artifacts rather than
// paste them:
//
//   "NEVER paste raw diffs, file listings, or walls of code into message
//    bodies. Save the artifact to disk or pass its reference ID/path
//    (e.g. "artifacts": { "diff": "path/to/patch" })"
//
// Agents followed it. Nothing read the field, so every declaration was thrown
// away at the router and the `artifacts` table stayed empty — which is the
// reason a task's completion could never be checked against anything.
import type { Db } from "./db.js";
import { storeArtifact, appendEvent } from "./db.js";
import { normalizeArtifacts, type HiveMessage } from "./hive.js";

/** A path is evidence, not a command. Reject anything that tries to escape the
 *  project, and anything absurd, before it is stored and later stat()ed. */
function safePath(p: string | null): string | null {
  if (!p) return null;
  const trimmed = p.trim();
  if (!trimmed || trimmed.length > 400) return null;
  if (trimmed.includes("..")) return null;
  if (trimmed.includes("\0")) return null;
  return trimmed;
}

/**
 * Store every artifact a hive message declares, attributed to the sender's
 * current task.
 *
 * Attribution is by the agent's CURRENT task rather than anything in the
 * message, because agents do not know their task id — nothing ever tells them
 * one. That is also why this cannot be strict: a declaration that arrives when
 * the agent has no task is still recorded against the project, where it is
 * visible, rather than dropped.
 */
export function recordDeclaredArtifacts(
  db: Db,
  msg: HiveMessage,
  fromAgentId: string,
  projectId: string
): number {
  const declared = normalizeArtifacts((msg as any)?.artifacts);
  if (!declared.length) return 0;

  const agent = db.prepare("SELECT current_task FROM agents WHERE id = ?").get(fromAgentId) as any;
  const taskId = agent?.current_task ?? null;

  let stored = 0;
  for (const a of declared) {
    const kind = a.kind.slice(0, 60);
    if (!kind) continue;
    try {
      storeArtifact(db, {
        projectId,
        taskId,
        creatorId: fromAgentId,
        kind,
        title: (a.title ?? a.path ?? kind).slice(0, 200),
        summary: msg.subject ? String(msg.subject).slice(0, 400) : null,
        filePath: safePath(a.path),
      });
      stored++;
    } catch {
      // One malformed declaration must not cost the message its delivery.
    }
  }

  if (stored) {
    appendEvent(db, projectId, taskId, "artifact.declared", {
      agentId: fromAgentId,
      count: stored,
      kinds: declared.map((d) => d.kind),
    });
  }
  return stored;
}
