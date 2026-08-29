import type { FastifyInstance } from "fastify";
import {
  createWorkflow, getProjectWorkflows, getWorkflow, getWorkflowGraph,
  setWorkflowState, updateTaskWorkflow, addTaskDependency, createTask,
  getTask, haltTask, getProjectMetrics, appendEvent
} from "../db.js";
import { orchestrate, sendTaskOffer } from "../nodeGateway.js";
import { evaluateWorkflowHealth, executeSupervisorAction } from "../supervisor.js";
import type { RouteDeps } from "./types.js";

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, nodeSockets, broadcastView } = deps;

  app.post<{
    Params: { id: string };
    Body: { title: string; description?: string | null; creatorId?: string };
  }>("/api/projects/:id/workflows", async (req, reply) => {
    const projectId = req.params.id;
    const { title, description, creatorId } = req.body ?? {};
    if (!title || !title.trim()) return reply.code(400).send({ ok: false, error: "title is required" });

    try {
      const workflowId = createWorkflow(db, {
        projectId,
        title: title.trim(),
        description: description ?? null,
        creatorId: creatorId ?? "user",
      });
      appendEvent(db, projectId, null, "workflow.created", { workflowId, title: title.trim() });
      broadcastView();
      return { ok: true, workflowId };
    } catch (err: any) {
      return reply.code(404).send({ ok: false, error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/workflows", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });
    const workflows = getProjectWorkflows(db, projectId);
    return { ok: true, projectId, workflows };
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
    const workflowId = req.params.id;
    const graph = getWorkflowGraph(db, workflowId);
    if (!graph) return reply.code(404).send({ ok: false, error: "workflow not found" });
    return { ok: true, ...graph };
  });

  app.post<{
    Params: { id: string };
    Body: {
      taskId?: string;
      title?: string;
      spec?: string | null;
      agentId?: string | null;
      requiredCapability?: string | null;
      budgetSeconds?: number;
      budgetUsd?: number;
      dependsOn?: string[];
    };
  }>("/api/workflows/:id/tasks", async (req, reply) => {
    const workflowId = req.params.id;
    const wf = getWorkflow(db, workflowId);
    if (!wf) return reply.code(404).send({ ok: false, error: "workflow not found" });

    const { taskId, title, spec, agentId, requiredCapability, budgetSeconds, budgetUsd, dependsOn } = req.body ?? {};

    let effectiveTaskId = taskId;
    if (!effectiveTaskId) {
      if (!title || !title.trim()) {
        return reply.code(400).send({ ok: false, error: "title or taskId required" });
      }
      effectiveTaskId = createTask(db, {
        projectId: wf.project_id,
        title: title.trim(),
        spec: spec ?? null,
        creatorId: wf.creator_id,
        agentId: agentId ?? null,
        requiredCapability: requiredCapability ?? null,
        workflowId,
        budgetSeconds: budgetSeconds ?? 60,
        budgetUsd: budgetUsd ?? 1.0,
      });
    } else {
      const existingTask = getTask(db, effectiveTaskId);
      if (!existingTask) return reply.code(404).send({ ok: false, error: "task not found" });
      if (existingTask.project_id !== wf.project_id) {
        return reply.code(400).send({ ok: false, error: "task and workflow must belong to the same project" });
      }
      updateTaskWorkflow(db, effectiveTaskId, workflowId);
    }

    if (Array.isArray(dependsOn)) {
      for (const depId of dependsOn) {
        const depResult = addTaskDependency(db, effectiveTaskId, depId);
        if (!depResult.ok) {
          return reply.code(400).send({ ok: false, error: depResult.error });
        }
      }
    }

    if (agentId) {
      sendTaskOffer(db, nodeSockets, effectiveTaskId);
    } else {
      orchestrate(db, nodeSockets, app);
    }
    broadcastView();
    return { ok: true, workflowId, taskId: effectiveTaskId };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/pause", async (req, reply) => {
    const workflowId = req.params.id;
    const wf = getWorkflow(db, workflowId);
    if (!wf) return reply.code(404).send({ ok: false, error: "workflow not found" });
    setWorkflowState(db, workflowId, "paused");
    appendEvent(db, wf.project_id, null, "workflow.paused", { workflowId });
    broadcastView();
    return { ok: true, state: "paused" };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/resume", async (req, reply) => {
    const workflowId = req.params.id;
    const wf = getWorkflow(db, workflowId);
    if (!wf) return reply.code(404).send({ ok: false, error: "workflow not found" });
    setWorkflowState(db, workflowId, "active");
    appendEvent(db, wf.project_id, null, "workflow.resumed", { workflowId });
    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { ok: true, state: "active" };
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/cancel", async (req, reply) => {
    const workflowId = req.params.id;
    const wf = getWorkflow(db, workflowId);
    if (!wf) return reply.code(404).send({ ok: false, error: "workflow not found" });
    setWorkflowState(db, workflowId, "canceled");
    const tasks = db.prepare("SELECT id FROM tasks WHERE workflow_id = ? AND state = 'submitted'").all(workflowId) as any[];
    for (const t of tasks) {
      haltTask(db, t.id, "workflow canceled");
    }
    appendEvent(db, wf.project_id, null, "workflow.canceled", { workflowId });
    broadcastView();
    return { ok: true, state: "canceled" };
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/health", async (req, reply) => {
    const workflowId = req.params.id;
    const report = evaluateWorkflowHealth(db, workflowId);
    if (!report) return reply.code(404).send({ ok: false, error: "workflow not found" });
    return { ok: true, ...report };
  });

  app.post<{
    Params: { id: string };
    Body: {
      action: "RETRY" | "REASSIGN" | "PAUSE" | "RESUME" | "CANCEL" | "ESCALATE_HUMAN";
      taskId?: string;
      recommendedAgentId?: string;
      reason: string;
    };
  }>("/api/workflows/:id/supervisor-action", async (req, reply) => {
    const workflowId = req.params.id;
    const body = req.body ?? ({} as any);
    if (!body.action || !body.reason) {
      return reply.code(400).send({ ok: false, error: "action and reason required" });
    }

    const result = executeSupervisorAction(db, workflowId, body);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error });
    }

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { ...result };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/metrics", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const metrics = getProjectMetrics(db, projectId);
    return { ok: true, ...metrics };
  });
}
