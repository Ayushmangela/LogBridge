import type { FastifyInstance } from "fastify";
import { createTask, appendEvent } from "../db.js";
import { issueCfp, submitProposal, resolveContractNet } from "../experimental/contractNet.js";
import { delegateHandoff } from "../communication/handoff.js";
import { processReviewResult } from "../communication/review.js";
import { getProjectSequenceFlow, getTaskSequenceFlow } from "../communication/sequenceEvents.js";
import { orchestrate, sendTaskOffer } from "../nodeGateway.js";
import type { RouteDeps } from "./types.js";

export function registerCommunicationRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, nodeSockets, broadcastView } = deps;

  app.post<{
    Body: {
      projectId: string;
      taskId: string;
      senderAgentId?: string;
      candidateAgentIds?: string[];
      deadlineSeconds?: number;
      correlationId?: string;
    };
  }>("/api/contract-net/cfp", async (req, reply) => {
    const { projectId, taskId, senderAgentId, candidateAgentIds, deadlineSeconds, correlationId } = req.body ?? {};
    if (!projectId || !taskId) return reply.code(400).send({ ok: false, error: "projectId and taskId required" });

    const cfp = issueCfp(db, {
      projectId,
      taskId,
      senderAgentId,
      candidateAgentIds,
      deadlineSeconds,
      correlationId,
    });

    if (!cfp) return reply.code(400).send({ ok: false, error: "no eligible candidate agents found for CFP" });

    broadcastView();
    return { ok: true, cfp };
  });

  app.post<{
    Body: {
      cfpId: string;
      agentId: string;
      approach: string;
      confidence: number;
      estimatedDuration?: number;
      reasoningSummary?: string;
      correlationId?: string;
    };
  }>("/api/contract-net/propose", async (req, reply) => {
    const { cfpId, agentId, approach, confidence, estimatedDuration, reasoningSummary, correlationId } = req.body ?? {};
    if (!cfpId || !agentId || !approach || typeof confidence !== "number") {
      return reply.code(400).send({ ok: false, error: "cfpId, agentId, approach, and confidence required" });
    }

    const proposal = submitProposal(db, {
      cfpId,
      agentId,
      approach,
      confidence,
      estimatedDuration,
      reasoningSummary,
      correlationId,
    });

    if (!proposal) return reply.code(400).send({ ok: false, error: "failed to submit proposal (CFP not open or agent ineligible)" });

    broadcastView();
    return { ok: true, proposal };
  });

  app.post<{
    Body: {
      cfpId: string;
      selectedProposalId?: string;
    };
  }>("/api/contract-net/resolve", async (req, reply) => {
    const { cfpId, selectedProposalId } = req.body ?? {};
    if (!cfpId) return reply.code(400).send({ ok: false, error: "cfpId required" });

    const result = resolveContractNet(db, cfpId, selectedProposalId);
    if (!result.winningProposal) {
      return reply.code(400).send({ ok: false, error: "no proposals available to resolve CFP" });
    }

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { ok: true, ...result };
  });

  app.post<{
    Body: {
      taskId: string;
      fromAgentId: string;
      toAgentId: string;
      artifacts: Record<string, string | undefined>;
      contextSummary?: {
        designDecisions?: string[];
        filesModified?: string[];
        knownLimitations?: string[];
      };
      correlationId?: string;
    };
  }>("/api/handoff/delegate", async (req, reply) => {
    const { taskId, fromAgentId, toAgentId, artifacts, contextSummary, correlationId } = req.body ?? {};
    if (!taskId || !fromAgentId || !toAgentId || !artifacts) {
      return reply.code(400).send({ ok: false, error: "taskId, fromAgentId, toAgentId, and artifacts required" });
    }

    const handoff = delegateHandoff(db, {
      taskId,
      fromAgentId,
      toAgentId,
      artifacts,
      contextSummary,
      correlationId,
    });

    if (!handoff) return reply.code(404).send({ ok: false, error: "task not found" });

    broadcastView();
    return { ok: true, handoff };
  });

  app.post<{
    Body: {
      taskId: string;
      reviewerAgentId: string;
      status: "ACCEPT" | "REJECT";
      comments: string[];
      artifactId?: string;
      findings?: any[];
      maxReworkAttempts?: number;
      correlationId?: string;
    };
  }>("/api/review/verdict", async (req, reply) => {
    const { taskId, reviewerAgentId, status, comments, artifactId, findings, maxReworkAttempts, correlationId } = req.body ?? {};
    if (!taskId || !reviewerAgentId || !status || !comments) {
      return reply.code(400).send({ ok: false, error: "taskId, reviewerAgentId, status, and comments required" });
    }

    try {
      const result = processReviewResult(db, {
        taskId,
        reviewerAgentId,
        status,
        comments,
        artifactId,
        findings,
        maxReworkAttempts,
        correlationId,
      });

      orchestrate(db, nodeSockets, app);
      broadcastView();
      return { ...result };
    } catch (err: any) {
      return reply.code(400).send({ ok: false, error: err.message });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/projects/:id/sequence-events", async (req) => {
    const limit = req.query?.limit ? Number(req.query.limit) : 200;
    const events = getProjectSequenceFlow(db, req.params.id, limit);
    return { ok: true, events };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/sequence-events", async (req) => {
    const events = getTaskSequenceFlow(db, req.params.id);
    return { ok: true, events };
  });

  app.post<{
    Body: {
      projectId: string;
      title: string;
      spec?: string | null;
      commanderId?: string;
    };
  }>("/api/commander/breakdown", async (req, reply) => {
    const { projectId, title, spec, commanderId } = req.body ?? {};
    if (!projectId || !title) return reply.code(400).send({ ok: false, error: "projectId and title required" });

    const parentTaskId = createTask(db, {
      projectId,
      title: `👑 Epic: ${title.trim()}`,
      spec: spec ?? null,
      creatorId: "commander",
      agentId: commanderId ?? null,
      kind: "plan",
      budgetSeconds: 300,
      budgetUsd: 5.0,
    });

    const agents = db.prepare(
      "SELECT id, name, role FROM agents WHERE project_id = ? AND status != 'retired'"
    ).all(projectId) as any[];

    const planner = agents.find((a) => a.role === "planner" || a.id === commanderId) || agents[0];
    const engineer = agents.find((a) => a.role === "developer" || a.role === "coder" || a.id !== planner?.id) || planner;
    const reviewer = agents.find((a) => a.role === "reviewer" || a.role === "qa" || (a.id !== planner?.id && a.id !== engineer?.id)) || planner;

    const subtaskTemplates = [
      {
        title: `[Architecture & Schema] ${title.trim()}`,
        spec: `Design technical schema, API contracts, and protocols for: ${title.trim()}.\n${spec || ''}`,
        assignedTo: planner?.id ?? null,
      },
      {
        title: `[Implementation] ${title.trim()}`,
        spec: `Implement core logic, backend endpoints, and components for: ${title.trim()}.\n${spec || ''}`,
        assignedTo: engineer?.id ?? null,
      },
      {
        title: `[Testing & Verification] ${title.trim()}`,
        spec: `Verify integration tests and end-to-end functionality for: ${title.trim()}.\n${spec || ''}`,
        assignedTo: reviewer?.id ?? null,
      },
    ];

    const createdSubtasks = [];
    for (const st of subtaskTemplates) {
      const subId = createTask(db, {
        projectId,
        title: st.title,
        spec: st.spec,
        creatorId: commanderId || "commander",
        agentId: st.assignedTo,
        parentTask: parentTaskId,
        budgetSeconds: 120,
        budgetUsd: 2.0,
      });
      if (st.assignedTo) {
        sendTaskOffer(db, nodeSockets, subId);
      }
      createdSubtasks.push({ id: subId, title: st.title, agentId: st.assignedTo });
    }

    appendEvent(db, projectId, parentTaskId, "commander.delegation", {
      parentTaskId,
      title,
      subtasks: createdSubtasks,
      at: new Date().toISOString(),
    });

    broadcastView();
    return {
      ok: true,
      parentTaskId,
      subtasks: createdSubtasks,
    };
  });
}
