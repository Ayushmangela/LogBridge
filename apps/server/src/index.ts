import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, normalize, relative, resolve } from "node:path";
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, scryptSync } from "node:crypto";
import type { WebSocket } from "ws";
import {
  appendEvent, clearSummon, createTask, openDb, summonAgent,
  setAgentPaused, setAgentRetired, deleteAgent,
  setAgentSteer, getAgentHistory, moveAgent, cloneAgent,
  getAgentTraces, getAgentOutput, getProjectGraph,
  pauseTask, resumeTask, haltTask, getAgentTasks, getTaskTraces,
  getTask, getTaskAttempts, getTaskArtifacts, getProjectArtifacts, getArtifact, storeArtifact,
  createWorkflow, getWorkflow, getProjectWorkflows, setWorkflowState, updateTaskWorkflow,
  getWorkflowGraph, addTaskDependency, removeTaskDependency, getTaskDependencies, getTaskDependents,
  getTaskDependencyStatus, isTaskDependenciesSatisfied,
  getAgentMetrics, getProjectMetrics, getRetryPolicy, setRetryPolicy, classifyFailure,
  candidateAgents, activeTaskCountsByAgent,
  createGoal, getGoal, getProjectGoals, setGoalState,
  createPlanRevision, getPlanRevision, getLatestPlanRevision, getPlanRevisions, setPlanRevisionState,
  getProjectMembers, setProjectMember, removeProjectMember, getUserProjectRole,
  type Db
} from "./db.js";
import { evaluateAgentCandidates } from "./orchestrator.js";
import { buildAgentContext } from "./contextBuilder.js";
import { evaluateWorkflowHealth, executeSupervisorAction } from "./supervisor.js";
import { generatePlanDraft, deriveExecutionWaves, materializePlan } from "./planner.js";
import { analyzePlanImpact, applyPlanRevision } from "./replanning.js";
import { hasPermission, assertPermission } from "./authorization.js";
import { evaluatePolicy } from "./policyEngine.js";
import { createApprovalRequest, getApprovalRequest, getProjectApprovals, resolveApprovalRequest } from "./approvals.js";
import { recordAuditLog, getProjectAuditLogs } from "./audit.js";
import { createEscalation, resolveEscalation, getProjectEscalations } from "./escalations.js";
import { checkLiveness, checkReadiness } from "./health.js";
import { recoverServerState } from "./recovery.js";
import { moveToDeadLetter, getProjectDeadLetters, reprocessDeadLetter } from "./deadLetter.js";
import { checkDispatchConcurrency } from "./concurrency.js";
import { rateLimiter } from "./rateLimit.js";
import { getSystemMetrics, formatPrometheusMetrics } from "./metrics.js";
import { runRetentionCleanup } from "./retention.js";
import { createDatabaseBackup, verifyDatabaseBackup } from "./backup.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { issueCfp, submitProposal, resolveContractNet } from "./communication/contractNet.js";
import { delegateHandoff } from "./communication/handoff.js";
import { processReviewResult } from "./communication/review.js";
import { getProjectSequenceFlow, getTaskSequenceFlow, emitSequenceEvent } from "./communication/sequenceEvents.js";
import { Positions } from "./view.js";
import { registerCommandRoutes } from "./commands.js";
import { registerGateway } from "./gateway.js";
import {
  orchestrate, registerNodeGateway, requestAgentCreate,
  sendTaskOffer, taskCancelEnvelope, requestAgentGit,
  type NodeSockets
} from "./nodeGateway.js";
import { createTrigger, deleteTrigger, setTriggerEnabled, startEventLoop, startTriggerLoop } from "./triggers.js";
import { TriggerCreate, TriggerDelete, TriggerEnable } from "@logbridge/protocol";
import { registerPtyGateway, spawnOrGetPtySession, submitPromptToAgent } from "./ptyGateway.js";
import { HiveManager, ensureProjectHive, registerAgentInProjectHive } from "./hive.js";
import { buildCommanderHivePrompt } from "./hivePrompt.js";

export interface BuiltServer {
  app: ReturnType<typeof Fastify>;
  db: Db;
  nodeSockets: NodeSockets;
  browserSockets: Set<WebSocket>;
  hive: HiveManager;
}

