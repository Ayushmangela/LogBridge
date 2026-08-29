import { describe, expect, test } from "vitest";
import {
  openDb,
  createTask,
  setTaskState,
  createTaskAttempt,
  getTask,
  type Db,
} from "./db.js";
import { checkLiveness, checkReadiness } from "./health.js";
import { recoverServerState } from "./recovery.js";
import { moveToDeadLetter, getProjectDeadLetters, reprocessDeadLetter } from "./deadLetter.js";
import { checkDispatchConcurrency } from "./concurrency.js";
import { rateLimiter } from "./rateLimit.js";
import { getSystemMetrics, formatPrometheusMetrics } from "./metrics.js";
import { runRetentionCleanup } from "./retention.js";
import { verifyDatabaseBackup } from "./backup.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_prod") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_${id}`, `u_${id}`, "Commander", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run(`m_${id}`, `usr_${id}`, "Worker 1", new Date().toISOString(), 1);
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_worker_${id}`, `m_${id}`, `usr_${id}`, id, "Worker Agent", "developer", "idle", JSON.stringify(["backend"]), 1
  );
}

describe("System Health & Probes", () => {
  test("reports liveness and readiness status with component telemetry", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_health");

    const live = checkLiveness();
    expect(live.status).toBe("ok");
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const ready = checkReadiness(db);
    expect(ready.status).toBe("healthy");
    expect(ready.checks.database.status).toBe("up");
    expect(ready.checks.schema.status).toBe("up");
    expect(ready.checks.schema.tablesCount).toBeGreaterThanOrEqual(10);

    db.close();
  });
});

describe("Startup Recovery Engine", () => {
  test("safely reconciles interrupted tasks and active attempts upon restart", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_rec");

    const taskId = createTask(db, {
      projectId: "prj_rec",
      title: "Interrupted Task",
      creatorId: "usr_prj_rec",
    });

    setTaskState(db, taskId, "working");
    createTaskAttempt(db, {
      taskId,
      agentId: "agt_worker_prj_rec",
    });

    // Run recovery
    const report = recoverServerState(db);
    expect(report.recoveredTasksCount).toBe(1);
    expect(report.reconciledAttemptsCount).toBe(1);

    // Reset to `submitted`, not `queued` — `queued` is a dead end nothing
    // in the codebase reads (reconcileOnConnect only looks for `submitted`;
    // nothing calls orchestrate() on a bare startup), so a task landed
    // there stayed there forever, invisible, across every future restart.
    const updatedTask = getTask(db, taskId);
    expect(updatedTask?.state).toBe("submitted");

    db.close();
  });
});

describe("Dead Letter Queue Engine", () => {
  test("moves unrecoverable task to DLQ, preserves diagnosis, and supports reprocessing", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_dlq");

    const taskId = createTask(db, {
      projectId: "prj_dlq",
      title: "Unrecoverable DB Migration",
      creatorId: "usr_prj_dlq",
    });

    const dlqId = moveToDeadLetter(db, {
      projectId: "prj_dlq",
      taskId,
      failureCategory: "MACHINE_OFFLINE",
      lastError: "Target machine failed to respond after 3 retries",
      recommendedAction: "RETRY",
    });

    expect(dlqId).toMatch(/^dlq_/);
    const records = getProjectDeadLetters(db, "prj_dlq", "pending");
    expect(records.length).toBe(1);
    expect(records[0].failureCategory).toBe("MACHINE_OFFLINE");

    // Reprocess DLQ task via retry
    const res = reprocessDeadLetter(db, dlqId, "RETRY", "usr_prj_dlq", "Manual re-dispatch");
    expect(res.ok).toBe(true);
    expect(res.retriedTaskId).toMatch(/^tsk_/);

    const updatedRecords = getProjectDeadLetters(db, "prj_dlq", "reprocessed");
    expect(updatedRecords.length).toBe(1);

    db.close();
  });
});

