// System Health, Liveness & Readiness Probes (Phase 6).
// Provides lightweight liveness and comprehensive readiness diagnostics for production environments.

import type { Db } from "./db.js";

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    database: { status: "up" | "down"; latencyMs: number };
    schema: { status: "up" | "down"; tablesCount: number };
    memory: { rssMb: number; heapUsedMb: number };
  };
}

export function checkLiveness(): { status: "ok"; timestamp: string; uptimeSeconds: number } {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function checkReadiness(db: Db): HealthReport {
  const start = performance.now();
  let dbStatus: "up" | "down" = "up";
  let latencyMs = 0;
  let tablesCount = 0;

  try {
    const res = db.prepare("SELECT 1 AS ok").get() as any;
    if (res?.ok !== 1) dbStatus = "down";
    latencyMs = Math.round((performance.now() - start) * 100) / 100;

    const tables = db
      .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table'")
      .get() as any;
    tablesCount = tables?.count ?? 0;
  } catch {
    dbStatus = "down";
  }

  const mem = process.memoryUsage();
  const isHealthy = dbStatus === "up" && tablesCount >= 10;

  return {
    status: isHealthy ? "healthy" : "unhealthy",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      database: { status: dbStatus, latencyMs },
      schema: { status: tablesCount >= 10 ? "up" : "down", tablesCount },
      memory: {
        rssMb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
        heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
      },
    },
  };
}
