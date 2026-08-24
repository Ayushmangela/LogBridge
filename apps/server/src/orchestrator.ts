// The orchestrator (ORCHESTRATOR.md). Task routing done by rules rather
// than by a model.
//
// It answers exactly one question: *given a task nobody is assigned to, which
// agent should run it?* — by capability, availability and load. It does NOT
// decide what work should exist; decomposing a goal into tasks is a reasoning
// job and this project still has no LLM wired in (same gap as D24/D25). What
// is here is real routing, not a stand-in for one.
import {
  type Db,
  activeTaskCountsByAgent,
  candidateAgents,
  pendingUnassignedTasks,
  assignTaskToAgent,
  appendEvent,
} from "./db.js";

export interface AgentCandidate {
  id: string;
  name: string;
  capabilities: string[];
  concurrency: number;
  machineOnline: boolean;
}

/**
 * Pick the agent that should run a task, or null if none can right now.
 *
 * Deterministic on purpose: same database state, same choice. An orchestrator
 * that picked randomly would make "why did that run there?" unanswerable, and
 * the office would reshuffle for no observable reason.
 */
export function pickAgent(
  candidates: AgentCandidate[],
  load: Map<string, number>,
  requiredCapability: string | null
): AgentCandidate | null {
  const eligible = candidates.filter((a) => {
    if (!a.machineOnline) return false; // a sleeping laptop cannot take work
    if ((load.get(a.id) ?? 0) >= a.concurrency) return false;
    if (requiredCapability && !a.capabilities.includes(requiredCapability)) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // Least loaded first so work spreads out; id as the tie-break so the choice
  // is stable rather than dependent on row order.
  eligible.sort((x, y) => {
    const dx = (load.get(x.id) ?? 0) - (load.get(y.id) ?? 0);
    return dx !== 0 ? dx : x.id.localeCompare(y.id);
  });
  return eligible[0];
}

export interface AssignmentResult {
  taskId: string;
  agentId: string;
}

/**
 * Assign as many unassigned tasks as there is capacity for, oldest first.
 * Returns what it assigned so the caller can offer those tasks to runners.
 *
 * Safe to call often and from several places (a task arriving, an agent going
 * idle, a machine reconnecting) — with nothing to do it is a couple of
 * indexed reads. Being cheap is what lets it be the single entry point rather
 * than three subtly different ones.
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
    const chosen = pickAgent(
      candidatesByProject.get(task.project_id)!,
      load,
      task.required_capability ?? null
    );
    if (!chosen) {
      // No capable agent free. The task stays `submitted` and is retried on
      // the next call — deliberately NOT failed: "nobody is free right now"
      // is a queue, not an error.
      continue;
    }

    assignTaskToAgent(db, task.id, chosen.id);
    // Count it immediately so a second task in this same pass doesn't
    // over-fill the agent we just picked.
    load.set(chosen.id, (load.get(chosen.id) ?? 0) + 1);
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
