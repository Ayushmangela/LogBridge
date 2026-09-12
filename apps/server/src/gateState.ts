// What the completion gate would say about a task — without running anything.
//
// The gate itself (completionGate.ts) is a DECISION: it runs shell commands,
// injects prompts, dispatches reviews. It is called once, when an agent claims
// to be finished.
//
// The office needs a different thing: the *standing* of a task, recomputed on
// every view build, several times a second, for every viewer. So this module
// is strictly read-only — no shell, no injection, no writes — and it reports
// only what the gate has ALREADY said, never what it would say if asked now.
//
// That distinction is the whole design. A task that has not yet reported done
// is not "blocked on artifacts"; it is simply working, and saying otherwise
// would paint half the board red. `blockedOn` is set only where a gate event
// exists to prove the gate actually held the task.
//
// COST. The board ships up to 100 tasks and rebuilds per viewer, so a
// per-task query would be 300 extra statements per build. Everything here is
// batched per PROJECT — three statements total, regardless of task count.
import type { Db } from "./db.js";
import { expectedOutputsOf } from "./verification.js";

export type CheckStatus = "passed" | "failed" | "skipped";
export type ReviewStatus =
  // Declared as needing review, but no reviewer has been dispatched yet —
  // the work is still being done. NOT blocking.
  | "required"
  // A reviewer has been dispatched and has not answered. Blocking.
  | "pending"
  | "accepted" | "rejected" | "unavailable" | "abandoned";

export interface TaskGate {
  /** Declared outputs and whether an artifact of that kind is on record. */
  outputs: { kind: string; present: boolean }[];
  /** Named checks this task must pass, with the last known result. A check
   *  with no run yet has `status: null` — deliberately not "passed".
   *  `note` carries the reason a check did not run. */
  checks: { name: string; status: CheckStatus | null; note: string | null }[];
  /** null when the task does not require review. */
  review: { status: ReviewStatus; reviewer: string | null } | null;
  /** Which gate is actually holding this task right now — only ever set when
   *  a gate event proves it. */
  blockedOn: "artifacts" | "checks" | "review" | null;
  /** Completed anyway, after the send-back limit was reached. */
  unverified: boolean;
}

/** A task declared nothing and no gate has spoken — the common case. */
const NO_GATE: TaskGate = {
  outputs: [], checks: [], review: null, blockedOn: null, unverified: false,
};

export function isEmptyGate(g: TaskGate): boolean {
  return g.outputs.length === 0 && g.checks.length === 0 && g.review === null && !g.unverified;
}

function parseList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * How far back to look for gate events.
 *
 * `events` has no index on `type`, so this is a scan of the project's most
 * recent rows. The board shows 100 tasks; 800 events comfortably covers the
 * gate activity for those without reading a long-lived project's whole
 * history on every view build.
 */
const EVENT_WINDOW = 800;

const GATE_EVENTS = [
  "task.checks_run",
  "task.verification_failed",
  "task.completed_unverified",
  "task.review_requested",
  "task.review_unavailable",
  "task.review_abandoned",
];

/**
 * Gate standing for every task in a project, keyed by task id.
 *
 * Tasks with nothing to report are omitted rather than mapped to an empty
 * gate, so the caller can leave the field off the wire entirely — the board is
 * a full snapshot on every tick, and most tasks have no gate to describe.
 */
