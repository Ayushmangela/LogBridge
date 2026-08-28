// The orchestrator (ORCHESTRATOR.md). Intelligent & deterministic task routing.
// Evaluates capability match, load, historical reliability, and previous failure penalties.

import {
  type Db,
  activeTaskCountsByAgent,
  candidateAgents,
  pendingUnassignedTasks,
  assignTaskToAgent,
  appendEvent,
  getAgentHistoricalPerformance,
} from "./db.js";

export interface AgentCandidate {
  id: string;
  name: string;
  capabilities: string[];
  concurrency: number;
  machineOnline: boolean;
}

export interface RoutingScoreBreakdown {
  capabilityScore: number;
  availabilityScore: number;
  reliabilityScore: number;
  loadPenalty: number;
  failurePenalty: number;
  totalScore: number;
}

export interface CandidateScore {
  agentId: string;
  agentName: string;
  eligible: boolean;
  score: number;
  breakdown: RoutingScoreBreakdown;
  disqualificationReason?: string;
}

export interface IntelligentPickResult {
  chosen: AgentCandidate | null;
  candidates: CandidateScore[];
  explanation: string;
}

/**
 * Score and evaluate all candidate agents for a task deterministically.
 */
export function evaluateAgentCandidates(
  candidates: AgentCandidate[],
  load: Map<string, number>,
  requiredCapability: string | null,
  opts?: {
    historyByAgent?: Map<string, { successRate: number; tasksCompleted: number }>;
    failedAgentIds?: Set<string>;
  }
): IntelligentPickResult {
  if (candidates.length === 0) {
    return {
      chosen: null,
      candidates: [],
      explanation: "No registered agents in project",
    };
  }

  const scores: CandidateScore[] = [];

  for (const c of candidates) {
    const currentLoad = load.get(c.id) ?? 0;
    const history = opts?.historyByAgent?.get(c.id) ?? { successRate: 1.0, tasksCompleted: 0 };
    const previouslyFailed = opts?.failedAgentIds?.has(c.id) ?? false;

    let eligible = true;
    let disqualificationReason: string | undefined;

    if (!c.machineOnline) {
      eligible = false;
      disqualificationReason = "Machine offline";
    } else if (currentLoad >= c.concurrency) {
      eligible = false;
      disqualificationReason = `At max concurrency limit (${currentLoad}/${c.concurrency})`;
    } else if (requiredCapability && !c.capabilities.includes(requiredCapability)) {
      eligible = false;
      disqualificationReason = `Missing required capability: "${requiredCapability}"`;
    }

    const capabilityScore = requiredCapability
      ? (c.capabilities.includes(requiredCapability) ? 40 : 0)
      : 30;
    const availabilityScore = c.machineOnline ? 20 : 0;
    const loadPenalty = eligible ? -Math.round((currentLoad / Math.max(1, c.concurrency)) * 10) : -30;
    const reliabilityScore = Math.round((history.successRate ?? 1.0) * 20);
    const failurePenalty = previouslyFailed ? -15 : 0;

    const totalScore = eligible
      ? capabilityScore + availabilityScore + reliabilityScore + loadPenalty + failurePenalty
      : -100;

    scores.push({
      agentId: c.id,
      agentName: c.name,
      eligible,
      score: totalScore,
      breakdown: {
        capabilityScore,
        availabilityScore,
        reliabilityScore,
        loadPenalty,
        failurePenalty,
        totalScore,
      },
      disqualificationReason,
    });
  }

  const eligibleCandidates = scores.filter((s) => s.eligible);

  if (eligibleCandidates.length === 0) {
    return {
      chosen: null,
      candidates: scores,
      explanation: "No capable or available agent free right now",
    };
  }

  // Sort deterministically: highest score first, then lowest load, tie-break on agentId ASC
  eligibleCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const loadA = load.get(a.agentId) ?? 0;
    const loadB = load.get(b.agentId) ?? 0;
    if (loadA !== loadB) return loadA - loadB;
    return a.agentId.localeCompare(b.agentId);
  });

  const bestScore = eligibleCandidates[0];
  const chosen = candidates.find((c) => c.id === bestScore.agentId) ?? null;

  const explanation = chosen
    ? `Selected "${chosen.name}" (score: ${bestScore.score}) with ${
        requiredCapability ? `capability "${requiredCapability}"` : "general capability"
      }, ${bestScore.breakdown.reliabilityScore}pts reliability, and ${load.get(chosen.id) ?? 0} active load`
    : "No agent selected";

  return {
    chosen,
    candidates: scores,
    explanation,
  };
}

/**
 * Backward-compatible pickAgent function.
 */
export function pickAgent(
  candidates: AgentCandidate[],
  load: Map<string, number>,
  requiredCapability: string | null
): AgentCandidate | null {
  return evaluateAgentCandidates(candidates, load, requiredCapability).chosen;
}

export interface AssignmentResult {
  taskId: string;
  agentId: string;
  explanation?: string;
}

/**
 * Assign as many unassigned tasks as there is capacity for, oldest first.
 */
export function assignPendingTasks(db: Db): AssignmentResult[] {
  const pending = pendingUnassignedTasks(db);
  if (pending.length === 0) return [];

  const assigned: AssignmentResult[] = [];
  const load = activeTaskCountsByAgent(db);
  const candidatesByProject = new Map<string, AgentCandidate[]>();

  for (const task of pending) {
    if (!candidatesByProject.has(task.project_id)) {
      candidatesByProject.set(task.project_id, candidateAgents(db, task.project_id));
    }
    const candidates = candidatesByProject.get(task.project_id)!;

    // Compile historical stats for candidates
    const historyByAgent = new Map<string, { successRate: number; tasksCompleted: number }>();
    for (const c of candidates) {
      historyByAgent.set(c.id, getAgentHistoricalPerformance(db, c.id, task.project_id));
    }

    // Check if task is a retry of a previous failure
    const failedAgentIds = new Set<string>();
    const prevAttempts = db.prepare("SELECT agent_id, state FROM task_attempts WHERE task_id = ?").all(task.id) as any[];
    for (const a of prevAttempts) {
      if (a.state === "failed" || a.state === "timed_out") failedAgentIds.add(a.agent_id);
    }

    const evaluation = evaluateAgentCandidates(
      candidates,
      load,
      task.required_capability ?? null,
      { historyByAgent, failedAgentIds }
    );

    const chosen = evaluation.chosen;
    if (!chosen) {
      continue;
    }

    assignTaskToAgent(db, task.id, chosen.id);
    load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1);

    // Emit routing evaluation event with full candidate scoring
    appendEvent(db, task.project_id, task.id, "task.routing_evaluated", {
      selectedAgentId: chosen.id,
      selectedAgentName: chosen.name,
      candidates: evaluation.candidates,
      explanation: evaluation.explanation,
    });

    appendEvent(db, task.project_id, task.id, "task.assigned", {
      agentId: chosen.id,
      agentName: chosen.name,
      requiredCapability: task.required_capability ?? null,
      by: "orchestrator",
    });

    assigned.push({ taskId: task.id, agentId: chosen.id });
  }

  return assigned;
}
