import type { FastifyInstance } from "fastify";
import { deliverTask } from "../agentChannel.js";
import { isAbsolute } from "node:path";
import {
  createTask, getTask, pauseTask, resumeTask, haltTask,
  getTaskTraces, getTaskAttempts, getTaskArtifacts, getProjectArtifacts,
  getArtifact, storeArtifact, getAgentTasks,
  addTaskDependency, removeTaskDependency, getTaskDependencies, getTaskDependents,
  getTaskDependencyStatus, isTaskDependenciesSatisfied,
  candidateAgents, activeTaskCountsByAgent, setRetryPolicy,
  appendEvent
} from "../db.js";
import { orchestrate, sendTaskOffer, taskCancelEnvelope, completeLocalTask } from "../nodeGateway.js";
import { submitPromptToAgent } from "../ptyGateway.js";
import { evaluateAgentCandidates } from "../orchestrator.js";
import { buildAgentContext } from "../contextBuilder.js";
import { listChecks } from "../checks.js";
import type { RouteDeps } from "./types.js";

/** Trim, drop blanks, de-duplicate. A gate field is a set of names, and an
 *  empty string in it would gate the task on an artifact kind that can never
 *  be produced. */
function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

export function registerTaskRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, nodeSockets, broadcastView, hive } = deps;

  // A locally-delivered task (deliverTaskLocally, task-offers.ts) has no
  // automatic completion signal — nothing watches the PTY for "done". This
  // is that signal's manual form: for a human watching the terminal finish,
  // or a UI action later. Without it, the agent stays "working" forever and
  // silently drops every chat instruction sent to it afterward.
  app.post<{ Params: { id: string }; Body: { ok?: boolean } }>(
    "/api/tasks/:id/complete",
    async (req, reply) => {
      const task = getTask(db, req.params.id);
      if (!task) return reply.code(404).send({ ok: false, error: "no such task" });
      const applied = await completeLocalTask(db, nodeSockets, req.params.id, req.body?.ok !== false);
      broadcastView();
      return { ok: applied };
    }
  );

  app.post<{ Body: { agentId: string; title: string; spec?: string; budgetSeconds?: number; budgetUsd?: number } }>(
    "/debug/offer-task",
    async (req, reply) => {
      const { agentId, title, spec, budgetSeconds, budgetUsd } = req.body;
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
      if (!agent) return reply.code(404).send({ error: "no such agent" });

      const taskId = createTask(db, {
        projectId: agent.project_id, title, spec, creatorId: "debug", agentId,
        budgetSeconds, budgetUsd,
      });
      deliverTask(db, nodeSockets, taskId).delivered;
      broadcastView();
      return { ok: true, taskId };
    }
  );

  app.post<{
    Body: { projectId: string; title: string; spec?: string; requiredCapability?: string; budgetSeconds?: number; budgetUsd?: number; agentId?: string };
  }>("/debug/submit-task", async (req, reply) => {
    const { projectId, title, spec, requiredCapability, budgetSeconds, budgetUsd, agentId } = req.body;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return reply.code(404).send({ error: "no such project" });

    const taskId = createTask(db, {
      projectId, title, spec, creatorId: "you", agentId: agentId ?? null,
      requiredCapability: requiredCapability ?? null, budgetSeconds, budgetUsd,
    });
    orchestrate(db, nodeSockets, app);
    broadcastView();
    const assignedTo = (db.prepare("SELECT agent_id FROM tasks WHERE id = ?").get(taskId) as any)?.agent_id ?? null;
    return { ok: true, taskId, assignedTo, queued: assignedTo === null };
  });

  app.post<{ Body: { taskId: string; reason?: string } }>("/debug/stop-task", async (req, reply) => {
    const { taskId, reason } = req.body;
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (!task) return reply.code(404).send({ error: "no such task" });
    const agent = task.agent_id ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any) : null;

    db.prepare("UPDATE tasks SET state = 'canceled', ended_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
    if (agent) db.prepare("UPDATE agents SET status = 'idle', current_task = NULL WHERE id = ?").run(agent.id);
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, 'task.cancel', ?, ?)").run(
      task.project_id, taskId, JSON.stringify({ by: "user", reason: reason ?? null }), new Date().toISOString()
    );

    const socket = agent ? nodeSockets.get(agent.machine_id) : undefined;
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(taskCancelEnvelope(taskId, task.project_id, agent.machine_id, "user", reason ?? null)));
    }
    broadcastView();
    return { ok: true };
  });

  app.post<{
    Body: {
      projectId: string;
      agentId?: string | null;
      title: string;
      spec?: string | null;
      budgetSeconds?: number;
      budgetUsd?: number;
      priority?: string;
      parentTask?: string | null;
      // ★ 1.33 What "done" means for this task.
      //
      // `createTask()` has accepted these since the completion gate was built;
      // this route simply never read them, so every task a HUMAN made bypassed
      // all three gates while planner-made tasks were held to them. The gates
      // were unreachable from the product that contains them.
      expectedOutputs?: string[] | null;
      acceptanceChecks?: string[] | null;
      requiresReview?: boolean;
    };
  }>("/api/tasks", async (req, reply) => {
    const { projectId, agentId, title, spec, budgetSeconds, budgetUsd, parentTask } = req.body ?? {};
    if (!projectId || !title) return reply.code(400).send({ ok: false, error: "projectId and title required" });
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return reply.code(404).send({ ok: false, error: `project "${projectId}" does not exist` });

    let targetAgentId = agentId ?? null;
    if (targetAgentId) {
      const ag = db.prepare("SELECT id, project_id FROM agents WHERE id = ?").get(targetAgentId) as any;
      if (!ag) return reply.code(404).send({ ok: false, error: `agent "${targetAgentId}" not found` });
    }

    const knownChecks = cleanList(req.body?.acceptanceChecks);
    if (knownChecks.length) {
      const defined = new Set(listChecks(db, projectId).map((c) => c.name));
      const unknown = knownChecks.filter((n) => !defined.has(n));
      if (unknown.length) {
        return reply.code(400).send({
          ok: false,
          error: `no check named ${unknown.map((n) => `"${n}"`).join(", ")} in this project — define it first`,
        });
      }
    }

    const taskId = createTask(db, {
      projectId,
      title: title.trim(),
      spec: spec ?? null,
      creatorId: "user",
      agentId: targetAgentId,
      budgetSeconds: budgetSeconds ? Number(budgetSeconds) : 60,
      budgetUsd: budgetUsd ? Number(budgetUsd) : 1.0,
      parentTask: parentTask ?? null,
      expectedOutputs: cleanList(req.body?.expectedOutputs),
      // Validated against the project's OWN checks: a name that does not exist
      // would fail the task at completion for a reason nobody could act on,
      // and the person defining the task is the one who can still fix it.
      acceptanceChecks: knownChecks,
      requiresReview: req.body?.requiresReview === true,
    });

    if (targetAgentId) {
      deliverTask(db, nodeSockets, taskId).delivered;
      const promptText = title.trim() + (spec && spec.trim() ? `\n\n${spec.trim()}` : '');
      try {
        submitPromptToAgent(targetAgentId, promptText);
      } catch {}
    } else {
      orchestrate(db, nodeSockets, app);
    }
    broadcastView();
    return { ok: true, taskId, agentId: targetAgentId };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/pause", async (req, reply) => {
    const taskId = req.params.id;
    const ok = pauseTask(db, taskId);
    if (!ok) return reply.code(404).send({ ok: false, error: "task not found" });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (task?.agent_id) {
      const agent = db.prepare("SELECT machine_id FROM agents WHERE id = ?").get(task.agent_id) as any;
      if (agent?.machine_id) {
        const sock = nodeSockets.get(agent.machine_id);
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: "task_pause", taskId, agentId: task.agent_id }));
        }
      }
    }
    broadcastView();
    return { ok: true, state: "paused" };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (req, reply) => {
    const taskId = req.params.id;
    const ok = resumeTask(db, taskId);
    if (!ok) return reply.code(404).send({ ok: false, error: "task not found" });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (task?.agent_id) {
      const agent = db.prepare("SELECT machine_id FROM agents WHERE id = ?").get(task.agent_id) as any;
      if (agent?.machine_id) {
        const sock = nodeSockets.get(agent.machine_id);
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: "task_resume", taskId, agentId: task.agent_id }));
        }
      }
    }
    broadcastView();
    return { ok: true, state: "in_progress" };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/tasks/:id/halt", async (req, reply) => {
    const taskId = req.params.id;
    const { reason } = req.body ?? {};
    const ok = haltTask(db, taskId, reason);
    if (!ok) return reply.code(404).send({ ok: false, error: "task not found" });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (task?.agent_id) {
      const agent = db.prepare("SELECT machine_id FROM agents WHERE id = ?").get(task.agent_id) as any;
      if (agent?.machine_id) {
        const sock = nodeSockets.get(agent.machine_id);
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: "task_cancel", taskId, agentId: task.agent_id, reason }));
        }
      }
    }
    broadcastView();
    return { ok: true, state: "cancelled" };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/traces", async (req, reply) => {
    const taskId = req.params.id;
    const traces = getTaskTraces(db, taskId);
    return { ok: true, taskId, traces };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/attempts", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });
    const attempts = getTaskAttempts(db, taskId);
    return { ok: true, taskId, attempts };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/artifacts", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });
    const artifacts = getTaskArtifacts(db, taskId);
    return { ok: true, taskId, artifacts };
  });

  app.post<{
    Params: { id: string };
    Body: {
      creatorId?: string;
      attemptId?: string | null;
      kind: string;
      title: string;
      summary?: string | null;
      filePath?: string | null;
    };
  }>("/api/tasks/:id/artifacts", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });
    const { creatorId, attemptId, kind, title, summary, filePath } = req.body ?? {};
    if (!kind || !title) {
      return reply.code(400).send({ ok: false, error: "kind and title are required" });
    }
    if (filePath && (filePath.includes("..") || isAbsolute(filePath))) {
      return reply.code(400).send({ ok: false, error: "filePath must be relative and safe" });
    }
    const artifactId = storeArtifact(db, {
      projectId: task.project_id,
      taskId,
      attemptId: attemptId ?? null,
      creatorId: creatorId ?? "user",
      kind,
      title,
      summary: summary ?? null,
      filePath: filePath ?? null,
    });
    appendEvent(db, task.project_id, taskId, "artifact.created", { artifactId, kind, title });
    return { ok: true, artifactId };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/projects/:id/artifacts", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const artifacts = getProjectArtifacts(db, projectId, limit);
    return { ok: true, projectId, artifacts };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/agents/:id/tasks", async (req, reply) => {
    const agentId = req.params.id;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const tasks = getAgentTasks(db, agentId, limit);
    return { ok: true, agentId, tasks };
  });

  app.post<{
    Params: { id: string };
    Body: { dependsOnTaskId: string };
  }>("/api/tasks/:id/dependencies", async (req, reply) => {
    const taskId = req.params.id;
    const { dependsOnTaskId } = req.body ?? {};
    if (!dependsOnTaskId) return reply.code(400).send({ ok: false, error: "dependsOnTaskId is required" });

    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    const result = addTaskDependency(db, taskId, dependsOnTaskId);
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error });
    }
    appendEvent(db, task.project_id, taskId, "task.dependency_added", { taskId, dependsOnTaskId });
    broadcastView();
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/dependencies", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    const dependencies = getTaskDependencies(db, taskId);
    const dependents = getTaskDependents(db, taskId);
    const status = getTaskDependencyStatus(db, taskId);

    return { ok: true, taskId, dependencies, dependents, status };
  });

  app.delete<{
    Params: { id: string; depId: string };
  }>("/api/tasks/:id/dependencies/:depId", async (req, reply) => {
    const { id: taskId, depId: dependsOnTaskId } = req.params;
    const ok = removeTaskDependency(db, taskId, dependsOnTaskId);
    if (!ok) return reply.code(404).send({ ok: false, error: "dependency link not found" });
    broadcastView();
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: {
      fromAgentId: string;
      toAgentId: string;
      summary: string;
      instructions?: string;
      artifactRefs?: string[];
    };
  }>("/api/tasks/:id/handoff", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    const { fromAgentId, toAgentId, summary, instructions, artifactRefs } = req.body ?? {};
    if (!fromAgentId || !toAgentId || !summary) {
      return reply.code(400).send({ ok: false, error: "fromAgentId, toAgentId, and summary are required" });
    }

    const fromAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(fromAgentId) as any;
    const toAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(toAgentId) as any;
    if (!fromAgent || !toAgent) {
      return reply.code(404).send({ ok: false, error: "one or both agents not found" });
    }

    if (fromAgent.project_id !== task.project_id || toAgent.project_id !== task.project_id) {
      return reply.code(400).send({ ok: false, error: "Cross-project handoffs are forbidden" });
    }

    if (Array.isArray(artifactRefs)) {
      for (const artId of artifactRefs) {
        const art = getArtifact(db, artId);
        if (!art || art.project_id !== task.project_id) {
          return reply.code(400).send({ ok: false, error: `Invalid or cross-project artifact reference "${artId}"` });
        }
      }
    }

    if (hive) {
      try {
        hive.postMessage({
          to: toAgentId,
          act: "request",
          subject: `Handoff: ${task.title}`,
          body: `${summary}\n\n${instructions || ""}\n\n[Task ID: ${taskId}]`,
        }, fromAgentId);
      } catch {}
    }

    appendEvent(db, task.project_id, taskId, "agent.handoff", {
      fromAgentId,
      toAgentId,
      taskId,
      summary,
      instructions: instructions ?? null,
      artifactRefs: artifactRefs ?? [],
    });

    db.prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(toAgentId, taskId);

    if (task.state === "submitted" && isTaskDependenciesSatisfied(db, taskId)) {
      deliverTask(db, nodeSockets, taskId).delivered;
    }
    broadcastView();
    return { ok: true, taskId, handedTo: toAgentId };
  });

  app.post<{
    Params: { id: string };
    Body: {
      reviewerId: string;
      verdict: "approved" | "changes_requested";
      summary: string;
      diffPath?: string | null;
      score?: number | null;
    };
  }>("/api/tasks/:id/review", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    const { reviewerId, verdict, summary, diffPath, score } = req.body ?? {};
    if (!reviewerId || !verdict || !summary) {
      return reply.code(400).send({ ok: false, error: "reviewerId, verdict, and summary are required" });
    }

    if (verdict !== "approved" && verdict !== "changes_requested") {
      return reply.code(400).send({ ok: false, error: "verdict must be 'approved' or 'changes_requested'" });
    }

    const reviewer = db.prepare("SELECT * FROM agents WHERE id = ?").get(reviewerId) as any;
    if (reviewer && reviewer.project_id !== task.project_id) {
      return reply.code(400).send({ ok: false, error: "Reviewer must belong to the same project" });
    }

    const artifactId = storeArtifact(db, {
      projectId: task.project_id,
      taskId: task.id,
      creatorId: reviewerId,
      kind: "review",
      title: `Review: ${verdict === "approved" ? "Approved" : "Changes Requested"}`,
      summary,
      filePath: diffPath ?? null,
    });

    appendEvent(db, task.project_id, taskId, "agent.review_completed", {
      reviewerId,
      verdict,
      summary,
      artifactId,
      score: score ?? null,
    });

    let reworkTaskId: string | null = null;
    if (verdict === "changes_requested") {
      reworkTaskId = createTask(db, {
        projectId: task.project_id,
        title: `[Rework] ${task.title}`,
        spec: `Changes requested by ${reviewerId}:\n\n${summary}\n\nOriginal Spec:\n${task.spec || ""}`,
        creatorId: reviewerId,
        parentTask: task.id,
        retryOf: task.id,
        agentId: task.agent_id,
        workflowId: task.workflow_id,
      });

      addTaskDependency(db, reworkTaskId, task.id);

      if (task.agent_id) {
        deliverTask(db, nodeSockets, reworkTaskId).delivered;
      } else {
        orchestrate(db, nodeSockets, app);
      }
    }

    broadcastView();
    return { ok: true, taskId, verdict, artifactId, reworkTaskId };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/routing-explanation", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    const evt = db
      .prepare(
        "SELECT body FROM events WHERE task_id = ? AND type = 'task.routing_evaluated' ORDER BY seq DESC LIMIT 1"
      )
      .get(taskId) as any;

    if (evt) {
      try {
        const body = JSON.parse(evt.body);
        return { ok: true, taskId, ...body };
      } catch {}
    }

    const candidates = candidateAgents(db, task.project_id);
    const load = activeTaskCountsByAgent(db);
    const evaluation = evaluateAgentCandidates(candidates, load, task.required_capability ?? null);

    return {
      ok: true,
      taskId,
      selectedAgentId: task.agent_id,
      candidates: evaluation.candidates,
      explanation: evaluation.explanation,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { maxChars?: string } }>("/api/tasks/:id/context", async (req, reply) => {
    const taskId = req.params.id;
    const maxChars = req.query.maxChars ? Number(req.query.maxChars) : 8000;
    const contextPayload = buildAgentContext(db, taskId, null, { maxChars });
    if (!contextPayload) return reply.code(404).send({ ok: false, error: "task not found" });
    return { ok: true, ...contextPayload };
  });

  app.post<{
    Params: { id: string };
    Body: { agentId?: string; reason?: string };
  }>("/api/tasks/:id/retry", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    const { agentId, reason } = req.body ?? {};
    const attempts = db.prepare("SELECT * FROM task_attempts WHERE task_id = ?").all(taskId) as any[];

    const retryTaskId = createTask(db, {
      projectId: task.project_id,
      title: `[Retry ${attempts.length + 1}] ${task.title.replace(/^\[Retry \d+\]\s*/, "")}`,
      spec: task.spec,
      creatorId: "human",
      parentTask: task.parent_task || task.id,
      retryOf: task.id,
      agentId: agentId ?? null,
      requiredCapability: task.required_capability,
      workflowId: task.workflow_id,
      budgetSeconds: task.budget_seconds,
      budgetUsd: task.budget_usd,
    });

    appendEvent(db, task.project_id, taskId, "task.retry_scheduled", {
      originalTaskId: taskId,
      retryTaskId,
      attemptNumber: attempts.length + 1,
      assignedAgentId: agentId ?? null,
      reason: reason ?? "Manual operator retry",
    });

    if (agentId) {
      deliverTask(db, nodeSockets, retryTaskId).delivered;
    } else {
      orchestrate(db, nodeSockets, app);
    }

    broadcastView();
    return { ok: true, originalTaskId: taskId, retryTaskId };
  });

  app.post<{
    Params: { id: string };
    Body: {
      taskId?: string | null;
      maxAttempts?: number;
      backoffMs?: number;
      retryOn?: string[];
      preferDifferentAgent?: boolean;
    };
  }>("/api/projects/:id/retry-policy", async (req, reply) => {
    const projectId = req.params.id;
    const { taskId, maxAttempts, backoffMs, retryOn, preferDifferentAgent } = req.body ?? {};

    const policyId = setRetryPolicy(db, {
      projectId,
      taskId: taskId ?? null,
      maxAttempts: maxAttempts ?? 3,
      backoffMs: backoffMs ?? 1000,
      retryOn: (retryOn as any) ?? ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"],
      preferDifferentAgent: preferDifferentAgent ?? true,
    });

    return { ok: true, policyId };
  });
}
