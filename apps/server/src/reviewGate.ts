// Review as a state work passes through, not a job someone might do.
//
// `processReviewResult()` has always been a complete rework lifecycle: ACCEPT
// completes the task, REJECT opens a linked rework task and escalates after N
// attempts. What was missing is the only part that makes it matter — nothing
// ever REQUIRED a review. A task could be written, claimed done, and completed
// without a reviewer ever seeing it. The reviewer role existed; being reviewed
// did not.
//
// HOW IT FITS THE COMPLETION GATE. The gate already refuses a completion whose
// declared artifacts are absent (1.30) or whose acceptance checks fail (1.31).
// This is the third question, asked in the same place and answered the same
// way: refuse, say why, leave the task alone. No new task state — the task
// simply does not complete yet, exactly as with a missing artifact.
import type { Db } from "./db.js";
import { appendEvent, getTaskReviewVerdicts, createTask } from "./db.js";

/** How many review cycles before the gate stops blocking. */
export const MAX_REVIEW_CYCLES = 2;

export type ReviewGateOutcome =
  | { required: false }
  | { required: true; satisfied: true; verdictId: string }
  | { required: true; satisfied: false; reason: "awaiting_review"; reviewTaskId: string | null }
  | { required: true; satisfied: false; reason: "no_reviewer" }
  | { required: true; satisfied: false; reason: "exhausted" };

export function requiresReview(task: any): boolean {
  return Number(task?.requires_review ?? 0) === 1;
}

/** An agent that could review this — never the one that did the work. */
export function findReviewer(db: Db, task: any): { id: string; name: string } | null {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.role, a.role_id
         FROM agents a JOIN machines m ON m.id = a.machine_id
        WHERE a.project_id = ?
          AND COALESCE(a.paused, 0) = 0 AND COALESCE(a.retired, 0) = 0
          AND m.online = 1
          AND a.id IS NOT ?`
    )
    .all(task.project_id, task.agent_id ?? "") as any[];

  // Self-review is not review. Excluded above by id; the ordering below then
  // prefers a real reviewer over anyone merely available.
  const score = (a: any) =>
    (a.role_id ?? "").toLowerCase().includes("review") || (a.role_id ?? "").toLowerCase().includes("audit") ? 2
    : (a.role ?? "").toLowerCase() === "review" ? 1
    : 0;

  const best = rows.map((a) => ({ a, s: score(a) })).sort((x, y) => y.s - x.s || String(x.a.id).localeCompare(String(y.a.id)))[0];
  // A non-reviewer is NOT accepted as a fallback: "anyone who is free" reviewing
  // a diff is a rubber stamp, and a rubber stamp is worse than an honest gap
  // because it looks like assurance.
  return best && best.s > 0 ? { id: best.a.id, name: best.a.name } : null;
}

function reviewCycles(db: Db, taskId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.review_requested'")
    .get(taskId) as any;
  return Number(row?.n ?? 0);
}

/**
 * May this task complete, as far as review is concerned?
 *
 * Dispatches a review task the first time, and every time the work changes
 * after a rejection. Gives up after MAX_REVIEW_CYCLES for the same reason the
 * artifact gate does: a task nobody will ever accept must not block forever.
 */
export function checkReviewGate(db: Db, task: any): ReviewGateOutcome {
  if (!requiresReview(task)) return { required: false };

  const verdicts = getTaskReviewVerdicts(db, task.id);
  // The NEWEST verdict is the one that counts. An ACCEPT followed by more work
  // and a REJECT must not still read as accepted.
  const latest = verdicts[verdicts.length - 1];
  if (latest?.status === "ACCEPT") {
    return { required: true, satisfied: true, verdictId: latest.id };
  }

  if (reviewCycles(db, task.id) >= MAX_REVIEW_CYCLES) {
    appendEvent(db, task.project_id, task.id, "task.review_abandoned", {
      cycles: reviewCycles(db, task.id),
      agentId: task.agent_id ?? null,
    });
    return { required: true, satisfied: false, reason: "exhausted" };
  }

  const reviewer = findReviewer(db, task);
  if (!reviewer) {
    appendEvent(db, task.project_id, task.id, "task.review_unavailable", {
      agentId: task.agent_id ?? null,
    });
    return { required: true, satisfied: false, reason: "no_reviewer" };
  }

  // The review is itself a task, so it is scheduled, visible on the board and
  // subject to the same budget and lease machinery as any other work.
  const reviewTaskId = createTask(db, {
    projectId: task.project_id,
    title: `Review: ${task.title}`,
    spec:
      `Review the work done for task ${task.id} ("${task.title}").\n\n` +
      `Read what was produced and give a verdict. Do NOT rewrite the code yourself.\n` +
      `Finish with either ACCEPT, or REJECT plus the specific reasons and the file:line each refers to.`,
    creatorId: "review-gate",
    agentId: reviewer.id,
    parentTask: task.id,
    workflowId: task.workflow_id ?? null,
    expectedOutputs: ["review_verdict"],
  });

  appendEvent(db, task.project_id, task.id, "task.review_requested", {
    reviewTaskId,
    reviewerAgentId: reviewer.id,
    reviewerName: reviewer.name,
    cycle: reviewCycles(db, task.id),
  });

  return { required: true, satisfied: false, reason: "awaiting_review", reviewTaskId };
}

/** What the agent is told, phrased as the next action. */
export function reviewGateMessage(task: any, outcome: ReviewGateOutcome): string {
  if (outcome.required === false || outcome.satisfied) return "";
  if (outcome.reason === "no_reviewer") {
    return (
      `Your task "${task.title}" needs a review before it can be marked done, and no reviewer is ` +
      `available on this floor right now. Leave the work as it is and report what you finished — ` +
      `a human has been told.`
    );
  }
  return (
    `Your task "${task.title}" is waiting on a review before it can be marked done. ` +
    `Do not start it again. Report what you produced and stop; you will be woken if changes are asked for.`
  );
}
