// Startup Recovery & Graceful Shutdown Engine (Phase 6).
// Automatically audits and reconciles interrupted in-flight state upon server restart.

import type { Db } from "./db.js";
import { appendEvent, getActiveTaskAttempt, finishTaskAttempt } from "./db.js";
import { recordAuditLog } from "./audit.js";
import { logger } from "./logger.js";

export interface RecoveryReport {
  recoveredTasksCount: number;
  reconciledAttemptsCount: number;
  timestamp: string;
}

/**
 * Reconcile persisted state upon server startup to recover from unclean restarts or node drops.
 */
export function recoverServerState(db: Db): RecoveryReport {
  const now = new Date().toISOString();
  let recoveredTasksCount = 0;
  let reconciledAttemptsCount = 0;

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

      // Requeue the task safely so orchestrator can re-evaluate or route it
      db.prepare(
        "UPDATE tasks SET state = 'queued', lease_expires = NULL WHERE id = ?"
      ).run(t.id);
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

    logger.info("Startup state recovery completed", {
      recoveredTasksCount,
      reconciledAttemptsCount,
    });
  } catch (err: any) {
    logger.error("Error during startup recovery", { error: err.message });
  }

  return {
    recoveredTasksCount,
    reconciledAttemptsCount,
    timestamp: now,
  };
}
