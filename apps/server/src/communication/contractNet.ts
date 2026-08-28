// Contract-Net Protocol & Proposal Bidding Engine.
// Manages Call for Proposals (CFP), Agent Proposals (PROPOSE), Deterministic Scoring, and Bid Resolution.

import type { Db } from "../db.js";
import {
  createContractNetCfp,
  getContractNetCfp,
  updateCfpStatus,
  createAgentProposal,
  getAgentProposal,
  getCfpProposals,
  updateProposalStatus,
  getTask,
  assignTaskToAgent,
  getAgentHistoricalPerformance,
  candidateAgents,
  activeTaskCountsByAgent,
  appendEvent,
} from "../db.js";
import { emitSequenceEvent } from "./sequenceEvents.js";
import type {
  CallForProposal,
  AgentProposal,
  ProposalScoreBreakdown,
  ProposalScoringWeights,
} from "./types.js";

export function issueCfp(
  db: Db,
  opts: {
    projectId: string;
    taskId: string;
    senderAgentId?: string;
    candidateAgentIds?: string[];
    deadlineSeconds?: number;
    correlationId?: string;
  }
): CallForProposal | null {
  const task = getTask(db, opts.taskId);
  if (!task) return null;

  // Determine eligible candidates
  const allCandidates = candidateAgents(db, opts.projectId);
  const eligibleCandidates = opts.candidateAgentIds
    ? allCandidates.filter((c) => opts.candidateAgentIds!.includes(c.id))
    : allCandidates.filter((c) => {
        if (!c.machineOnline) return false;
        if (!task.required_capability) return true;
        return c.capabilities.includes(task.required_capability);
      });

  if (eligibleCandidates.length === 0) {
    return null;
  }

  const senderId = opts.senderAgentId ?? "commander";
  const deadline = opts.deadlineSeconds
    ? new Date(Date.now() + opts.deadlineSeconds * 1000).toISOString()
    : new Date(Date.now() + 60000).toISOString();

  const correlationId = opts.correlationId ?? `corr_${crypto.randomUUID()}`;

  const cfpRow = createContractNetCfp(db, {
    projectId: opts.projectId,
    taskId: opts.taskId,
    senderAgentId: senderId,
    candidateAgentIds: eligibleCandidates.map((c) => c.id),
    requirements: {
      title: task.title,
      description: task.spec ?? "",
      capabilities: task.required_capability ? [task.required_capability] : [],
      budgetSeconds: task.budget_seconds,
      budgetUsd: task.budget_usd,
    },
    deadline,
    correlationId,
  });

  // Emit Sequence Event: CFP_SENT
  emitSequenceEvent(db, {
    projectId: opts.projectId,
    taskId: opts.taskId,
    correlationId,
    type: "CFP_SENT",
    source: { type: "AGENT", id: senderId, label: "Commander" },
    target: { type: "AGENT", id: "candidates", label: `Candidates (${eligibleCandidates.length})` },
    summary: `CFP broadcast for task "${task.title}" to ${eligibleCandidates.length} eligible candidates`,
    metadata: {
      cfpId: cfpRow.id,
      candidateAgentIds: eligibleCandidates.map((c) => c.id),
      deadline,
    },
  });

  appendEvent(db, opts.projectId, opts.taskId, "contract_net.cfp_sent", {
    cfpId: cfpRow.id,
    taskId: opts.taskId,
    candidates: eligibleCandidates.map((c) => c.id),
    deadline,
  });

  return {
    type: "CFP",
    cfpId: cfpRow.id,
    taskId: opts.taskId,
    projectId: opts.projectId,
    conversationId: cfpRow.conversation_id,
    senderAgentId: senderId,
    candidateAgentIds: eligibleCandidates.map((c) => c.id),
    requirements: JSON.parse(cfpRow.requirements_json),
    deadline,
    correlationId,
  };
}

/**
 * Deterministic scoring function for an agent proposal.
 */
