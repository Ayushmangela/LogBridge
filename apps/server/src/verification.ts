// "Done" has to mean something.
//
// THE PROBLEM. A task became `completed` on the agent's word alone. For a
// local agent that word was not even words: `watchForCompletion` marks a task
// done after **8 seconds of terminal silence** (ptyGateway.ts). An agent that
// pauses to think for nine seconds is "finished". Nothing looked at what it
// produced, because nothing recorded what it produced.
//
// And completion CASCADES — `getTaskDependents` unblocks the next wave and
// offers it out. So one falsely-completed task starts the next agent on
// inputs that do not exist, which is how a plan of five steps produces five
// confident reports and no code.
//
// WHAT THIS DOES. Three mechanisms already existed and none of them were
// connected to anything:
//
//   * the planner emitted `expectedOutputs` per step — interpolated into the
//     spec TEXT and never stored, so nothing could read it back;
//   * the `artifacts` table has existed with `kind` and `file_path` and was
//     written by exactly nobody;
//   * PROTOCOL.md has always told agents to declare what they produced —
//     `"artifacts": { "diff": "path/to/patch" }` — and nothing read it.
//
// Together they make a real gate: a task that declared outputs cannot be
// marked done until an artifact of each kind is on record, and where an
// artifact names a file, that file has to exist on disk.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Db } from "./db.js";
import { getTaskArtifacts } from "./db.js";

export interface VerificationResult {
  /** False only when the task declared outputs and some are missing. */
  ok: boolean;
  /** Declared kinds with no artifact recorded. */
  missing: string[];
  /** Artifacts that named a file which is not on disk: "kind -> path". */
  vanished: string[];
  /** True when the task declared nothing, so there was nothing to check. */
  unchecked: boolean;
}

/** The declared outputs of a task, or [] when it declared none. */
export function expectedOutputsOf(task: any): string[] {
  const raw = task?.expected_outputs;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Does this task's evidence match what it promised?
 *
 * `projectFolder` is where a relative artifact path is resolved from. When it
 * is unknown, a relative path is accepted on trust rather than failed —
 * refusing to complete a task because the SERVER could not find the folder
 * would punish the agent for the server's ignorance.
 */
export function verifyTask(db: Db, task: any, projectFolder?: string | null): VerificationResult {
  const expected = expectedOutputsOf(task);
  if (expected.length === 0) {
    return { ok: true, missing: [], vanished: [], unchecked: true };
  }

  const artifacts = getTaskArtifacts(db, task.id);
  const kinds = new Set(artifacts.map((a) => String(a.kind ?? "").toLowerCase()));
  const missing = expected.filter((k) => !kinds.has(k.toLowerCase()));

  const vanished: string[] = [];
  for (const a of artifacts) {
    const p = a.file_path;
    if (!p) continue;                       // a claim with no file to check
    const abs = isAbsolute(p) ? p : projectFolder ? join(projectFolder, p) : null;
    if (abs && !existsSync(abs)) vanished.push(`${a.kind} -> ${p}`);
  }

  return { ok: missing.length === 0 && vanished.length === 0, missing, vanished, unchecked: false };
}

/** What the agent is told when its work does not match what it promised.
 *  Specific, and phrased as the next action — "incomplete" on its own costs a
 *  turn producing an apology. */
export function rejectionMessage(task: any, result: VerificationResult): string {
  const parts: string[] = [];
  if (result.missing.length) {
    parts.push(`you have not recorded: ${result.missing.join(", ")}`);
  }
  if (result.vanished.length) {
    parts.push(`these files do not exist: ${result.vanished.join("; ")}`);
  }
  return (
    `Your task "${task.title}" is not done yet — ${parts.join(", and ")}. ` +
    `Finish the work, then declare what you produced by including an "artifacts" ` +
    `object in your outbox message, e.g. {"artifacts": {"diff": "src/auth.ts"}}. ` +
    `If the work genuinely cannot be completed, say so and explain why instead of reporting done.`
  );
}

/**
 * How many times this task's completion has already been rejected.
 *
 * A gate with no ceiling is a deadlock: an agent that cannot produce the
 * artifact — because the plan asked for the wrong thing, or the work is
 * genuinely impossible — would be sent back forever. After the limit the
 * completion is allowed through, recorded as UNVERIFIED so nobody mistakes it
 * for checked work, and surfaced for a human.
 */
export function rejectionCount(db: Db, taskId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.verification_failed'")
    .get(taskId) as any;
  return Number(row?.n ?? 0);
}

/** One send-back, then it stops blocking. */
export const MAX_REJECTIONS = 1;
