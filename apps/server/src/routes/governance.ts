import type { FastifyInstance } from "fastify";
import {
  getProjectMembers, setProjectMember, removeProjectMember
} from "../db.js";
import {
  createApprovalRequest, getApprovalRequest, getProjectApprovals, resolveApprovalRequest
} from "../approvals.js";
import { hasPermission } from "../authorization.js";
import { recordAuditLog, getProjectAuditLogs } from "../audit.js";
import { resolveEscalation, getProjectEscalations } from "../escalations.js";
import { getProjectDeadLetters, reprocessDeadLetter } from "../deadLetter.js";
import { orchestrate } from "../nodeGateway.js";
import type { RouteDeps } from "./types.js";

export function registerGovernanceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, nodeSockets, broadcastView } = deps;

  // Approvals
  app.get<{ Params: { id: string }; Querystring: { state?: string } }>("/api/projects/:id/approvals", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const approvals = getProjectApprovals(db, projectId, req.query?.state as any);
    return { ok: true, approvals };
  });

  app.get<{ Params: { id: string } }>("/api/approvals/:id", async (req, reply) => {
    const approval = getApprovalRequest(db, req.params.id);
    if (!approval) return reply.code(404).send({ ok: false, error: "approval request not found" });
    return { ok: true, approval };
  });

  app.post<{
    Params: { id: string };
    Body: {
      workflowId?: string;
      goalId?: string;
      taskId?: string;
      requesterId?: string;
      requesterType?: "agent" | "user" | "supervisor";
      approvalType: any;
      title: string;
      description?: string;
      reason: string;
      riskLevel?: any;
      proposedAction?: any;
    };
  }>("/api/projects/:id/approvals", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const {
      workflowId, goalId, taskId, requesterId, requesterType,
      approvalType, title, description, reason, riskLevel, proposedAction
    } = req.body ?? {};

    if (!title || !reason || !approvalType) {
      return reply.code(400).send({ ok: false, error: "title, reason, and approvalType required" });
    }

    const approvalId = createApprovalRequest(db, {
      projectId,
      workflowId: workflowId ?? null,
      goalId: goalId ?? null,
      taskId: taskId ?? null,
      requesterId: requesterId ?? "human",
      requesterType: requesterType ?? "user",
      approvalType,
      title,
      description: description ?? null,
      reason,
      riskLevel: riskLevel ?? "medium",
      proposedAction: proposedAction ?? null,
    });

    broadcastView();
    return { ok: true, approvalId };
  });

  app.post<{
    Params: { id: string };
    Body: { userId?: string; comment?: string };
  }>("/api/approvals/:id/approve", async (req, reply) => {
    const approvalId = req.params.id;
    const approval = getApprovalRequest(db, approvalId);
    if (!approval) return reply.code(404).send({ ok: false, error: "approval request not found" });

    const userId = req.body?.userId ?? "human";
    if (!hasPermission(db, approval.projectId, userId, "approval.resolve")) {
      return reply.code(403).send({ ok: false, error: "permission denied: requires approval.resolve" });
    }

    const result = resolveApprovalRequest(db, approvalId, userId, "approved", req.body?.comment);
    if (!result.ok) return reply.code(400).send(result);

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { approvalId, ...result };
  });

  app.post<{
    Params: { id: string };
    Body: { userId?: string; comment?: string };
  }>("/api/approvals/:id/reject", async (req, reply) => {
    const approvalId = req.params.id;
    const approval = getApprovalRequest(db, approvalId);
    if (!approval) return reply.code(404).send({ ok: false, error: "approval request not found" });

    const userId = req.body?.userId ?? "human";
    if (!hasPermission(db, approval.projectId, userId, "approval.resolve")) {
      return reply.code(403).send({ ok: false, error: "permission denied: requires approval.resolve" });
    }

    const result = resolveApprovalRequest(db, approvalId, userId, "rejected", req.body?.comment);
    if (!result.ok) return reply.code(400).send(result);

    broadcastView();
    return { approvalId, ...result };
  });

  // Audit Logs
  app.get<{ Params: { id: string }; Querystring: { limit?: string; userId?: string } }>("/api/projects/:id/audit", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const userId = req.query?.userId ?? "human";
    if (!hasPermission(db, projectId, userId, "audit.view")) {
      return reply.code(403).send({ ok: false, error: "permission denied: requires audit.view" });
    }

    const limit = req.query?.limit ? parseInt(req.query.limit, 10) : 100;
    const logs = getProjectAuditLogs(db, projectId, limit);
    return { ok: true, logs };
  });

  // Escalations
  app.get<{ Params: { id: string }; Querystring: { state?: string } }>("/api/projects/:id/escalations", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const escalations = getProjectEscalations(db, projectId, req.query?.state as any);
    return { ok: true, escalations };
  });

  app.post<{
    Params: { id: string };
    Body: { userId?: string; notes?: string };
  }>("/api/escalations/:id/resolve", async (req, reply) => {
    const escalationId = req.params.id;
    const userId = req.body?.userId ?? "human";

    const ok = resolveEscalation(db, escalationId, userId, req.body?.notes);
    if (!ok) return reply.code(400).send({ ok: false, error: "failed to resolve escalation or already resolved" });

    broadcastView();
    return { ok: true, escalationId };
  });

  // Project Members & Roles (RBAC)
  app.get<{ Params: { id: string } }>("/api/projects/:id/members", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const members = getProjectMembers(db, projectId);
    return { ok: true, members };
  });

  app.post<{
    Params: { id: string };
    Body: { userId: string; role?: string; actorId?: string };
  }>("/api/projects/:id/members", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const { userId, role, actorId } = req.body ?? {};
    if (!userId) return reply.code(400).send({ ok: false, error: "userId required" });

    const actor = actorId ?? "human";
    if (!hasPermission(db, projectId, actor, "member.manage")) {
      return reply.code(403).send({ ok: false, error: "permission denied: requires member.manage" });
    }

    setProjectMember(db, projectId, userId, role ?? "member");
    recordAuditLog(db, {
      projectId,
      actorType: "user",
      actorId: actor,
      action: "member.added",
      resourceType: "member",
      resourceId: userId,
      metadata: { role: role ?? "member" },
    });

    broadcastView();
    return { ok: true, projectId, userId, role: role ?? "member" };
  });

  app.put<{
    Params: { id: string; userId: string };
    Body: { role: string; actorId?: string };
  }>("/api/projects/:id/members/:userId", async (req, reply) => {
    const { id: projectId, userId } = req.params;
    const { role, actorId } = req.body ?? {};
    if (!role) return reply.code(400).send({ ok: false, error: "role required" });

    const actor = actorId ?? "human";
    if (!hasPermission(db, projectId, actor, "member.manage")) {
      return reply.code(403).send({ ok: false, error: "permission denied: requires member.manage" });
    }

    setProjectMember(db, projectId, userId, role);
    recordAuditLog(db, {
      projectId,
      actorType: "user",
      actorId: actor,
      action: "member.role_updated",
      resourceType: "member",
      resourceId: userId,
      metadata: { role },
    });

    broadcastView();
    return { ok: true, projectId, userId, role };
  });

  app.delete<{
    Params: { id: string; userId: string };
    Body: { actorId?: string };
  }>("/api/projects/:id/members/:userId", async (req, reply) => {
    const { id: projectId, userId } = req.params;
    const actor = req.body?.actorId ?? "human";

    if (!hasPermission(db, projectId, actor, "member.manage")) {
      return reply.code(403).send({ ok: false, error: "permission denied: requires member.manage" });
    }

    removeProjectMember(db, projectId, userId);
    recordAuditLog(db, {
      projectId,
      actorType: "user",
      actorId: actor,
      action: "member.removed",
      resourceType: "member",
      resourceId: userId,
    });

    broadcastView();
    return { ok: true, projectId, userId };
  });

  // Dead Letter Queue
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/projects/:id/dead-letter", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const deadLetters = getProjectDeadLetters(db, projectId, req.query?.status as any);
    return { ok: true, deadLetters };
  });

  app.post<{
    Params: { id: string };
    Body: { action: any; userId?: string; notes?: string };
  }>("/api/dead-letter/:id/reprocess", async (req, reply) => {
    const deadLetterId = req.params.id;
    const { action, userId, notes } = req.body ?? {};
    if (!action) return reply.code(400).send({ ok: false, error: "action required" });

    const result = reprocessDeadLetter(db, deadLetterId, action, userId ?? "human", notes);
    if (!result.ok) return reply.code(400).send(result);

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { deadLetterId, ...result };
  });
}
