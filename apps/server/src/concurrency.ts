// Concurrency Limits & Backpressure Controls (Phase 6).
// Prevents agents, projects, and the orchestrator from being overwhelmed.

import type { Db } from "./db.js";
import { getConfig } from "./config.js";

export interface ConcurrencyCheckResult {
  allowed: boolean;
  reason?: string;
  currentProjectTasks?: number;
  currentAgentTasks?: number;
}

export function checkDispatchConcurrency(
  db: Db,
  projectId: string,
  agentId?: string
): ConcurrencyCheckResult {
  const config = getConfig();

  // 1. Check Project-level concurrent active tasks
  const projectTasksCount = (
    db.prepare("SELECT count(*) as count FROM tasks WHERE project_id = ? AND state = 'working'").get(projectId) as any
  )?.count ?? 0;

  if (projectTasksCount >= config.MAX_CONCURRENT_TASKS_PER_PROJECT) {
    return {
      allowed: false,
      reason: `Project task concurrency limit reached (${projectTasksCount}/${config.MAX_CONCURRENT_TASKS_PER_PROJECT})`,
      currentProjectTasks: projectTasksCount,
    };
  }

  // 2. Check Agent-level concurrent active tasks
  if (agentId) {
    const agent = db.prepare("SELECT concurrency FROM agents WHERE id = ?").get(agentId) as any;
    const maxAgentConcurrency = agent?.concurrency ?? config.MAX_CONCURRENT_TASKS_PER_AGENT;

    const agentTasksCount = (
      db.prepare("SELECT count(*) as count FROM tasks WHERE agent_id = ? AND state = 'working'").get(agentId) as any
    )?.count ?? 0;

    if (agentTasksCount >= maxAgentConcurrency) {
      return {
        allowed: false,
        reason: `Agent concurrency limit reached (${agentTasksCount}/${maxAgentConcurrency})`,
        currentAgentTasks: agentTasksCount,
      };
    }
  }

  return {
    allowed: true,
    currentProjectTasks: projectTasksCount,
  };
}
