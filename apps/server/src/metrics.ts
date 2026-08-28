// Production Operational Metrics & Prometheus Telemetry (Phase 6).
// Exposes structured operational counters and metrics for observability.

import type { Db } from "./db.js";

export interface SystemMetrics {
  timestamp: string;
  uptimeSeconds: number;
  memory: {
    rssMb: number;
    heapTotalMb: number;
    heapUsedMb: number;
  };
  tasks: {
    total: number;
    queued: number;
    working: number;
    completed: number;
    failed: number;
    deadLettered: number;
  };
  agents: {
    total: number;
    idle: number;
    working: number;
    waiting: number;
  };
  workflows: {
    total: number;
    active: number;
    completed: number;
    paused: number;
  };
  goals: {
    total: number;
    executing: number;
    completed: number;
    awaitingApproval: number;
  };
}

export function getSystemMetrics(db: Db): SystemMetrics {
  const mem = process.memoryUsage();

  const taskStats = db
    .prepare(
      `SELECT
        count(*) as total,
        sum(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) as queued,
        sum(CASE WHEN state = 'working' THEN 1 ELSE 0 END) as working,
        sum(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) as completed,
        sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) as failed
       FROM tasks`
    )
    .get() as any;

  const dlqCount = (db.prepare("SELECT count(*) as count FROM dead_letter_tasks").get() as any)?.count ?? 0;

  const agentStats = db
    .prepare(
      `SELECT
        count(*) as total,
        sum(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) as idle,
        sum(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as working,
        sum(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting
       FROM agents`
    )
    .get() as any;

  const wfStats = db
    .prepare(
      `SELECT
        count(*) as total,
        sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END) as active,
        sum(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) as completed,
        sum(CASE WHEN state = 'paused' THEN 1 ELSE 0 END) as paused
       FROM workflows`
    )
    .get() as any;

  const goalStats = db
    .prepare(
      `SELECT
        count(*) as total,
        sum(CASE WHEN state = 'executing' THEN 1 ELSE 0 END) as executing,
        sum(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) as completed,
        sum(CASE WHEN state = 'awaiting_approval' THEN 1 ELSE 0 END) as awaitingApproval
       FROM goals`
    )
    .get() as any;

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 100) / 100,
      heapTotalMb: Math.round((mem.heapTotal / (1024 * 1024)) * 100) / 100,
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
    },
    tasks: {
      total: taskStats?.total ?? 0,
      queued: taskStats?.queued ?? 0,
      working: taskStats?.working ?? 0,
      completed: taskStats?.completed ?? 0,
      failed: taskStats?.failed ?? 0,
      deadLettered: dlqCount,
    },
    agents: {
      total: agentStats?.total ?? 0,
      idle: agentStats?.idle ?? 0,
      working: agentStats?.working ?? 0,
      waiting: agentStats?.waiting ?? 0,
    },
    workflows: {
      total: wfStats?.total ?? 0,
      active: wfStats?.active ?? 0,
      completed: wfStats?.completed ?? 0,
      paused: wfStats?.paused ?? 0,
    },
    goals: {
      total: goalStats?.total ?? 0,
      executing: goalStats?.executing ?? 0,
      completed: goalStats?.completed ?? 0,
      awaitingApproval: goalStats?.awaitingApproval ?? 0,
    },
  };
}

export function formatPrometheusMetrics(metrics: SystemMetrics): string {
  return [
    `# HELP logbridge_uptime_seconds Process uptime in seconds`,
    `# TYPE logbridge_uptime_seconds gauge`,
    `logbridge_uptime_seconds ${metrics.uptimeSeconds}`,
    `# HELP logbridge_tasks_total Total tasks by state`,
    `# TYPE logbridge_tasks_total gauge`,
    `logbridge_tasks_total{state="queued"} ${metrics.tasks.queued}`,
    `logbridge_tasks_total{state="working"} ${metrics.tasks.working}`,
    `logbridge_tasks_total{state="completed"} ${metrics.tasks.completed}`,
    `logbridge_tasks_total{state="failed"} ${metrics.tasks.failed}`,
    `logbridge_tasks_total{state="dead_letter"} ${metrics.tasks.deadLettered}`,
    `# HELP logbridge_agents_total Total agents by status`,
    `# TYPE logbridge_agents_total gauge`,
    `logbridge_agents_total{status="idle"} ${metrics.agents.idle}`,
    `logbridge_agents_total{status="working"} ${metrics.agents.working}`,
    `logbridge_agents_total{status="waiting"} ${metrics.agents.waiting}`,
    `# HELP logbridge_workflows_total Workflows by state`,
    `# TYPE logbridge_workflows_total gauge`,
    `logbridge_workflows_total{state="active"} ${metrics.workflows.active}`,
    `logbridge_workflows_total{state="completed"} ${metrics.workflows.completed}`,
    `# HELP logbridge_memory_rss_bytes Resident Set Size in bytes`,
    `# TYPE logbridge_memory_rss_bytes gauge`,
    `logbridge_memory_rss_bytes ${Math.round(metrics.memory.rssMb * 1024 * 1024)}`,
  ].join("\n");
}