describe("Concurrency Controls & Backpressure", () => {
  test("enforces agent-level and project-level concurrency limits", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_conc");

    // Agent has concurrency 1
    const t1 = createTask(db, { projectId: "prj_conc", title: "Task 1", creatorId: "usr_prj_conc" });
    setTaskState(db, t1, "working", { agent_id: "agt_worker_prj_conc" });

    // Check concurrency for this agent
    const check1 = checkDispatchConcurrency(db, "prj_conc", "agt_worker_prj_conc");
    expect(check1.allowed).toBe(false);
    expect(check1.reason).toContain("Agent concurrency limit reached");

    // Check concurrency for another hypothetical idle agent
    const check2 = checkDispatchConcurrency(db, "prj_conc");
    expect(check2.allowed).toBe(true);

    db.close();
  });
});

describe("API Rate Limiting", () => {
  test("allows requests within threshold and throttles when exhausted", () => {
    rateLimiter.reset("test_key");

    const res1 = rateLimiter.check("test_key", 2, 60000);
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(1);

    const res2 = rateLimiter.check("test_key", 2, 60000);
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(0);

    // 3rd attempt exceeds limit
    const res3 = rateLimiter.check("test_key", 2, 60000);
    expect(res3.allowed).toBe(false);
    expect(res3.remaining).toBe(0);
    expect(res3.resetMs).toBeGreaterThan(0);
  });
});

describe("Operational Metrics & Prometheus Telemetry", () => {
  test("gathers system operational metrics and formats Prometheus plain text", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_metrics");

    const metrics = getSystemMetrics(db);
    expect(metrics.memory.rssMb).toBeGreaterThan(0);
    expect(metrics.agents.total).toBe(1);

    const prom = formatPrometheusMetrics(metrics);
    expect(prom).toContain("logbridge_uptime_seconds");
    expect(prom).toContain("logbridge_tasks_total");
    expect(prom).toContain("logbridge_memory_rss_bytes");

    db.close();
  });
});

describe("Data Retention & Backup Verification", () => {
  test("runs retention cleanup safely", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_ret");

    const cleanup = runRetentionCleanup(db, 30);
    expect(cleanup.timestamp).toBeDefined();

    db.close();
  });

  test("verifies non-existent backup handles gracefully", () => {
    const res = verifyDatabaseBackup("./non_existent_file.db");
    expect(res.valid).toBe(false);
    expect(res.integrity).toBe("file_not_found");
  });
});

describe("Phase 6 REST API Endpoints", () => {
  test("verifies health, metrics, and DLQ REST endpoints", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_api_prod");

    // 1. GET /health
    const healthRes = await server.app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().status).toBe("healthy");

    // 2. GET /health/live
    const liveRes = await server.app.inject({ method: "GET", url: "/health/live" });
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.json().status).toBe("ok");

    // 3. GET /metrics
    const metricsRes = await server.app.inject({ method: "GET", url: "/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body).toContain("logbridge_uptime_seconds");

    // 4. GET /api/system/metrics
    const sysMetricsRes = await server.app.inject({ method: "GET", url: "/api/system/metrics" });
    expect(sysMetricsRes.statusCode).toBe(200);
    expect(sysMetricsRes.json().ok).toBe(true);

    // 5. GET /api/projects/:id/dead-letter
    const dlqRes = await server.app.inject({ method: "GET", url: "/api/projects/prj_api_prod/dead-letter" });
    expect(dlqRes.statusCode).toBe(200);
    expect(dlqRes.json().deadLetters).toBeDefined();

    // 6. POST /api/system/cleanup
    const cleanRes = await server.app.inject({
      method: "POST",
      url: "/api/system/cleanup",
      payload: { daysToKeep: 30 },
    });
    expect(cleanRes.statusCode).toBe(200);
    expect(cleanRes.json().ok).toBe(true);

    await server.app.close();
  });
});
