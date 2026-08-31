import type { FastifyInstance } from "fastify";
import {
  createGoal, getGoal, getProjectGoals, setGoalState,
  createPlanRevision, getLatestPlanRevision, getPlanRevision, getPlanRevisions,
  setWorkflowState, appendEvent
} from "../db.js";
import { generatePlanDraft, deriveExecutionWaves, materializePlan } from "../planner.js";
import { analyzePlanImpact, applyPlanRevision } from "../replanning.js";
import { orchestrate } from "../nodeGateway.js";
import type { RouteDeps } from "./types.js";

export function registerGoalRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, nodeSockets, broadcastView } = deps;

  app.post<{
    Params: { id: string };
    Body: { title: string; description?: string; creatorId?: string };
  }>("/api/projects/:id/goals", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const { title, description, creatorId } = req.body ?? {};
    if (!title) return reply.code(400).send({ ok: false, error: "title required" });

    const goalId = createGoal(db, {
      projectId,
      title,
      description: description ?? null,
      creatorId: creatorId ?? "human",
    });

    appendEvent(db, projectId, null, "goal.created", { goalId, title, description });
    broadcastView();
    return { ok: true, goalId };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/goals", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const goals = getProjectGoals(db, projectId);
    return { ok: true, goals };
  });

  app.get<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    const latestRevision = getLatestPlanRevision(db, goalId);
    const revisions = getPlanRevisions(db, goalId);

    return {
      ok: true,
      goal,
      plan: latestRevision
        ? {
            ...latestRevision,
            steps: (() => { try { return JSON.parse(latestRevision.stepsJson); } catch { return []; } })(),
            impactAnalysis: latestRevision.impactAnalysisJson ? JSON.parse(latestRevision.impactAnalysisJson) : null,
          }
        : null,
      revisionsCount: revisions.length,
    };
  });

  app.post<{ Params: { id: string }; Body: { creatorId?: string } }>("/api/goals/:id/generate-plan", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    setGoalState(db, goalId, "planning");
    // The project's folder, so a role it defines under hive/roles/ can be
    // planned against — a plan that names roles the project does not have is
    // a plan nobody can be assigned.
    const folder = (db.prepare(
      "SELECT folder FROM agents WHERE project_id = ? AND folder IS NOT NULL LIMIT 1"
    ).get(goal.projectId) as any)?.folder ?? null;
    const { summary, steps } = generatePlanDraft(goal.title, goal.description, undefined, folder);

    const revisionId = createPlanRevision(db, {
      goalId,
      projectId: goal.projectId,
      state: "awaiting_approval",
      summary,
      steps,
      createdBy: req.body?.creatorId ?? goal.creatorId,
    });

    setGoalState(db, goalId, "awaiting_approval");
    appendEvent(db, goal.projectId, null, "plan.generated", { goalId, revisionId, stepsCount: steps.length });

    broadcastView();
    return { ok: true, goalId, revisionId, summary, steps };
  });

  app.put<{
    Params: { id: string };
    Body: { steps: any[]; summary?: string };
  }>("/api/goals/:id/plan", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    const { steps, summary } = req.body ?? {};
    if (!Array.isArray(steps) || steps.length === 0) {
      return reply.code(400).send({ ok: false, error: "steps array required" });
    }

    const waveResult = deriveExecutionWaves(steps);
    if (waveResult.hasCycle) {
      return reply.code(400).send({ ok: false, error: "cyclical dependencies detected in plan steps" });
    }

    const latest = getLatestPlanRevision(db, goalId);
    let revId: string;
    if (latest && latest.state === "awaiting_approval") {
      db.prepare("UPDATE plan_revisions SET steps_json = ?, summary = ? WHERE id = ?").run(
        JSON.stringify(waveResult.steps),
        summary ?? latest.summary,
        latest.id
      );
      revId = latest.id;
    } else {
      revId = createPlanRevision(db, {
        goalId,
        projectId: goal.projectId,
        state: "awaiting_approval",
        summary: summary ?? "Updated plan draft",
        steps: waveResult.steps,
        createdBy: goal.creatorId,
      });
    }

    setGoalState(db, goalId, "awaiting_approval");
    appendEvent(db, goal.projectId, null, "plan.updated", { goalId, revisionId: revId, stepsCount: waveResult.steps.length });

    broadcastView();
    return { ok: true, goalId, revisionId: revId, steps: waveResult.steps };
  });

  app.post<{ Params: { id: string }; Body: { revisionId?: string; creatorId?: string } }>("/api/goals/:id/plan/approve", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    const revision = req.body?.revisionId
      ? getPlanRevision(db, req.body.revisionId)
      : getLatestPlanRevision(db, goalId);

    if (!revision) return reply.code(400).send({ ok: false, error: "no plan revision available to approve" });

    const materialized = materializePlan(db, goalId, revision.id, req.body?.creatorId ?? goal.creatorId);
    if (!materialized) return reply.code(500).send({ ok: false, error: "failed to materialize plan" });

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { ok: true, goalId, ...materialized };
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/execute", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    if (goal.state === "awaiting_approval" || goal.state === "draft") {
      const revision = getLatestPlanRevision(db, goalId);
      if (!revision) return reply.code(400).send({ ok: false, error: "no plan revision to execute" });
      const materialized = materializePlan(db, goalId, revision.id, goal.creatorId);
      orchestrate(db, nodeSockets, app);
      broadcastView();
      return { ok: true, goalId, ...materialized };
    }

    if (goal.state === "paused") {
      setGoalState(db, goalId, "executing");
      if (goal.workflowId) setWorkflowState(db, goal.workflowId, "active");
      orchestrate(db, nodeSockets, app);
      broadcastView();
      return { ok: true, goalId, state: "executing" };
    }

    return { ok: true, goalId, state: goal.state };
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/pause", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    setGoalState(db, goalId, "paused");
    if (goal.workflowId) setWorkflowState(db, goal.workflowId, "paused");
    appendEvent(db, goal.projectId, null, "goal.paused", { goalId });

    broadcastView();
    return { ok: true, goalId, state: "paused" };
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/resume", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    setGoalState(db, goalId, "executing");
    if (goal.workflowId) setWorkflowState(db, goal.workflowId, "active");
    appendEvent(db, goal.projectId, null, "goal.resumed", { goalId });

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { ok: true, goalId, state: "executing" };
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/cancel", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    setGoalState(db, goalId, "canceled");
    if (goal.workflowId) setWorkflowState(db, goal.workflowId, "canceled");
    appendEvent(db, goal.projectId, null, "goal.canceled", { goalId });

    broadcastView();
    return { ok: true, goalId, state: "canceled" };
  });

  app.get<{ Params: { id: string }; Querystring: { failedTaskId?: string } }>("/api/goals/:id/impact", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    const impact = analyzePlanImpact(db, goalId, req.query?.failedTaskId);
    if (!impact) return reply.code(400).send({ ok: false, error: "failed to analyze impact" });
    return { ok: true, ...impact };
  });

  app.post<{
    Params: { id: string };
    Body: { optionId: string; creatorId?: string };
  }>("/api/goals/:id/replan", async (req, reply) => {
    const goalId = req.params.id;
    const goal = getGoal(db, goalId);
    if (!goal) return reply.code(404).send({ ok: false, error: "goal not found" });

    const { optionId, creatorId } = req.body ?? {};
    if (!optionId) return reply.code(400).send({ ok: false, error: "optionId required" });

    setGoalState(db, goalId, "replanning");
    const result = applyPlanRevision(db, goalId, optionId, creatorId ?? goal.creatorId);
    if (!result) return reply.code(500).send({ ok: false, error: "failed to apply plan revision" });

    orchestrate(db, nodeSockets, app);
    broadcastView();
    return { ok: true, goalId, ...result };
  });
}
