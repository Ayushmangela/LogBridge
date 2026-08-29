import type { Db, FailureCategory, RetryPolicy, AgentMetrics, ProjectMetrics } from "./types.js";

// ─── Phase 3: Autonomous Intelligence, Health & Recovery ─────────────

export function classifyFailure(
  error?: string | null,
  exitCode?: number | null,
  timedOut?: boolean
): FailureCategory {
  if (timedOut) return "TIMEOUT";
  const str = String(error ?? "").toLowerCase();
  if (str.includes("lease expired") || str.includes("timed out") || str.includes("timeout")) return "TIMEOUT";
  if (str.includes("offline") || str.includes("socket closed") || str.includes("connection refused") || str.includes("econnrefused") || str.includes("econnreset")) return "MACHINE_OFFLINE";
  if (str.includes("transient") || str.includes("502") || str.includes("503") || str.includes("504") || str.includes("429") || str.includes("rate limit") || str.includes("temporary")) return "TRANSIENT";
  if (str.includes("syntax") || str.includes("invalid") || str.includes("bad request") || str.includes("400") || str.includes("unauthorized") || str.includes("permission denied")) return "INVALID_TASK";
  if (str.includes("dependency")) return "DEPENDENCY_FAILURE";
  if (exitCode != null && exitCode !== 0) return "AGENT_FAILURE";
  return "UNKNOWN";
}

export function getRetryPolicy(db: Db, projectId: string, taskId?: string | null): RetryPolicy {
  if (taskId) {
    const taskPolicy = db.prepare("SELECT * FROM retry_policies WHERE task_id = ?").get(taskId) as any;
    if (taskPolicy) {
      return {
        id: taskPolicy.id, projectId: taskPolicy.project_id, taskId: taskPolicy.task_id,
        maxAttempts: Number(taskPolicy.max_attempts), backoffMs: Number(taskPolicy.backoff_ms),
        retryOn: (() => { try { return JSON.parse(taskPolicy.retry_on); } catch { return ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"]; } })(),
        preferDifferentAgent: Boolean(taskPolicy.prefer_different_agent), createdAt: taskPolicy.created_at,
      };
    }
  }
  const projPolicy = db.prepare("SELECT * FROM retry_policies WHERE project_id = ? AND task_id IS NULL").get(projectId) as any;
  if (projPolicy) {
    return {
      id: projPolicy.id, projectId: projPolicy.project_id, taskId: null,
      maxAttempts: Number(projPolicy.max_attempts), backoffMs: Number(projPolicy.backoff_ms),
      retryOn: (() => { try { return JSON.parse(projPolicy.retry_on); } catch { return ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"]; } })(),
      preferDifferentAgent: Boolean(projPolicy.prefer_different_agent), createdAt: projPolicy.created_at,
    };
  }
  return {
    projectId, taskId: taskId ?? null, maxAttempts: 3, backoffMs: 1000,
    retryOn: ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"], preferDifferentAgent: true,
  };
}

export function setRetryPolicy(db: Db, opts: RetryPolicy): string {
  const id = opts.id || `rp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO retry_policies (id, project_id, task_id, max_attempts, backoff_ms, retry_on, prefer_different_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, opts.projectId, opts.taskId ?? null, opts.maxAttempts, opts.backoffMs,
    JSON.stringify(opts.retryOn), opts.preferDifferentAgent ? 1 : 0, now);
  return id;
}

export function getAgentMetrics(db: Db, agentId: string): AgentMetrics | null {
  const agent = db.prepare("SELECT a.*, m.online FROM agents a JOIN machines m ON m.id = a.machine_id WHERE a.id = ?").get(agentId) as any;
  if (!agent) return null;

  const attempts = db.prepare("SELECT * FROM task_attempts WHERE agent_id = ?").all(agentId) as any[];
  const tasksCompleted = attempts.filter((a) => a.state === "completed").length;
  const tasksFailed = attempts.filter((a) => a.state === "failed").length;
  const timeouts = attempts.filter((a) => a.state === "timed_out").length;
  const totalAttempts = attempts.length;
  const successRate = totalAttempts > 0 ? Number((tasksCompleted / totalAttempts).toFixed(3)) : 1.0;

  let totalDurationSec = 0, durationCount = 0, totalCostUsd = 0;
  for (const a of attempts) {
    if (a.cost_usd) totalCostUsd += Number(a.cost_usd);
    if (a.started_at && a.ended_at) {
      const dur = (new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) / 1000;
      if (dur > 0 && Number.isFinite(dur)) { totalDurationSec += dur; durationCount++; }
    }
  }

  const avgDurationSec = durationCount > 0 ? Number((totalDurationSec / durationCount).toFixed(1)) : 0;
  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND state IN ('submitted','working','blocked','input-required','auth-required')").get(agentId) as any;

  return {
    agentId: agent.id, name: agent.name, role: agent.role, machineOnline: Boolean(agent.online),
    status: agent.status, totalAttempts, tasksCompleted, tasksFailed, timeouts, successRate,
    avgDurationSec, totalCostUsd: Number(totalCostUsd.toFixed(3)), currentLoad: Number(activeCount?.n ?? 0),
  };
}

export function getProjectMetrics(db: Db, projectId: string): ProjectMetrics {
  const workflows = db.prepare("SELECT state FROM workflows WHERE project_id = ?").all(projectId) as any[];
  const tasks = db.prepare("SELECT state, cost_usd FROM tasks WHERE project_id = ?").all(projectId) as any[];
  const attempts = db.prepare("SELECT ta.state, ta.cost_usd FROM task_attempts ta JOIN tasks t ON t.id = ta.task_id WHERE t.project_id = ?").all(projectId) as any[];
  const agents = db.prepare("SELECT a.id, m.online FROM agents a JOIN machines m ON m.id = a.machine_id WHERE a.project_id = ?").all(projectId) as any[];

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.state === "completed").length;
  const failedTasks = tasks.filter((t) => t.state === "failed" || t.state === "rejected").length;
  const activeTasks = tasks.filter((t) => ["submitted", "working", "blocked", "input-required", "auth-required"].includes(t.state)).length;
  const totalAttempts = attempts.length;
  const completedAttempts = attempts.filter((a) => a.state === "completed").length;
  const successRate = totalAttempts > 0 ? Number((completedAttempts / totalAttempts).toFixed(3)) : (totalTasks > 0 ? Number((completedTasks / totalTasks).toFixed(3)) : 1.0);

  let totalCostUsd = 0;
  for (const t of tasks) if (t.cost_usd) totalCostUsd += Number(t.cost_usd);

  return {
    projectId, totalWorkflows: workflows.length,
    activeWorkflows: workflows.filter((w) => w.state === "active").length,
    completedWorkflows: workflows.filter((w) => w.state === "completed").length,
    failedWorkflows: workflows.filter((w) => w.state === "failed").length,
    totalTasks, completedTasks, failedTasks, activeTasks, totalAttempts, successRate,
    totalCostUsd: Number(totalCostUsd.toFixed(3)),
    onlineAgents: agents.filter((a) => a.online).length, totalAgents: agents.length,
  };
}

export function getAgentHistoricalPerformance(db: Db, agentId: string, projectId: string) {
  const metrics = getAgentMetrics(db, agentId);
  if (!metrics) return { successRate: 1.0, tasksCompleted: 0, totalAttempts: 0 };
  return { successRate: metrics.successRate, tasksCompleted: metrics.tasksCompleted, totalAttempts: metrics.totalAttempts };
}
