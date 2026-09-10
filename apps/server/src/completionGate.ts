// The decision: may this task be marked done?
//
// Split from verification.ts so the CHECK stays pure and testable while the
// consequences — sending the agent back, recording, escalating — live in one
// place that both completion paths share. There are two of those paths
// (a runner's `task.result` and the local PTY's `completeLocalTask`) and they
// had already drifted apart once; a gate implemented twice would drift again.
import type { Db } from "./db.js";
import { appendEvent, setAgentStatus } from "./db.js";
import {
  verifyTask, rejectionMessage, rejectionCount, MAX_REJECTIONS,
} from "./verification.js";
import { submitPromptToAgent } from "./ptyGateway.js";
import { runAcceptanceChecks, failureSummary, type CheckRun } from "./checks.js";

export interface GateVerdict {
  allow: boolean;
  /** Present when the task completed WITHOUT its evidence, because the
   *  send-back limit was reached. Callers do not need to act on it; it exists
   *  so the reason is not lost. */
  unverified?: boolean;
  missing?: string[];
}

export interface GateHooks {
  /** Defaults to the real PTY injector. Tests pass their own. */
  inject?: (agentId: string, text: string) => boolean;
  postChat?: (projectId: string, text: string) => void;
  log?: (msg: string) => void;
}

/** Set by the server at startup so the gate can talk to the office without
 *  every call site having to thread the plumbing through. */
let hooks: GateHooks = {};
export function configureCompletionGate(h: GateHooks): void {
  hooks = h;
}

/** Test seam. */
export function resetCompletionGate(): void {
  hooks = {};
}

/**
 * Allow or refuse a completion.
 *
 * Refusing LEAVES THE TASK AS IT WAS rather than failing it. The work is
 * usually nearly right — an agent that wrote the code but did not declare it
 * has not failed, it has skipped the last step — and failing the task would
 * throw away a run that cost real money to produce.
 *
 * `projectFolder` comes from the agent's own folder, which is where a relative
 * artifact path is meaningful.
 */
export async function gateCompletion(db: Db, task: any): Promise<GateVerdict> {
  const agent = task.agent_id
    ? (db.prepare("SELECT id, name, folder FROM agents WHERE id = ?").get(task.agent_id) as any)
    : null;

  const result = verifyTask(db, task, agent?.folder ?? null);

  // Artifacts prove an output EXISTS. A check proves it WORKS — an exit code
  // is evidence, where another model opinion would just be another claim.
  const runs = result.ok ? await runAcceptanceChecks(db, task, agent?.folder ?? null) : [];
  const failedChecks = runs.filter((r) => !r.passed);

  if (runs.length) {
    appendEvent(db, task.project_id, task.id, "task.checks_run", {
      agentId: task.agent_id ?? null,
      results: runs.map((r) => ({ name: r.name, passed: r.passed, exitCode: r.exitCode, skipped: r.skipped })),
    });
  }

  if (result.ok && failedChecks.length === 0) return { allow: true };

  // Past the limit the gate stops blocking. A task whose artifact the plan
  // asked for wrongly, or whose work is genuinely impossible, must not be
  // send-backed forever — that is a deadlock wearing a safety jacket.
  if (rejectionCount(db, task.id) >= MAX_REJECTIONS) {
    appendEvent(db, task.project_id, task.id, "task.completed_unverified", {
      missing: result.missing,
      vanished: result.vanished,
      failedChecks: failedChecks.map((r) => r.name),
      agentId: task.agent_id ?? null,
    });
    hooks.postChat?.(
      task.project_id,
      `"${task.title}" was marked done WITHOUT its expected output${result.missing.length === 1 ? "" : "s"}` +
        (result.missing.length ? ` (${result.missing.join(", ")})` : "") +
        `. Worth a look.`
    );
    hooks.log?.(`completion gate: ${task.id} allowed through unverified`);
    return { allow: true, unverified: true, missing: result.missing };
  }

  appendEvent(db, task.project_id, task.id, "task.verification_failed", {
    missing: result.missing,
    vanished: result.vanished,
    failedChecks: failedChecks.map((r) => ({ name: r.name, exitCode: r.exitCode, skipped: r.skipped })),
    agentId: task.agent_id ?? null,
  });

  const inject = hooks.inject ?? submitPromptToAgent;
  const reason = failedChecks.length
    ? `Your task "${task.title}" is not done yet — its acceptance checks did not pass:\n\n` +
      `${failureSummary(runs)}\n\n` +
      `Fix what the output shows and finish. If the check itself is wrong, say so rather than reporting done.`
    : rejectionMessage(task, result);
  const told = task.agent_id ? inject(task.agent_id, reason) : false;

  // The agent is working again, not idle — it was never actually finished.
  if (task.agent_id) {
    try { setAgentStatus(db, task.agent_id, told ? "working" : "needs_input", task.id); } catch {}
  }

  hooks.postChat?.(
    task.project_id,
    told
      ? `Sent "${task.title}" back to ${agent?.name ?? "the agent"} — ${describe(result, failedChecks)}.`
      : `"${task.title}" reported done but ${describe(result, failedChecks)}, and there is no live terminal to send it back to.`
  );
  hooks.log?.(`completion gate: ${task.id} rejected — ${describe(result, failedChecks)}`);

  return { allow: false, missing: result.missing };
}

function describe(
  r: { missing: string[]; vanished: string[] },
  failedChecks: CheckRun[] = []
): string {
  const bits: string[] = [];
  if (r.missing.length) bits.push(`no ${r.missing.join(", no ")} on record`);
  if (r.vanished.length) bits.push(`missing file${r.vanished.length === 1 ? "" : "s"}: ${r.vanished.join("; ")}`);
  for (const c of failedChecks) {
    bits.push(c.skipped ? `${c.name}: ${c.skipped}` : `${c.name} failed`);
  }
  return bits.join(" and ");
}