export function scoreAgentProposal(
  proposal: {
    approach: string;
    confidence: number;
    estimatedDuration?: number | null;
  },
  agentContext: {
    capabilities: string[];
    concurrency: number;
    currentLoad: number;
    requiredCapability?: string | null;
    historicalSuccessRate?: number;
  },
  weights: ProposalScoringWeights = {}
): { finalScore: number; breakdown: ProposalScoreBreakdown } {
  const wMatch = weights.capabilityMatchWeight ?? 0.35;
  const wConf = weights.confidenceWeight ?? 0.25;
  const wAvail = weights.availabilityWeight ?? 0.20;
  const wPerf = weights.performanceWeight ?? 0.20;
  const pDur = weights.durationPenaltyWeight ?? 0.10;
  const pCost = weights.costPenaltyWeight ?? 0.05;

  // 1. Capability Match Score (0.0 to 1.0)
  let capabilityMatch = 1.0;
  if (agentContext.requiredCapability) {
    capabilityMatch = agentContext.capabilities.includes(agentContext.requiredCapability) ? 1.0 : 0.2;
  }

  // 2. Confidence Score (0.0 to 1.0)
  const confidence = Math.max(0, Math.min(1.0, proposal.confidence));

  // 3. Availability Score (0.0 to 1.0)
  const maxConc = Math.max(1, agentContext.concurrency);
  const availability = Math.max(0, 1.0 - agentContext.currentLoad / maxConc);

  // 4. Historical Performance Score (0.0 to 1.0)
  const historicalPerformance = agentContext.historicalSuccessRate ?? 1.0;

  // 5. Duration Penalty (0.0 to 1.0)
  const duration = proposal.estimatedDuration ?? 30;
  const durationPenalty = duration > 120 ? Math.min(1.0, (duration - 120) / 120) : 0;

  // 6. Cost Penalty
  const costPenalty = 0;

  // Final Weighted Score (0.0 to 1.0)
  const rawScore =
    capabilityMatch * wMatch +
    confidence * wConf +
    availability * wAvail +
    historicalPerformance * wPerf -
    durationPenalty * pDur -
    costPenalty * pCost;

  const finalScore = Math.round(Math.max(0, Math.min(1.0, rawScore)) * 1000) / 1000;

  return {
    finalScore,
    breakdown: {
      capabilityMatch,
      confidence,
      availability,
      historicalPerformance,
      durationPenalty,
      costPenalty,
    },
  };
}

export function submitProposal(
  db: Db,
  opts: {
    cfpId: string;
    agentId: string;
    approach: string;
    confidence: number;
    estimatedDuration?: number;
    reasoningSummary?: string;
    correlationId?: string;
  }
): AgentProposal | null {
  const cfp = getContractNetCfp(db, opts.cfpId);
  if (!cfp || cfp.status !== "open") return null;

  const candidateIds: string[] = JSON.parse(cfp.candidate_agent_ids_json);
  if (!candidateIds.includes(opts.agentId)) return null;

  const task = getTask(db, cfp.task_id);
  const agentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(opts.agentId) as any;
  if (!agentRow) return null;

  const capabilities: string[] = agentRow.capabilities ? JSON.parse(agentRow.capabilities) : [];
  const loadMap = activeTaskCountsByAgent(db);
  const currentLoad = loadMap.get(opts.agentId) ?? 0;
  const history = getAgentHistoricalPerformance(db, opts.agentId, cfp.project_id);

  const { finalScore, breakdown } = scoreAgentProposal(
    {
      approach: opts.approach,
      confidence: opts.confidence,
      estimatedDuration: opts.estimatedDuration,
    },
    {
      capabilities,
      concurrency: agentRow.concurrency ?? 1,
      currentLoad,
      requiredCapability: task?.required_capability ?? null,
      historicalSuccessRate: history.successRate,
    }
  );

  const correlationId = opts.correlationId ?? cfp.correlation_id ?? `corr_${crypto.randomUUID()}`;

  const proposalRow = createAgentProposal(db, {
    cfpId: opts.cfpId,
    taskId: cfp.task_id,
    agentId: opts.agentId,
    approach: opts.approach,
    estimatedDuration: opts.estimatedDuration ?? null,
    confidence: opts.confidence,
    capabilityMatch: breakdown.capabilityMatch,
    availabilityScore: breakdown.availability,
    reasoningSummary: opts.reasoningSummary ?? null,
    score: finalScore,
    scoreBreakdown: breakdown,
    correlationId,
  });

  // Emit Sequence Event: PROPOSAL_RECEIVED
  emitSequenceEvent(db, {
    projectId: cfp.project_id,
    taskId: cfp.task_id,
    correlationId,
    type: "PROPOSAL_RECEIVED",
    source: { type: "AGENT", id: opts.agentId, label: agentRow.name },
    target: { type: "AGENT", id: cfp.sender_agent_id, label: "Commander" },
    summary: `Proposal from ${agentRow.name} (confidence: ${(opts.confidence * 100).toFixed(0)}%, score: ${finalScore})`,
    metadata: {
      cfpId: cfp.id,
      proposalId: proposalRow.id,
      approach: opts.approach,
      score: finalScore,
      breakdown,
    },
  });

  return {
    type: "PROPOSE",
    proposalId: proposalRow.id,
    cfpId: cfp.id,
    taskId: cfp.task_id,
    projectId: cfp.project_id,
    agentId: opts.agentId,
    approach: opts.approach,
    estimatedDuration: opts.estimatedDuration,
    confidence: opts.confidence,
    capabilityMatch: breakdown.capabilityMatch,
    availabilityScore: breakdown.availability,
    reasoningSummary: opts.reasoningSummary,
    score: finalScore,
    breakdown,
    correlationId,
  };
}

