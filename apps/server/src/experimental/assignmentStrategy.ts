// Assignment Strategy Layer — EXPERIMENTAL. Nothing calls this.
//
// It chooses between Direct Assignment and Contract-Net Bidding, and returning
// "CONTRACT_NET" from here has no effect: no caller consumes the result. That
// is precisely why this moved out of communication/ — a seam that looks
// load-bearing and is not is worse than no seam, because the next person to
// read `assignPendingTasks()` goes looking for the branch that honours it.
//
// The live path is orchestrator.ts -> evaluateAgentCandidates(), which is
// deterministic, explainable and free. See ./README.md for why an auction
// would decide worse here, and what would reopen the question.

import type { AssignmentStrategy } from "../communication/types.js";

export interface StrategySelectionInput {
  task: {
    id: string;
    title: string;
    spec?: string | null;
    required_capability?: string | null;
    budget_usd?: number;
    kind?: string | null;
  };
  candidates: Array<{
    id: string;
    capabilities: string[];
    machineOnline: boolean;
  }>;
  configuration?: {
    defaultStrategy?: AssignmentStrategy;
    forceContractNet?: boolean;
    minCandidatesForAuction?: number;
  };
}

export function selectAssignmentStrategy(input: StrategySelectionInput): AssignmentStrategy {
  const cfg = input.configuration ?? {};
  
  if (cfg.forceContractNet) {
    return "CONTRACT_NET";
  }

  // Check if explicit task spec dictates auction/contract-net
  const spec = (input.task.spec || "").toLowerCase();
  const title = (input.task.title || "").toLowerCase();
  if (
    spec.includes("#auction") ||
    spec.includes("#cfp") ||
    title.includes("#auction") ||
    title.includes("#cfp") ||
    title.includes("[auction]")
  ) {
    return "CONTRACT_NET";
  }

  if (cfg.defaultStrategy) {
    return cfg.defaultStrategy;
  }

  // If there are at least 2 eligible online candidates with matching capability, Contract-Net is selected
  const eligibleOnline = input.candidates.filter((c) => {
    if (!c.machineOnline) return false;
    if (!input.task.required_capability) return true;
    return c.capabilities.includes(input.task.required_capability);
  });

  const minCandidates = cfg.minCandidatesForAuction ?? 2;
  if (eligibleOnline.length >= minCandidates && (input.task.required_capability || (input.task.budget_usd && input.task.budget_usd > 2.0))) {
    return "CONTRACT_NET";
  }

  return "DIRECT";
}
