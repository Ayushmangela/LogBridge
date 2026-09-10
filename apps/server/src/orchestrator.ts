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
  /** The role DEFINITION this agent is briefed from, e.g. "security-auditor". */
  roleId?: string | null;
  /** The office CATEGORY it was filed under, e.g. "review". */
  role?: string | null;
}

export interface RoutingScoreBreakdown {
  capabilityScore: number;
  roleScore: number;
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

/** An exact role-definition match. Strong enough to beat a reliability gap,
 *  so the right specialist wins a close call. */
const ROLE_EXACT = 25;
/** The agent is filed in the right room but is not that exact role. Enough to
 *  prefer a reviewer over a developer, not enough to override capability. */
const ROLE_CATEGORY = 12;

/**
 * How well this agent matches the role the plan asked for.
 *
 * A PREFERENCE, added to the score — never a gate, and that distinction is the
 * whole point. Making the suggested role a hard requirement would recreate the
 * exact failure this project already had once: when the planner emitted role
 * names no agent could hold, four of every five planned tasks became
 * unassignable and the supervisor blocked them with "No online agent has
 * required capability". A task whose ideal specialist is absent should still
 * get done by whoever is qualified, just with a lower score.
 *
 * `suggested_role` had NO reader at all before this: the planner wrote it,
 * contextBuilder pasted it into the agent's prompt as a line of text, and
 * routing ignored it entirely. So a plan could ask for a reviewer and the work
 * would land on whoever happened to score highest.
 */
export function roleFit(candidate: AgentCandidate, suggestedRole: string | null): number {
  if (!suggestedRole) return 0;
  const want = suggestedRole.trim().toLowerCase();
  if (!want) return 0;
  if ((candidate.roleId ?? "").toLowerCase() === want) return ROLE_EXACT;
  // The office category is the coarser answer: a plan that asked for
  // "security-auditor" is better served by anyone in the review room than by
  // a developer.
  if ((candidate.role ?? "").toLowerCase() === want) return ROLE_CATEGORY;
  return 0;
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
    /** The role the plan asked for. A PREFERENCE, never a gate — see roleFit. */
    suggestedRole?: string | null;
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
    const roleScore = roleFit(c, opts?.suggestedRole ?? null);
    const availabilityScore = c.machineOnline ? 20 : 0;
    const loadPenalty = eligible ? -Math.round((currentLoad / Math.max(1, c.concurrency)) * 10) : -30;
    const reliabilityScore = Math.round((history.successRate ?? 1.0) * 20);
    const failurePenalty = previouslyFailed ? -15 : 0;

    const totalScore = eligible
      ? capabilityScore + roleScore + availabilityScore + reliabilityScore + loadPenalty + failurePenalty
      : -100;

    scores.push({
      agentId: c.id,
      agentName: c.name,
      eligible,
      score: totalScore,
      breakdown: {
        capabilityScore,
        roleScore,
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
      { historyByAgent, failedAgentIds, suggestedRole: task.suggested_role ?? null }
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
