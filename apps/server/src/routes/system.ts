import type { FastifyInstance } from "fastify";
import { checkLiveness, checkReadiness } from "../health.js";
import { getSystemMetrics, formatPrometheusMetrics } from "../metrics.js";
import { createDatabaseBackup, verifyDatabaseBackup } from "../backup.js";
import { runRetentionCleanup } from "../retention.js";
import { getProjectGraph, summonAgent, clearSummon, appendEvent } from "../db.js";
import { createTrigger, deleteTrigger, setTriggerEnabled } from "../triggers.js";
import { TriggerCreate, TriggerDelete, TriggerEnable } from "@logbridge/protocol";
import type { RouteDeps } from "./types.js";

export function registerSystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, broadcastView } = deps;

  // Health Probes
  app.get("/health", async () => checkReadiness(db));
  app.get("/health/live", async () => checkLiveness());
  app.get("/health/ready", async () => checkReadiness(db));

  // Operational Metrics
  app.get("/metrics", async (_req, reply) => {
    const metrics = getSystemMetrics(db);
    const text = formatPrometheusMetrics(metrics);
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return text;
  });

  app.get("/api/system/metrics", async () => {
    const metrics = getSystemMetrics(db);
    return { ok: true, ...metrics };
  });

  // Backups & Retention
  app.post<{ Body: { targetPath: string } }>("/api/system/backup", async (req, reply) => {
    const { targetPath } = req.body ?? {};
    if (!targetPath) return reply.code(400).send({ ok: false, error: "targetPath required" });

    const result = await createDatabaseBackup(db, targetPath);
    return result;
  });

  app.post<{ Body: { backupPath: string } }>("/api/system/verify-backup", async (req, reply) => {
    const { backupPath } = req.body ?? {};
    if (!backupPath) return reply.code(400).send({ ok: false, error: "backupPath required" });

    const result = verifyDatabaseBackup(backupPath);
    return { ok: true, ...result };
  });

  app.post<{ Body: { daysToKeep?: number } }>("/api/system/cleanup", async (req) => {
    const days = req.body?.daysToKeep ?? 30;
    const result = runRetentionCleanup(db, days);
    return { ok: true, ...result };
  });

  // Message Graph
  app.get<{ Querystring: { projectId?: string; windowHours?: string } }>("/api/graph", async (req, reply) => {
    const projectId = req.query.projectId ?? "prj_acme_api";
    const windowHours = Number(req.query.windowHours ?? 168);
    const graph = getProjectGraph(db, projectId, windowHours);
    return { ok: true, ...graph };
  });

  // Triggers
  app.post("/api/triggers", async (req, reply) => {
    const parsed = TriggerCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.message });
    }
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(parsed.data.projectId)) {
      return reply.code(404).send({ ok: false, error: `no such project "${parsed.data.projectId}"` });
    }
    const res = createTrigger(db, {
      projectId: parsed.data.projectId,
      name: parsed.data.name,
      kind: parsed.data.kind,
      rule: parsed.data.rule,
      template: {
        title: parsed.data.taskTitle ?? parsed.data.name,
        spec: parsed.data.taskSpec ?? null,
        requiredCapability: parsed.data.taskCapability ?? null,
        budgetSeconds: parsed.data.budgetSeconds ?? undefined,
        budgetUsd: parsed.data.budgetUsd ?? undefined,
      },
      tz: parsed.data.tz ?? undefined,
    });
    if (!res.ok) {
      return reply.code(400).send({ ok: false, error: res.error });
    }
    broadcastView();
    return { ok: true, id: res.id };
  });

  app.post("/api/triggers/enable", async (req, reply) => {
    const parsed = TriggerEnable.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.message });
    }
    const row = db.prepare("SELECT id FROM triggers WHERE id = ?").get(parsed.data.id) as any;
    if (!row) return reply.code(404).send({ ok: false, error: "no such trigger" });
    setTriggerEnabled(db, parsed.data.id, parsed.data.enabled);
    broadcastView();
    return { ok: true };
  });

  app.post("/api/triggers/delete", async (req, reply) => {
    const parsed = TriggerDelete.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.message });
    }
    const row = db.prepare("SELECT id FROM triggers WHERE id = ?").get(parsed.data.id) as any;
    if (!row) return reply.code(404).send({ ok: false, error: "no such trigger" });
    deleteTrigger(db, parsed.data.id);
    broadcastView();
    return { ok: true };
  });

  // Summon
  app.post<{ Body: { agentId: string; x: number; y: number } }>("/api/summon", async (req, reply) => {
    const { agentId, x, y } = req.body as any;
    if (!agentId || typeof x !== "number" || typeof y !== "number") {
      return reply.code(400).send({ ok: false, error: "agentId, x, y are required (tile coords)" });
    }
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(agent.machine_id) as any;
    if (!machine || !machine.online) {
      return reply.code(409).send({ ok: false, error: "agent's machine is offline" });
    }
    if (agent.status !== "idle" && agent.status !== "waiting") {
      return reply.code(409).send({ ok: false, error: `agent is busy (${agent.status}) — only idle agents can be summoned` });
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 64 || y < 0 || y > 46) {
      return reply.code(400).send({ ok: false, error: "position out of bounds" });
    }
    summonAgent(db, agentId, "you", x, y);
    appendEvent(db, agent.project_id, null, "summon", { agentId, agentName: agent.name, by: "you", x, y });
    broadcastView();
    return { ok: true };
  });

  app.post<{ Body: { agentId: string } }>("/api/summon/cancel", async (req, reply) => {
    const { agentId } = req.body as any;
    if (!agentId) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    if (!agent.summoned_by) {
      return reply.code(409).send({ ok: false, error: "agent is not summoned" });
    }
    clearSummon(db, agentId);
    appendEvent(db, agent.project_id, null, "summon.cancel", { agentId, agentName: agent.name, by: "you" });
    broadcastView();
    return { ok: true };
  });
}
