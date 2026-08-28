// Safe Data Retention & Storage Cleanup Engine (Phase 6).
// Purges stale temporary records while strictly preserving active workflows, tasks, and referenced artifacts.

import type { Db } from "./db.js";
import { recordAuditLog } from "./audit.js";
import { logger } from "./logger.js";

export interface CleanupReport {
  purgedEventsCount: number;
  purgedEscalationsCount: number;
  purgedApprovalsCount: number;
  timestamp: string;
}

export function runRetentionCleanup(db: Db, daysToKeep: number = 30): CleanupReport {
  const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  let purgedEventsCount = 0;
  let purgedEscalationsCount = 0;
  let purgedApprovalsCount = 0;

  try {
    // 1. Purge old resolved escalations older than cutoff
    const escRes = db
      .prepare(
        "DELETE FROM escalations WHERE state IN ('resolved', 'dismissed') AND resolved_at < ?"
      )
      .run(cutoffDate);
    purgedEscalationsCount = escRes.changes;

    // 2. Purge old resolved approval requests older than cutoff
    const apprRes = db
      .prepare(
        "DELETE FROM approval_requests WHERE state IN ('approved', 'rejected', 'expired') AND resolved_at < ?"
      )
      .run(cutoffDate);
    purgedApprovalsCount = apprRes.changes;

    logger.info("Retention cleanup completed", {
      daysToKeep,
      cutoffDate,
      purgedEscalationsCount,
      purgedApprovalsCount,
    });
  } catch (err: any) {
    logger.error("Retention cleanup error", { error: err.message });
  }

  return {
    purgedEventsCount,
    purgedEscalationsCount,
    purgedApprovalsCount,
    timestamp: now,
  };
}
