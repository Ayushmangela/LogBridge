// The loop that actually runs the supervisor.
//
// `evaluateWorkflowHealth()` and `executeSupervisorAction()` have been able to
// spot a stalled workflow and pause, cancel, reassign or retry it since the
// day they were written — but the only thing that ever called them was an HTTP
// route a human had to click. Nothing watched. A workflow could sit BLOCKED
// with a task nobody could take, indefinitely, and the system that knew it was
// blocked never said so.
//
// WHAT IT WILL AND WILL NOT DO ON ITS OWN.
//
// Noticing is safe. Acting is not, and the actions are not equally risky:
//
//   REASSIGN / RETRY  — additive and recoverable. Work that was going nowhere
//                       moves to someone who can do it. Executed automatically.
//   PAUSE / CANCEL    — destroys work in flight and, for CANCEL, is not
//                       undoable. NEVER executed automatically, however
//                       confident the recommendation. Surfaced for a human.
//   ESCALATE_HUMAN    — is already a request for a person. Surfaced.
//
// That split is the whole design. An autonomous supervisor that can cancel
// your work while you are asleep is a worse failure mode than a workflow that
// stays stalled until morning with a message explaining why.
import type { Db } from "./db.js";
import { appendEvent } from "./db.js";
import {
  evaluateWorkflowHealth, executeSupervisorAction,
  type SupervisorRecommendation, type WorkflowHealthReport,
} from "./supervisor.js";

/** Actions this loop is allowed to take by itself. */
const AUTO_ACTIONS = new Set<SupervisorRecommendation["action"]>(["REASSIGN", "RETRY"]);

export interface SupervisorLoopDeps {
  db: Db;
  postChat?: (projectId: string, text: string) => void;
  log?: (msg: string) => void;
  broadcastView?: () => void;
}

export interface SupervisionOutcome {
  workflowId: string;
  health: WorkflowHealthReport["health"];
  applied: string[];
  surfaced: string[];
}

/**
 * Fires once per workflow per health state.
 *
 * Without this the loop would repeat the same "workflow is blocked" line every
 * tick for as long as it stayed blocked — which trains a person to ignore the
 * one channel that was supposed to tell them something was wrong. Keyed on the
 * health state, so a workflow that goes BLOCKED, recovers, and blocks again
 * does speak up the second time.
 */
function lastObservedHealth(db: Db, workflowId: string): string | null {
  const row = db
    .prepare(
      `SELECT json_extract(body, '$.health') AS h FROM events
        WHERE type = 'supervisor.observed' AND json_valid(body)
          AND json_extract(body, '$.workflowId') = ?
        ORDER BY seq DESC LIMIT 1`
    )
    .get(workflowId) as any;
  return row?.h ?? null;
}

function activeWorkflows(db: Db): Array<{ id: string; project_id: string; title: string }> {
  try {
    return db
      .prepare("SELECT id, project_id, title FROM workflows WHERE state = 'active'")
      .all() as any[];
  } catch {
    return [];
  }
}

const HEALTHY_STATES = new Set(["HEALTHY", "COMPLETED"]);

export function superviseOnce(deps: SupervisorLoopDeps): SupervisionOutcome[] {
  const { db, postChat, log, broadcastView } = deps;
  const outcomes: SupervisionOutcome[] = [];
  let changed = false;

  for (const wf of activeWorkflows(db)) {
    let report: WorkflowHealthReport | null = null;
    try {
      report = evaluateWorkflowHealth(db, wf.id);
    } catch {
      continue; // one bad workflow must not stop the sweep for the rest
    }
    if (!report) continue;
    const previous = lastObservedHealth(db, wf.id);

    if (HEALTHY_STATES.has(report.health)) {
      // Recovery is recorded, not announced. Recording it resets the dedup
      // key — without that, a workflow that breaks, recovers, and breaks the
      // same way again stays silent the second time, because the last thing
      // observed is still the old identical health state.
      if (previous && !HEALTHY_STATES.has(previous)) {
        appendEvent(db, report.projectId, null, "supervisor.observed", {
          workflowId: wf.id, health: report.health, issues: [], applied: [], surfaced: [],
        });
        log?.(`supervisor: ${wf.id} recovered (${previous} -> ${report.health})`);
      }
      continue;
    }
    if (previous === report.health) continue;

    const applied: string[] = [];
    const surfaced: string[] = [];

    for (const rec of report.recommendations) {
      if (AUTO_ACTIONS.has(rec.action)) {
        try {
          const result = executeSupervisorAction(db, wf.id, rec);
          if (result.ok) { applied.push(`${rec.action}: ${rec.reason}`); changed = true; }
          else surfaced.push(`${rec.action} could not be applied (${result.error}): ${rec.reason}`);
        } catch {
          surfaced.push(`${rec.action} failed: ${rec.reason}`);
        }
      } else {
        // PAUSE, CANCEL and ESCALATE_HUMAN are a person's call.
        surfaced.push(`${rec.action}: ${rec.reason}`);
      }
    }

    appendEvent(db, report.projectId, null, "supervisor.observed", {
      workflowId: wf.id,
      health: report.health,
      issues: report.issues.map((i) => i.code),
      applied,
      surfaced,
    });

    if (postChat) {
      const head = `Workflow "${wf.title}" is ${report.health}`;
      const detail = [
        ...applied.map((a) => `fixed — ${a}`),
        ...surfaced.map((s) => `needs you — ${s}`),
      ];
      // A bare state name tells a person nothing they can act on, so the line
      // always carries either what was done or what is being asked of them.
      postChat(
        report.projectId,
        detail.length ? `${head}. ${detail.join("; ")}.` : `${head}. ${report.issues.length} issue(s) open.`
      );
    }
    log?.(`supervisor: ${wf.id} ${report.health} — ${applied.length} applied, ${surfaced.length} surfaced`);

    outcomes.push({ workflowId: wf.id, health: report.health, applied, surfaced });
  }

  if (changed) broadcastView?.();
  return outcomes;
}