// Exported so integration tests can boot the real server in-process — same
// registration path production uses, just not listening on a fixed port
// with a fixed db file. See apps/runner's wifiDrop.test.ts.
export async function buildServer(
  opts: { dbPath?: string; leaseSeconds?: number; sweepIntervalMs?: number; consentTimeoutMs?: number } = {}
): Promise<BuiltServer> {
  const db = openDb(opts.dbPath);
  const positions = new Positions();
  const browserSockets = new Set<WebSocket>();
  const nodeSockets: NodeSockets = new Map();

  const isTest = opts.dbPath === ":memory:";
  const hiveHome = isTest
    ? join(tmpdir(), ".test-hive-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))
    : process.env.HIVE_HOME || join(process.env.HOME || "", "workspace", "hive");

  let broadcastViewRef: (() => void) | null = null;
  const hive = new HiveManager(
    hiveHome,
    (ev) => {
      const payload = JSON.stringify({ type: "hive:event", event: ev });
      for (const ws of browserSockets) {
        if (ws.readyState === ws.OPEN) {
          ws.send(payload);
        }
      }
      if (ev.kind === "meeting" || ev.kind === "message" || ev.kind === "task") {
        try { broadcastViewRef?.(); } catch {}
      }
    },
    (msg, fromId, toId) => {
      try {
        const sender = db.prepare("SELECT * FROM agents WHERE id = ?").get(fromId) as any;
        const receiver = db.prepare("SELECT * FROM agents WHERE id = ?").get(toId) as any;
        const projectId = sender?.project_id || receiver?.project_id || (db.prepare("SELECT id FROM projects LIMIT 1").get() as any)?.id || "prj_main";

        emitSequenceEvent(db, {
          projectId,
          type: msg.act === "request" ? "delegation_offer" : (msg.act === "done" ? "handoff_completed" : "info_share"),
          source: { type: "agent", id: fromId, label: sender?.name || fromId },
          target: { type: "agent", id: toId, label: receiver?.name || toId },
          summary: `[${msg.act.toUpperCase()}] ${msg.subject || msg.body?.slice(0, 80) || "Hive message"}`,
          metadata: msg,
        });

        // Automatically wake up recipient agent terminal to execute the assigned task!
        const wakeText = `New task assigned from ${sender?.name || fromId}: "${msg.subject || 'Task'}". Details: ${msg.body || 'Execute assigned task'}. Read your inbox and memory, then start work immediately.`;
        submitPromptToAgent(toId, wakeText);
      } catch {}
    }
  );

  if (process.env.NODE_ENV !== "test" || opts.dbPath !== ":memory:") {
    try {
      const projects = db.prepare("SELECT gh_repo FROM projects").all() as any[];
      for (const p of projects) {
        if (p.gh_repo && existsSync(p.gh_repo)) {
          hive.registerProjectRoot(p.gh_repo);
        }
      }
    } catch {}
    hive.startRouter(1500);
  }

  // Sync existing agents to hive
  try {
    const agents = db.prepare("SELECT * FROM agents").all() as any[];
    for (const a of agents) {
      hive.registerAgent({
        id: a.id,
        name: a.name,
        role: a.role,
        provider: a.provider,
        model: a.model,
        folder: a.folder,
        isGod: a.role === "orchestrator" || a.name === "Michael" || a.name === "michael",
      });
    }
  } catch {}

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.addHook("onClose", async () => {
    hive.stopRouter();
    if (isTest) {
      try { rmSync(hiveHome, { recursive: true, force: true }); } catch {}
    }
  });

  await app.register(websocket);

  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets"),
    prefix: "/assets/",
    decorateReply: false,
  });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    decorateReply: true,
  });
  app.get("/", async (_req, reply) => reply.sendFile("index.html"));

  const { broadcastView, broadcastChat } = registerGateway(app, db, positions, browserSockets, nodeSockets, hive);
  broadcastViewRef = broadcastView;
  registerNodeGateway(app, db, nodeSockets, broadcastView, {
    leaseSeconds: opts.leaseSeconds,
    sweepIntervalMs: opts.sweepIntervalMs,
    onChat: broadcastChat,
    consentTimeoutMs: opts.consentTimeoutMs,
  });
  registerPtyGateway(app, db, hive);

  // ---------------------------------------------------------------------
  // DEV ONLY: stand-in for the chat / task-creation UI that doesn't exist
  // yet (SYSTEM.md §5, Phase 2). Not part of the product surface — no auth,
  // do not expose this off localhost/tailnet.
  // ---------------------------------------------------------------------

  // Static reference data, deliberately not in the workspace view — see
  // commands.ts for why.
  registerCommandRoutes(app);

  // ---- agent lifecycle routes (HANDOFF-SERVER-2 Phase 1) ----
  const handleAgentEdit = async (agentId: string, body: any, reply: any) => {
    if (!agentId) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const updates: string[] = [];
    const vals: any[] = [];
    if (body.name !== undefined) {
      updates.push("name = ?");
      vals.push(String(body.name).trim().slice(0, 200));
    }
    if (body.description !== undefined) {
      updates.push("description = ?");
      vals.push(body.description ? String(body.description).trim().slice(0, 120) : null);
    }
    if (body.goal !== undefined) {
      updates.push("goal = ?");
      vals.push(body.goal ? String(body.goal).trim().slice(0, 2000) : null);
    }
    if (body.character !== undefined) {
      updates.push("character = ?");
      vals.push(body.character ?? null);
    }
    if (body.color !== undefined) {
      updates.push("color = ?");
      vals.push(body.color ?? null);
    }
    if (body.role !== undefined) {
      updates.push("role = ?");
      vals.push(body.role ?? "developer");
    }
    if (body.note !== undefined) {
      updates.push("note = ?");
      vals.push(body.note ? String(body.note).trim().slice(0, 120) : null);
    }
    if (body.capabilities !== undefined) {
      updates.push("capabilities = ?");
      vals.push(JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities : []));
    }
    if (updates.length === 0) return reply.code(400).send({ ok: false, error: "no fields to update" });
    vals.push(agentId);
    db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
    broadcastView();
    return { ok: true };
  };

  app.patch<{ Params: { id: string }; Body: any }>("/api/agents/:id", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentEdit(id, req.body ?? {}, reply);
  });

  app.post<{ Params: { id: string }; Body: any }>("/api/agents/:id/edit", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentEdit(id, req.body ?? {}, reply);
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/api/agents/:id/note", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 120) : null;
    db.prepare("UPDATE agents SET note = ? WHERE id = ?").run(note, id);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentPaused(db, id, true);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentPaused(db, id, false);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/retire", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentRetired(db, id, true);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/unretire", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentRetired(db, id, false);
    broadcastView();
    return { ok: true };
  });

  const handleAgentDelete = async (agentId: string, reply: any) => {
    if (!agentId) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    deleteAgent(db, agentId);
    broadcastView();
    return { ok: true };
  };

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentDelete(id, reply);
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/delete", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentDelete(id, reply);
  });

  // ---- Phase 2: Per-agent history (HANDOFF-SERVER-2 Phase 2) ----
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/agents/:id/history",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
      const limit = Number(req.query.limit ?? 20);
      const offset = Number(req.query.offset ?? 0);
      const history = getAgentHistory(db, id, limit, offset);
      return { ok: true, ...history };
    }
  );

  // ---- Phase 3: Steer, Move, Clone (HANDOFF-SERVER-2 Phase 3) ----
  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/agents/:id/steer", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const { text } = req.body ?? {};
    if (!text || typeof text !== "string") return reply.code(400).send({ ok: false, error: "text required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });

    setAgentSteer(db, id, text);

    // Check if agent is currently running an active task
    const activeTask = db.prepare("SELECT * FROM tasks WHERE agent_id = ? AND state IN ('in_progress', 'accepted', 'working')").get(id) as any;
    if (activeTask) {
      appendEvent(db, agent.project_id, activeTask.id, "task_steer", {
        agentId: id,
        taskId: activeTask.id,
        text,
        at: new Date().toISOString(),
      });
      if (agent.machine_id) {
        const sock = nodeSockets.get(agent.machine_id);
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: "steer", agentId: id, taskId: activeTask.id, text }));
        }
      }
    }

    broadcastView();
    return { ok: true, steered: true, mode: activeTask ? "live" : "next_task", taskId: activeTask?.id ?? null };
  });

  app.post<{ Params: { id: string }; Body: { projectId: string } }>("/api/agents/:id/move", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const { projectId } = req.body ?? {};
    if (!projectId) return reply.code(400).send({ ok: false, error: "projectId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const moved = moveAgent(db, id, projectId);
    if (!moved) return reply.code(404).send({ ok: false, error: `project "${projectId}" does not exist` });
    broadcastView();
    return { ok: true, agentId: id, projectId };
  });

  app.post<{ Params: { id: string }; Body: { projectId: string; name?: string } }>("/api/agents/:id/clone", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const { projectId, name } = req.body ?? {};
    if (!projectId) return reply.code(400).send({ ok: false, error: "projectId required" });
    const cloned = cloneAgent(db, id, projectId, name);
    if (!cloned) return reply.code(404).send({ ok: false, error: "could not clone agent — check agent and project exist" });
    broadcastView();
    return { ok: true, agent: cloned };
  });

  // ---- Phase 4: Traces (HANDOFF-SERVER-3 Phase 4) ----
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/agents/:id/traces", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const limit = Number(req.query.limit ?? 50);
    const traces = getAgentTraces(db, id, limit);
    return { ok: true, agentId: id, traces, events: traces };
  });

  // ---- Phase 5: Output stream (HANDOFF-SERVER-3 Phase 5) ----
  app.get<{ Params: { id: string }; Querystring: { limit?: string; since?: string } }>(
    "/api/agents/:id/output",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
      const limit = Number(req.query.limit ?? 200);
      const since = req.query.since ? Number(req.query.since) : undefined;
      const res = getAgentOutput(db, id, limit, since);
      return { ok: true, ...res, lines: res.output };
    }
  );

  // ---- Phase 6: Git state (HANDOFF-SERVER-3 Phase 6) ----
  app.get<{ Params: { id: string } }>("/api/agents/:id/git", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const gitState = await requestAgentGit(db, nodeSockets, id);
    return gitState;
  });

  // ---- Agent Code & Workspace Files (matching munder-difflin IDE / FilesTab) ----
  const resolveAgentCwd = (agentId: string): string => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    let cwd = agent?.folder || agent?.cwd || process.cwd();
    if (typeof cwd === "string" && cwd.startsWith("~/")) {
      cwd = (process.env.HOME || "") + cwd.slice(1);
    }
    if (!existsSync(cwd)) {
      try { mkdir(cwd, { recursive: true }); } catch {}
      if (!existsSync(cwd)) cwd = process.cwd();
    }
    return resolve(cwd);
  };

  const safeJoin = (root: string, rel: string): string | null => {
    const absRoot = resolve(root);
    const absPath = isAbsolute(rel) ? normalize(rel) : resolve(absRoot, rel);
    const rel2 = relative(absRoot, absPath);
    if (rel2.startsWith("..") || isAbsolute(rel2)) return null;
    return absPath;
  };

  app.get<{ Params: { id: string }; Querystring: { dir?: string } }>(
    "/api/agents/:id/files",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const root = resolveAgentCwd(id);
      const relDir = req.query.dir || "";
      const absDir = safeJoin(root, relDir);
      if (!absDir) return reply.code(400).send({ ok: false, error: "path escapes root" });
      try {
        const names = await readdir(absDir);
        const entries = await Promise.all(
          names
            .filter((n) => !n.startsWith(".git") && n !== "node_modules")
            .map(async (name) => {
              try {
                const s = await stat(join(absDir, name));
                return {
                  name,
                  isDir: s.isDirectory(),
                  size: s.size,
                  mtime: s.mtimeMs,
                  relPath: relDir ? `${relDir}/${name}` : name,
                };
              } catch {
                return { name, isDir: false, size: 0, mtime: 0, relPath: relDir ? `${relDir}/${name}` : name };
              }
            })
        );
        entries.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { ok: true, root, rel: relDir, entries };
      } catch (err: any) {
        return reply.code(500).send({ ok: false, error: err?.message || String(err) });
      }
    }
  );

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/agents/:id/file",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const rel = req.query.path;
      if (!rel) return reply.code(400).send({ ok: false, error: "path parameter required" });
      const root = resolveAgentCwd(id);
      const absPath = safeJoin(root, rel);
      if (!absPath) return reply.code(400).send({ ok: false, error: "path escapes root" });
      try {
        const content = await readFile(absPath, "utf-8");
        return { ok: true, path: rel, content, size: content.length };
      } catch (err: any) {
        return reply.code(404).send({ ok: false, error: err?.message || "file not found" });
      }
    }
  );

  app.post<{ Params: { id: string }; Body: { path: string; content: string } }>(
    "/api/agents/:id/file",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const { path: rel, content } = req.body ?? {};
      if (!rel || content === undefined) {
        return reply.code(400).send({ ok: false, error: "path and content required" });
      }
      const root = resolveAgentCwd(id);
      const absPath = safeJoin(root, rel);
      if (!absPath) return reply.code(400).send({ ok: false, error: "path escapes root" });
      try {
        await writeFile(absPath, content, "utf-8");
        return { ok: true, path: rel, size: content.length };
      } catch (err: any) {
        return reply.code(500).send({ ok: false, error: err?.message || "failed to write file" });
      }
    }
  );

  // ---- Phase 7: Engine swap (HANDOFF-SERVER-4 Phase 7) ----
  app.post<{ Params: { id: string }; Body: { provider: string; model?: string | null } }>(
    "/api/agents/:id/engine",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const { provider, model } = req.body ?? {};
      if (!provider) return reply.code(400).send({ ok: false, error: "provider required" });
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
      db.prepare("UPDATE agents SET provider = ?, model = ? WHERE id = ?").run(provider, model ?? null, id);
      broadcastView();
      return { ok: true, restarting: true, message: "Restarting — engine will change on next heartbeat." };
    }
  );

  // ---- Phase 8: Message Graph (HANDOFF-SERVER-4 Phase 8) ----
  app.get<{ Querystring: { projectId?: string; windowHours?: string } }>("/api/graph", async (req, reply) => {
    const projectId = req.query.projectId ?? "prj_acme_api";
    const windowHours = Number(req.query.windowHours ?? 168);
    const graph = getProjectGraph(db, projectId, windowHours);
    return { ok: true, ...graph };
  });

  // Triggers: schedule and event loops — real tasks from standing rules.
  // Started here, like github's poll, so a task appears in the DB and the
  // office notices (firing pushes a view). Unref so they don't keep tests alive.
  const triggerLoop = startTriggerLoop(db, { onChange: broadcastView });
  const eventLoop = startEventLoop(db, { onChange: broadcastView });
  app.addHook("onClose", async () => {
    triggerLoop.stop();
    eventLoop.stop();
  });

  // ---- Triggers — create, enable/disable, delete (Phase 1, the wire) ----
  app.post("/api/triggers", async (req, reply) => {
    const parsed = TriggerCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.message });
    }
    // Project must exist, or the task would be orphaned and invisible
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
      // Parser's own message, 4xx — not a 500. It was written to be read.
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
      sendTaskOffer(db, nodeSockets, taskId);
      broadcastView();
      return { ok: true, taskId };
    }
  );

  // Submit work WITHOUT naming an agent — the orchestrator decides who runs
  // it, or queues it until someone can. See ORCHESTRATOR.md.
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

  // ---- Agent Task Management & Dispatch API ----
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

    const taskId = createTask(db, {
      projectId,
      title: title.trim(),
      spec: spec ?? null,
      creatorId: "user",
      agentId: targetAgentId,
      budgetSeconds: budgetSeconds ? Number(budgetSeconds) : 60,
      budgetUsd: budgetUsd ? Number(budgetUsd) : 1.0,
      parentTask: parentTask ?? null,
    });

    if (targetAgentId) {
      sendTaskOffer(db, nodeSockets, taskId);
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
    // Path traversal safety
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

  // ─── Workflows (Phase 2) ──────────────────────────────────────────

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
    // Cancel any submitted tasks in this workflow
    const tasks = db.prepare("SELECT id FROM tasks WHERE workflow_id = ? AND state = 'submitted'").all(workflowId) as any[];
    for (const t of tasks) {
      haltTask(db, t.id, "workflow canceled");
    }
    appendEvent(db, wf.project_id, null, "workflow.canceled", { workflowId });
    broadcastView();
    return { ok: true, state: "canceled" };
  });

  // ─── Task Dependencies (Phase 2) ──────────────────────────────────

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

  // ─── Agent Handoffs & Reviews (Phase 2) ────────────────────────────

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

    // Verify any referenced artifacts belong to this project
    if (Array.isArray(artifactRefs)) {
      for (const artId of artifactRefs) {
        const art = getArtifact(db, artId);
        if (!art || art.project_id !== task.project_id) {
          return reply.code(400).send({ ok: false, error: `Invalid or cross-project artifact reference "${artId}"` });
        }
      }
    }

    // Post to recipient's Hive mailbox
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

    // Append handoff event
    appendEvent(db, task.project_id, taskId, "agent.handoff", {
      fromAgentId,
      toAgentId,
      taskId,
      summary,
      instructions: instructions ?? null,
      artifactRefs: artifactRefs ?? [],
    });

    // Re-assign task to recipient
    db.prepare("UPDATE tasks SET agent_id = ? WHERE id = ?").run(toAgentId, taskId);

    // If task is ready, dispatch to recipient runner
    if (task.state === "submitted" && isTaskDependenciesSatisfied(db, taskId)) {
      sendTaskOffer(db, nodeSockets, taskId);
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

    // Store review artifact
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
      // Spawn follow-up rework task linked via parent_task & retry_of
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

      // Link dependency so the rework task depends on the review conclusion
      addTaskDependency(db, reworkTaskId, task.id);

      if (task.agent_id) {
        sendTaskOffer(db, nodeSockets, reworkTaskId);
      } else {
        orchestrate(db, nodeSockets, app);
      }
    }

    broadcastView();
    return { ok: true, taskId, verdict, artifactId, reworkTaskId };
  });

  // ─── Phase 3: Intelligence, Routing, Context & Supervisor ──────────

  app.get<{ Params: { id: string } }>("/api/agents/:id/profile", async (req, reply) => {
    const agentId = req.params.id;
    const profile = getAgentMetrics(db, agentId);
    if (!profile) return reply.code(404).send({ ok: false, error: "agent not found" });
    return { ok: true, profile };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/routing-explanation", async (req, reply) => {
    const taskId = req.params.id;
    const task = getTask(db, taskId);
    if (!task) return reply.code(404).send({ ok: false, error: "task not found" });

    // Check if event log already recorded the routing evaluation
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

    // Otherwise compute live evaluation
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
      sendTaskOffer(db, nodeSockets, retryTaskId);
    } else {
      orchestrate(db, nodeSockets, app);
    }

    broadcastView();
    return { ok: true, originalTaskId: taskId, retryTaskId };
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
    return { ok: true, ...result };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/metrics", async (req, reply) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) return reply.code(404).send({ ok: false, error: "project not found" });

    const metrics = getProjectMetrics(db, projectId);
    return { ok: true, ...metrics };
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

  // ─── Phase 4: Autonomous Teams, Planning & Dynamic Replanning ──────

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
    const { summary, steps } = generatePlanDraft(goal.title, goal.description);

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

  // ─── Phase 5: Human Collaboration, Approvals, Governance & Permissions ─

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
    return { ok: true, approvalId, ...result };
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
    return { ok: true, approvalId, ...result };
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

  // ─── Phase 6: Production Reliability, Health, Metrics & Ops ────────

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
    return { ok: true, deadLetterId, ...result };
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

  // ─── Contract Net Protocol, Handoffs & Sequence Events ──────────────

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
      return { ok: true, ...result };
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

  // Create an agent on a machine, from the browser. This is NOT a debug
  // endpoint: it starts a real CLI on someone's machine. The machine gates
  // it (runner refuses unless started with --allow-agent-creation) — the
  // server only routes and relays the verdict. See HANDOFF.md prompt 1.
  app.post<{
    Body: {
      machineId: string; projectId: string; name: string; role?: string;
      provider?: string | null; model?: string | null; capabilities?: string[];
      cwd?: string | null; allowTools?: string[]; denyPaths?: string[];
      character?: string | null; color?: string | null; folder?: string | null;
      isolation?: "shared" | "worktree" | "copy" | null;
      description?: string | null; goal?: string | null;
      bypassPermissions?: boolean;
    };
  }>("/api/agents", async (req, reply) => {
    const b = req.body;
    if (!b?.machineId || !b?.projectId || !b?.name) {
      return reply.code(400).send({ error: "machineId, projectId and name are required" });
    }
    // Presence isn't enough. An agent created against a project that doesn't
    // exist is orphaned: registered on the runner, in no room, unable to
    // receive work — and invisible, so nobody notices it failed.
    if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(b.projectId)) {
      return reply.code(404).send({ ok: false, agentId: null, error: `no such project "${b.projectId}"` });
    }
    const proj = db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(b.projectId) as any;
    const commanderAgent = db.prepare("SELECT folder FROM agents WHERE project_id = ? AND (role = 'planner' OR role = 'orchestrator' OR name LIKE '%commander%') LIMIT 1").get(b.projectId) as any;
    let targetFolder = b.folder || commanderAgent?.folder;
    if (!targetFolder && proj?.gh_repo) {
      if (existsSync(proj.gh_repo)) {
        targetFolder = proj.gh_repo;
      } else {
        const candidate = join(process.env.HOME || "", "project_test", proj.gh_repo);
        if (existsSync(candidate)) targetFolder = candidate;
      }
    }
    const validFolder = targetFolder && existsSync(targetFolder) ? targetFolder : null;

    const result = await requestAgentCreate(db, nodeSockets, {
      machineId: b.machineId,
      projectId: b.projectId,
      name: String(b.name).slice(0, 64),
      role: b.role ?? "developer",
      provider: b.provider ?? null,
      model: b.model ?? null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities : [],
      cwd: b.cwd || validFolder || null,
      character: b.character ?? null,
      color: b.color ?? null,
      folder: b.folder || validFolder || null,
      isolation: b.isolation ?? null,
      bypassPermissions: Boolean(b.bypassPermissions),
      // Trimmed and capped here rather than in the browser — a request can
      // arrive from anything, not just our own dialog.
      description: b.description ? String(b.description).trim().slice(0, 120) : null,
      goal: b.goal ? String(b.goal).trim().slice(0, 2000) : null,
      allowTools: Array.isArray(b.allowTools) ? b.allowTools : [],
      denyPaths: Array.isArray(b.denyPaths) ? b.denyPaths : [],
    });
    broadcastView(); // success path already published a card; refresh either way
    if (result.ok && result.agentId) {
      if (targetFolder && existsSync(targetFolder)) {
        try {
          registerAgentInProjectHive(targetFolder, {
            id: result.agentId,
            name: String(b.name).slice(0, 64),
            role: b.role ?? "developer",
            provider: b.provider ?? "cli",
            model: b.model ?? "default",
          });
        } catch {}
      }

      hive.registerAgent({
        id: result.agentId,
        name: String(b.name).slice(0, 64),
        role: b.role ?? "developer",
        provider: b.provider ?? "cli",
        model: b.model ?? "default",
        folder: targetFolder,
      });

      const ptyName = 'pty-' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + result.agentId.slice(-8);
      try {
        spawnOrGetPtySession(db, ptyName, result.agentId, 100, 30, hive);
      } catch {}
    }
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  // ---------------- summon (HANDOFF-PRESENCE Phase 4) ----------------
  // Real event, not a local tween — goes through the server so every
  // browser sees it, and lands in the activity feed. Work always wins:
  // setAgentStatus clears the summon the moment the agent gets a task.
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
    // Only idle (and waiting which maps to idle zone) can be summoned — a
    // working/reviewing/blocked agent is busy and must fail with a readable
    // reason rather than silently doing nothing.
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

  // M6: GitHub mirror. Off unless configured — needs a READ-ONLY PAT
  // (D10: the server never writes to anyone's repos) and an explicit repo
  // list. Polls with ETags (D9), so the quota cost is near zero when quiet.
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOS) {
    const repos = process.env.GITHUB_REPOS.split(",").map((r) => r.trim()).filter(Boolean);
    const gh = await import("./github.js");
    gh.startGithubMirror(db, {
      token: process.env.GITHUB_TOKEN,
      repos,
      intervalMs: Number(process.env.GITHUB_POLL_MS ?? 60_000),
      onChange: broadcastView,
      log: (m) => app.log.warn(m),
    });
    app.log.info(`github mirror running for: ${repos.join(", ")}`);
  }

  // ─── Hive Multi-Agent Endpoints (Antigravity architecture) ──────
  app.get("/api/hive/roster", async () => {
    return hive.getRegistry();
  });

  app.get("/api/hive/board", async () => {
    return { content: hive.getBoard() };
  });

  app.post("/api/hive/board", async (req, reply) => {
    const body = req.body as any;
    if (typeof body?.content !== "string") return reply.code(400).send({ error: "content required" });
    hive.setBoard(body.content, body.authorId);
    return { ok: true, content: body.content };
  });

  app.get("/api/hive/tasks", async (req) => {
    const q = req.query as any;
    const projectId = q?.projectId;
    const agentId = q?.agentId;
    if (projectId) {
      const proj = db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(projectId) as any;
      if (proj?.gh_repo) {
        const pTasksPath = join(proj.gh_repo, "hive", "tasks.json");
        if (existsSync(pTasksPath)) {
          try {
            const data = JSON.parse(readFileSync(pTasksPath, "utf8"));
            return { tasks: data.tasks || [] };
          } catch {}
        }
      }
    }
    if (agentId) {
      const agt = db.prepare("SELECT folder, project_id FROM agents WHERE id = ?").get(agentId) as any;
      const targetFolder = agt?.folder || (agt?.project_id ? (db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(agt.project_id) as any)?.gh_repo : null);
      if (targetFolder) {
        const pTasksPath = join(targetFolder, "hive", "tasks.json");
        if (existsSync(pTasksPath)) {
          try {
            const data = JSON.parse(readFileSync(pTasksPath, "utf8"));
            return { tasks: data.tasks || [] };
          } catch {}
        }
      }
    }
    return { tasks: hive.getTasks() };
  });

  app.post("/api/hive/tasks", async (req, reply) => {
    const body = req.body as any;
    if (!body?.title) return reply.code(400).send({ error: "title required" });
    const task = hive.upsertTask(body);

    const projectId = body?.projectId;
    if (projectId) {
      const proj = db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(projectId) as any;
      if (proj?.gh_repo) {
        const pTasksPath = join(proj.gh_repo, "hive", "tasks.json");
        try {
          let tasksObj: { tasks: any[] } = { tasks: [] };
          if (existsSync(pTasksPath)) {
            tasksObj = JSON.parse(readFileSync(pTasksPath, "utf8"));
          }
          if (!Array.isArray(tasksObj.tasks)) tasksObj.tasks = [];
          const idx = tasksObj.tasks.findIndex((t: any) => t.id === task.id);
          if (idx >= 0) tasksObj.tasks[idx] = task;
          else tasksObj.tasks.push(task);
          writeFileSync(pTasksPath, JSON.stringify(tasksObj, null, 2), "utf8");
        } catch {}
      }
    }

    return { ok: true, task };
  });

  app.get("/api/hive/messages", async (req, reply) => {
    const q = req.query as any;
    const agentId = q.agentId;
    if (!agentId) return reply.code(400).send({ error: "agentId required" });
    return hive.getAgentMessages(agentId);
  });

  app.post("/api/hive/messages", async (req, reply) => {
    const body = req.body as any;
    if (!body?.to || !body?.body) return reply.code(400).send({ error: "to and body required" });
    const msg = hive.postMessage(body, body.from || "user");
    return { ok: true, message: msg };
  });

  app.get("/api/hive/memory/:agentId", async (req, reply) => {
    const { agentId } = req.params as any;
    return { content: hive.getAgentMemory(agentId) };
  });

  app.post("/api/hive/memory/:agentId", async (req, reply) => {
    const { agentId } = req.params as any;
    const body = req.body as any;
    if (typeof body?.content !== "string") return reply.code(400).send({ error: "content required" });
    hive.setAgentMemory(agentId, body.content);
    return { ok: true, content: body.content };
  });

  app.get("/api/hive/meetings", async () => {
    return { meetings: hive.getActiveMeetings() };
  });

  app.post("/api/hive/meeting", async (req, reply) => {
    const body = req.body as any;
    if (!body?.agentA || !body?.agentB) {
      return reply.code(400).send({ error: "agentA and agentB required" });
    }
    const action = body.action || "start";
    if (action === "end") {
      hive.endMeeting(body.agentA, body.agentB);
    } else {
      const durationMs = body.durationSeconds ? Number(body.durationSeconds) * 1000 : 45000;
      hive.setMeeting(body.agentA, body.agentB, durationMs, body.reason || "Inter-Agent Collaboration");
    }
    broadcastView();
    return { ok: true, meetings: hive.getActiveMeetings() };
  });

  // ─── Project Management Endpoints ─────────────────────────────────
  app.get("/api/projects", async () => {
    const projects = db.prepare("SELECT * FROM projects ORDER BY name").all() as any[];
    const result = projects.map((p) => {
      const agents = db.prepare("SELECT id, name, role FROM agents WHERE project_id = ? AND retired = 0").all(p.id) as any[];
      const taskCount = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE project_id = ?").get(p.id) as any)?.count || 0;
      const commander = agents.find((a) => a.role === "planner" || a.name?.toLowerCase().includes("commander"));
      return {
        id: p.id,
        name: p.name || p.gh_repo || p.id,
        gh_repo: p.gh_repo,
        layout: p.layout || "office",
        agentCount: agents.length,
        taskCount,
        commanderName: commander ? commander.name : null,
        commanderId: commander ? commander.id : null,
      };
    });
    return { projects: result };
  });

  app.get("/api/fs/directories", async (req, reply) => {
    const query = req.query as any;
    let target = query?.path ? String(query.path).trim() : (process.env.HOME || "/");
    if (target.startsWith("~/")) {
      target = join(process.env.HOME || "", target.slice(2));
    } else if (target === "~") {
      target = process.env.HOME || "/";
    }
    try {
      if (!existsSync(target)) {
        return reply.code(404).send({ error: "Directory not found: " + target });
      }
      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: join(target, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 100);

      const parent = dirname(target) !== target ? dirname(target) : null;
      return { current: target, parent, directories: dirs };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post("/api/fs/mkdir", async (req, reply) => {
    const body = req.body as any;
    let target = String(body?.path || "").trim();
    if (!target) return reply.code(400).send({ error: "Path is required" });
    if (target.startsWith("~/")) {
      target = join(process.env.HOME || "", target.slice(2));
    }
    try {
      if (!existsSync(target)) {
        mkdirSync(target, { recursive: true });
      }
      return { success: true, path: target };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  const execAsync = promisify(exec);

  app.post("/api/fs/choose-folder", async (req, reply) => {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execAsync(
          `osascript -e 'POSIX path of (choose folder with prompt "Select Project Working Directory:")'`
        );
        const folderPath = stdout.trim().replace(/\/+$/, "");
        return { path: folderPath };
      } else if (process.platform === "win32") {
        const { stdout } = await execAsync(
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`
        );
        const folderPath = stdout.trim();
        return { path: folderPath };
      } else {
        return reply.code(400).send({ error: "Native folder picker not supported on this OS" });
      }
    } catch (err: any) {
      if (err.message && (err.message.includes("User canceled") || err.message.includes("-128"))) {
        return { canceled: true };
      }
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post("/api/projects", async (req, reply) => {
    const body = req.body as any;
    const name = String(body?.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Project name is required" });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const projectId = "prj_" + slug + "_" + randomBytes(3).toString("hex");

    let folder = body.folder ? String(body.folder).trim() : "";
    if (!folder) {
      folder = join(process.env.HOME || "", "project_test", slug);
    }
    if (folder.startsWith("~/")) {
      folder = join(process.env.HOME || "", folder.slice(2));
    }
    try {
      if (!existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
      }
    } catch {}

    // 1. Create project row
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, 'office')").run(
      projectId,
      folder,
      name
    );

    // 2. Automatically spawn EXACTLY ONE Central Commander agent
    const commanderId = "agt_" + randomBytes(4).toString("hex");
    const commanderName = String(body?.commanderName || "").trim() || `${slug}-commander`;
    const provider = String(body?.provider || "opencode").toLowerCase();
    const model = body.model || (provider === "claude" ? "claude-3-7-sonnet-20250219" : "Nemotron 3.5 Lightning Free");

    const machineId = (db.prepare("SELECT id FROM machines WHERE online = 1 LIMIT 1").get() as any)?.id
                   || (db.prepare("SELECT id FROM machines LIMIT 1").get() as any)?.id
                   || "node_primary";
    const ownerId = (db.prepare("SELECT id FROM users LIMIT 1").get() as any)?.id || "usr_ayush";

    const commanderPrompt = buildCommanderHivePrompt({
      commanderName,
      folder,
      projectName: name,
    });

    db.prepare(`
      INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, provider, model, folder, description, goal, character, status)
      VALUES (?, ?, ?, ?, ?, 'planner', ?, ?, ?, ?, ?, 'adam', 'idle')
    `).run(
      commanderId,
      machineId,
      ownerId,
      projectId,
      commanderName,
      provider,
      model,
      folder,
      `Central Operations Commander for ${name}`,
      commanderPrompt
    );

    // Initialize project-scoped Hive directory on disk
    try {
      ensureProjectHive(folder, name, commanderId, commanderName);
    } catch {}

    // Register with Hive
    hive.registerAgent({
      id: commanderId,
      name: commanderName,
      role: "planner",
      provider,
      model,
      folder,
      isGod: true,
    });

    // Write initial AGENTS.md in project folder with the Commander Hive prompt
    try {
      const agentsMdPath = join(folder, "AGENTS.md");
      writeFileSync(agentsMdPath, commanderPrompt, "utf8");
    } catch {}

    // 3. Initialize Commander's memory and deliver orientation message to inbox
    try {
      const memoryContent = `# Central Operations Commander Memory: ${name}\n\n` +
        `- [${new Date().toISOString()}] Commissioned as Central Operations Commander for "${name}".\n` +
        `- Project Directory: ${folder}\n` +
        `- Standing Protocol: Analyze objectives, draft architecture on board.md, log tasks on tasks.json, recruit/delegate to subordinates.\n`;
      hive.setAgentMemory(commanderId, memoryContent);

      hive.postMessage({
        from: "operator",
        to: commanderId,
        act: "inform",
        subject: `Welcome, Commander: Project "${name}" initialized`,
        body: `Welcome, Commander. You have been appointed Central Operations Commander for project "${name}". Your workspace is at ${folder}.\n\n` +
          `HIVE PROTOCOL:\n` +
          `1. Maintain situational awareness of the project.\n` +
          `2. Formulate master architecture on ${folder}/hive/board.md.\n` +
          `3. Track deliverables on ${folder}/hive/tasks.json.\n` +
          `4. Delegate missions to specialized subordinate agents.\n` +
          `Stand ready for operator directives.`
      }, "operator");
    } catch {}

    // Auto-start Commander terminal session in background
    const ptyName = 'pty-' + commanderName.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + commanderId.slice(-8);
    try {
      spawnOrGetPtySession(db, ptyName, commanderId, 100, 30, hive);
    } catch {}

    // Add all existing users directly into this new project
    try {
      const allUsers = db.prepare("SELECT id FROM users").all() as any[];
      for (const u of allUsers) {
        db.prepare(`
          INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
          VALUES (?, ?, 'member', ?)
        `).run(projectId, u.id, new Date().toISOString());
      }
    } catch {}

    broadcastView();

    return {
      ok: true,
      project: {
        id: projectId,
        name,
        slug,
        folder,
      },
      commander: {
        id: commanderId,
        name: commanderName,
        role: "planner",
        folder,
      },
    };
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as any;
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    if (!project) return reply.code(404).send({ error: "Project not found" });

    // Clean up tasks, agents, events for this project
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM agents WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM events WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);

    broadcastView();
    return { ok: true, deletedId: id };
  });

  // ─── Authentication Endpoints ─────────────────────────────────────
  app.post("/api/auth/signup", async (req, reply) => {
    const body = req.body as any;
    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!name) return reply.code(400).send({ error: "Name is required" });
    if (!email) return reply.code(400).send({ error: "Email or username is required" });
    if (password.length < 6) return reply.code(400).send({ error: "Password must be at least 6 characters" });

    const existing = db.prepare("SELECT id FROM users WHERE email = ? OR gh_login = ? OR name = ?").get(email, email, name);
    if (existing) {
      return reply.code(400).send({ error: "An account with that email or name already exists" });
    }

    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    const password_hash = `${salt}:${hash}`;
    const userId = "usr_" + randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, gh_login, name, avatar, email, password_hash, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(userId, email, name, email, password_hash, createdAt);

    // Add user directly into all existing projects
    try {
      const allProjects = db.prepare("SELECT id FROM projects").all() as any[];
      for (const p of allProjects) {
        db.prepare(`
          INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
          VALUES (?, ?, 'member', ?)
        `).run(p.id, userId, createdAt);
      }
    } catch {}

    const token = randomBytes(24).toString("hex");
    return {
      ok: true,
      user: {
        id: userId,
        name,
        email,
      },
      token,
    };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = req.body as any;
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!email || !password) {
      return reply.code(400).send({ error: "Email/Username and password are required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ? OR gh_login = ? OR name = ?").get(email, email, email) as any;
    if (!user || !user.password_hash) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const [salt, storedHash] = String(user.password_hash).split(":");
    if (!salt || !storedHash) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const hash = scryptSync(password, salt, 64).toString("hex");
    if (hash !== storedHash) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = randomBytes(24).toString("hex");
    return {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email || user.gh_login || user.name,
      },
      token,
    };
  });

  app.get("/api/auth/me", async () => {
    const user = db.prepare("SELECT id, name, email, gh_login FROM users ORDER BY rowid LIMIT 1").get() as any;
    if (!user) return { user: null };
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email || user.gh_login,
      }
    };
  });

    // Reconcile and recover any in-flight interrupted state upon startup
    recoverServerState(db);

    return { app, db, nodeSockets, browserSockets, hive };
  }

async function main() {
  const PORT = Number(process.env.PORT ?? 8787);
  const { app } = await buildServer();
  app.listen({ port: PORT, host: "0.0.0.0" }).catch((err: Error) => {
    app.log.error(err);
    process.exit(1);
  });
}

// Only auto-start when run directly (`tsx src/index.ts`), not when imported
// by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
