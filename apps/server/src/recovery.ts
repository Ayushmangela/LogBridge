// Startup Recovery & Graceful Shutdown Engine (Phase 6).
// Automatically audits and reconciles interrupted in-flight state upon server restart.

import type { Db } from "./db.js";
import { appendEvent, getActiveTaskAttempt, finishTaskAttempt, setAgentStatus } from "./db.js";
import { recordAuditLog } from "./audit.js";
import { logger } from "./logger.js";

export interface RecoveryReport {
  recoveredTasksCount: number;
  reconciledAttemptsCount: number;
  /** Agents left mid-boot by an unclean restart; see recoverServerState. */
  releasedStartingCount: number;
  timestamp: string;
}

/**
 * Reconcile persisted state upon server startup to recover from unclean restarts or node drops.
 */
export function recoverServerState(db: Db): RecoveryReport {
  const now = new Date().toISOString();
  let recoveredTasksCount = 0;
  let reconciledAttemptsCount = 0;
  let releasedStartingCount = 0;

  try {
    // 1. Identify tasks stranded in 'working' or 'assigned' states
    const strandedTasks = db
      .prepare(
        `SELECT id, project_id, title, state, lease_expires, workflow_id, agent_id
         FROM tasks
         WHERE state IN ('working', 'assigned')`
      )
      .all() as any[];

    for (const t of strandedTasks) {
      // Find any running attempt for this task
      const activeAttempt = getActiveTaskAttempt(db, t.id);

      if (activeAttempt) {
        finishTaskAttempt(db, activeAttempt.id, {
          state: "timed_out",
          exitCode: 137,
          errorMessage: "Server restart / node interruption reconciliation",
        });
        reconciledAttemptsCount++;
      }

      // Back to `submitted`, not the `queued` this line used to write: no
      // dispatch path anywhere in the codebase reads a task in `queued` —
      // not reconcileOnConnect (only checks `submitted`), not orchestrate().
      // A task and its agent could survive every future restart parked here
      // forever, invisible in the UI, silently blocking every later chat
      // instruction to that agent (parseMention only dispatches to an idle
      // agent). `submitted` is a real, consumed state: sendTaskOffer picks
      // it straight back up, same as any other pending task.
      db.prepare(
        "UPDATE tasks SET state = 'submitted', lease_expires = NULL WHERE id = ?"
      ).run(t.id);
      // The task's own state was reconciled above, but the agent's status
      // was never touched — it stayed `working`/`current_task` pointing at
      // a task that no longer is. An agent in that state is invisible to
      // every human-facing dispatch path (parseMention, the approve button)
      // even though nothing is actually running.
      if (t.agent_id) setAgentStatus(db, t.agent_id, "idle", null);
      recoveredTasksCount++;

      appendEvent(db, t.project_id, t.id, "task.recovered", {
        taskId: t.id,
        previousState: t.state,
        recoveredAt: now,
      });

      recordAuditLog(db, {
        projectId: t.project_id,
        actorType: "system",
        actorId: "recovery_engine",
        action: "task.recovered",
        resourceType: "task",
        resourceId: t.id,
        metadata: { previousState: t.state, recoveredAt: now },
      });
    }

    // 3. Release agents stranded in "starting".
    //
    // The status is persisted in the database, but the thing that clears it —
    // the CLI's readiness signal, and its timeout — lives in the PTY session,
    // which dies with the process. So a restart mid-boot would leave an agent
    // claiming to be starting up forever, with nothing left alive to ever
    // contradict it. A booting agent cannot survive a restart by definition:
    // its PTY was a child of this process. Anything still "starting" here is
    // therefore stale, not in progress.
    const strandedStarting = db
      .prepare("UPDATE agents SET status = 'idle' WHERE status = 'starting'")
      .run();
    releasedStartingCount = strandedStarting.changes ?? 0;

    logger.info("Startup state recovery completed", {
      recoveredTasksCount,
      reconciledAttemptsCount,
      releasedStartingCount,
    });
  } catch (err: any) {
    logger.error("Error during startup recovery", { error: err.message });
  }

  return {
    recoveredTasksCount,
    reconciledAttemptsCount,
    releasedStartingCount,
    timestamp: now,
  };
}