export function resolveContractNet(
  db: Db,
  cfpId: string,
  selectedProposalId?: string
): {
  winningProposal: AgentProposal | null;
  declinedProposals: AgentProposal[];
} {
  const cfp = getContractNetCfp(db, cfpId);
  if (!cfp) return { winningProposal: null, declinedProposals: [] };

  const proposals = getCfpProposals(db, cfpId);
  if (proposals.length === 0) {
    updateCfpStatus(db, cfpId, "expired");
    return { winningProposal: null, declinedProposals: [] };
  }

  // Determine winner
  let winnerRow = selectedProposalId
    ? proposals.find((p) => p.id === selectedProposalId)
    : proposals[0]; // Ordered by score DESC

  if (!winnerRow) winnerRow = proposals[0];

  // Update proposals
  updateProposalStatus(db, winnerRow.id, "accepted");
  updateCfpStatus(db, cfpId, "resolved", winnerRow.id);

  const declined: AgentProposal[] = [];
  for (const p of proposals) {
    if (p.id !== winnerRow.id) {
      updateProposalStatus(db, p.id, "declined");
      declined.push({
        type: "PROPOSE",
        proposalId: p.id,
        cfpId: p.cfp_id,
        taskId: p.task_id,
        projectId: cfp.project_id,
        agentId: p.agent_id,
        approach: p.approach,
        confidence: p.confidence,
        score: p.score ?? undefined,
        correlationId: p.correlation_id ?? "",
      });

      // Emit DECLINE_PROPOSAL sequence event
      emitSequenceEvent(db, {
        projectId: cfp.project_id,
        taskId: cfp.task_id,
        correlationId: cfp.correlation_id,
        type: "PROPOSAL_DECLINED",
        source: { type: "AGENT", id: cfp.sender_agent_id, label: "Commander" },
        target: { type: "AGENT", id: p.agent_id, label: p.agent_id },
        summary: `Declined proposal from ${p.agent_id}`,
        metadata: { cfpId, proposalId: p.id },
      });
    }
  }

  // Assign task to winning agent
  assignTaskToAgent(db, cfp.task_id, winnerRow.agent_id);

  const winningAgent = db.prepare("SELECT name FROM agents WHERE id = ?").get(winnerRow.agent_id) as any;
  const winningName = winningAgent?.name ?? winnerRow.agent_id;

  // Emit ACCEPT_PROPOSAL sequence event
  emitSequenceEvent(db, {
    projectId: cfp.project_id,
    taskId: cfp.task_id,
    correlationId: cfp.correlation_id,
    type: "PROPOSAL_ACCEPTED",
    source: { type: "AGENT", id: cfp.sender_agent_id, label: "Commander" },
    target: { type: "AGENT", id: winnerRow.agent_id, label: winningName },
    summary: `Accepted winning proposal from ${winningName} (score: ${winnerRow.score})`,
    metadata: {
      cfpId,
      proposalId: winnerRow.id,
      score: winnerRow.score,
      approach: winnerRow.approach,
    },
  });

  appendEvent(db, cfp.project_id, cfp.task_id, "contract_net.proposal_accepted", {
    cfpId,
    winnerProposalId: winnerRow.id,
    agentId: winnerRow.agent_id,
    score: winnerRow.score,
  });

  return {
    winningProposal: {
      type: "PROPOSE",
      proposalId: winnerRow.id,
      cfpId: winnerRow.cfp_id,
      taskId: winnerRow.task_id,
      projectId: cfp.project_id,
      agentId: winnerRow.agent_id,
      approach: winnerRow.approach,
      estimatedDuration: winnerRow.estimated_duration ?? undefined,
      confidence: winnerRow.confidence,
      score: winnerRow.score ?? undefined,
      breakdown: winnerRow.score_breakdown_json ? JSON.parse(winnerRow.score_breakdown_json) : undefined,
      correlationId: winnerRow.correlation_id ?? "",
    },
    declinedProposals: declined,
  };
}