export function gateStatesForProject(db: Db, projectId: string, tasks: any[]): Map<string, TaskGate> {
  const out = new Map<string, TaskGate>();
  if (!tasks.length) return out;

  const relevant = tasks.filter(
    (t) => expectedOutputsOf(t).length || parseList(t.acceptance_checks).length || Number(t.requires_review ?? 0) === 1
  );
  if (!relevant.length) return out;

  // ---- one statement each, for the whole project --------------------------

  const kindsByTask = new Map<string, Set<string>>();
  for (const r of db
    .prepare("SELECT task_id, kind FROM artifacts WHERE project_id = ? AND task_id IS NOT NULL")
    .all(projectId) as any[]) {
    const set = kindsByTask.get(r.task_id) ?? new Set<string>();
    set.add(String(r.kind ?? "").toLowerCase());
    kindsByTask.set(r.task_id, set);
  }

  // Ascending, so the last write per task is the NEWEST verdict — the same
  // rule checkReviewGate() applies. An ACCEPT followed by rework and a REJECT
  // must not still read as accepted. `rowid` breaks the tie: two verdicts
  // written in the same millisecond are otherwise ordered arbitrarily, and
  // "arbitrarily" here means the board sometimes shows the wrong verdict.
  const verdictByTask = new Map<string, { status: string; reviewer: string | null }>();
  for (const r of db
    .prepare(
      `SELECT v.task_id, v.status, a.name AS reviewer
         FROM review_verdicts v LEFT JOIN agents a ON a.id = v.reviewer_agent_id
        WHERE v.project_id = ? ORDER BY v.created_at ASC, v.rowid ASC`
    )
    .all(projectId) as any[]) {
    verdictByTask.set(r.task_id, { status: String(r.status ?? ""), reviewer: r.reviewer ?? null });
  }

  // Descending + first-wins = the latest event of each type per task.
  const latestEvent = new Map<string, any>();
  for (const r of db
    .prepare(
      `SELECT task_id, type, body FROM events
        WHERE project_id = ? AND task_id IS NOT NULL
        ORDER BY seq DESC LIMIT ?`
    )
    .all(projectId, EVENT_WINDOW) as any[]) {
    if (!GATE_EVENTS.includes(r.type)) continue;
    const key = `${r.task_id}|${r.type}`;
    if (!latestEvent.has(key)) {
      let body: any = null;
      try { body = r.body ? JSON.parse(r.body) : null; } catch { body = null; }
      latestEvent.set(key, body ?? {});
    }
  }

  // ---- assemble ----------------------------------------------------------

  for (const t of relevant) {
    const declared = expectedOutputsOf(t);
    const have = kindsByTask.get(t.id) ?? new Set<string>();
    const outputs = declared.map((kind) => ({ kind, present: have.has(kind.toLowerCase()) }));

    const checkRun = latestEvent.get(`${t.id}|task.checks_run`);
    const resultByName = new Map<string, { status: CheckStatus; note: string | null }>();
    for (const r of (checkRun?.results ?? []) as any[]) {
      if (!r?.name) continue;
      // `skipped` covers two cases that runAcceptanceChecks() treats
      // DIFFERENTLY, and collapsing them here would misreport the board:
      //
      //   * a remote workspace is skipped with passed:true — an honest gap,
      //     not held against the task;
      //   * a check name nobody defined is skipped with passed:false, and the
      //     gate genuinely refuses the completion for it.
      //
      // So `passed` decides the status and the reason rides along as a note.
      const note = typeof r.skipped === "string" ? r.skipped : null;
      const status: CheckStatus = note && r.passed ? "skipped" : r.passed ? "passed" : "failed";
      resultByName.set(String(r.name), { status, note });
    }
    const checks = parseList(t.acceptance_checks).map((name) => {
      const seen = resultByName.get(name);
      return { name, status: seen?.status ?? null, note: seen?.note ?? null };
    });

    let review: TaskGate["review"] = null;
    if (Number(t.requires_review ?? 0) === 1) {
      const verdict = verdictByTask.get(t.id);
      const requested = latestEvent.get(`${t.id}|task.review_requested`);
      if (verdict?.status === "ACCEPT") {
        review = { status: "accepted", reviewer: verdict.reviewer };
      } else if (latestEvent.has(`${t.id}|task.review_abandoned`)) {
        review = { status: "abandoned", reviewer: verdict?.reviewer ?? null };
      } else if (verdict?.status === "REJECT") {
        review = { status: "rejected", reviewer: verdict.reviewer };
      } else if (latestEvent.has(`${t.id}|task.review_unavailable`)) {
        review = { status: "unavailable", reviewer: null };
      } else if (requested) {
        review = { status: "pending", reviewer: requested.reviewerName ?? null };
      } else {
        // Declared, not yet dispatched. A task created a second ago that
        // merely REQUIRES review is not "in review" — the agent has not
        // finished, so no reviewer has been asked. Saying otherwise puts every
        // new task straight into a blocked-looking state.
        review = { status: "required", reviewer: null };
      }
    }

    // Only a gate that has SPOKEN blocks. A task still being worked on has
    // produced nothing yet, and that is not a failure — see the note at the
    // top of this file.
    const settled = ["completed", "failed", "canceled", "rejected"].includes(String(t.state));
    let blockedOn: TaskGate["blockedOn"] = null;
    if (!settled) {
      if (latestEvent.has(`${t.id}|task.verification_failed`) && outputs.some((o) => !o.present)) {
        blockedOn = "artifacts";
      } else if (checks.some((c) => c.status === "failed")) {
        blockedOn = "checks";
      } else if (review && (review.status === "pending" || review.status === "rejected" || review.status === "unavailable")) {
        // "required" is deliberately absent: the gate has not asked anyone
        // yet, so nothing is being held.
        blockedOn = "review";
      }
    }

    const gate: TaskGate = {
      outputs,
      checks,
      review,
      blockedOn,
      unverified: latestEvent.has(`${t.id}|task.completed_unverified`),
    };
    if (!isEmptyGate(gate)) out.set(t.id, gate);
  }

  return out;
}

export { NO_GATE };
