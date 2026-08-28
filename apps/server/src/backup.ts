// Database Backup, Verification & Recovery Engine (Phase 6).
// Supports safe online SQLite backups and authoritative integrity verification.

import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "fs";
import type { Db } from "./db.js";
import { logger } from "./logger.js";

export interface BackupResult {
  ok: boolean;
  backupPath: string;
  timestamp: string;
  error?: string;
}

export interface VerificationResult {
  valid: boolean;
  integrity: string;
  tablesCount: number;
  error?: string;
}

/**
 * Creates an online SQLite database backup to the target file path.
 */
export async function createDatabaseBackup(db: Db, targetPath: string): Promise<BackupResult> {
  const now = new Date().toISOString();
  try {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
    }

    await db.backup(targetPath);
    logger.info("Database backup created successfully", { targetPath });
    return { ok: true, backupPath: targetPath, timestamp: now };
  } catch (err: any) {
    logger.error("Database backup failed", { error: err.message, targetPath });
    return { ok: false, backupPath: targetPath, timestamp: now, error: err.message };
  }
}

/**
 * Authoritatively verifies the structural integrity and table inventory of a database backup.
 */
export function verifyDatabaseBackup(backupPath: string): VerificationResult {
  if (!existsSync(backupPath)) {
    return { valid: false, integrity: "file_not_found", tablesCount: 0, error: "Backup file does not exist" };
  }

  try {
    const backupDb = new Database(backupPath, { readonly: true });
    const integrityRes = backupDb.prepare("PRAGMA integrity_check").get() as any;
    const integrity = integrityRes?.integrity_check ?? "unknown";

    const tables = backupDb
      .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table'")
      .get() as any;
    const tablesCount = tables?.count ?? 0;

    backupDb.close();
    const valid = integrity === "ok" && tablesCount >= 10;

    return {
      valid,
      integrity,
      tablesCount,
    };
  } catch (err: any) {
    return { valid: false, integrity: "error", tablesCount: 0, error: err.message };
  }
}
