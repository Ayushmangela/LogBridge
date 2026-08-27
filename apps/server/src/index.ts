import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, normalize, relative, resolve } from "node:path";
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import type { WebSocket } from "ws";
import {
  appendEvent, clearSummon, createTask, openDb, summonAgent,
  setAgentPaused, setAgentRetired, deleteAgent,
  setAgentSteer, getAgentHistory, moveAgent, cloneAgent,
  getAgentTraces, getAgentOutput, getProjectGraph,
  pauseTask, resumeTask, haltTask, getAgentTasks, getTaskTraces,
  type Db
} from "./db.js";
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
import { registerPtyGateway } from "./ptyGateway.js";
import { HiveManager } from "./hive.js";

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

  const hiveHome = opts.dbPath === ":memory:"
    ? join(dirname(fileURLToPath(import.meta.url)), "..", ".test-hive-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))
    : process.env.HIVE_HOME || join(process.env.HOME || "", "workspace", "hive");

  let broadcastViewRef: (() => void) | null = null;
  const hive = new HiveManager(hiveHome, (ev) => {
    const payload = JSON.stringify({ type: "hive:event", event: ev });
    for (const ws of browserSockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
    if (ev.kind === "meeting" || ev.kind === "message" || ev.kind === "task") {
      try { broadcastViewRef?.(); } catch {}
    }
  });

  if (process.env.NODE_ENV !== "test" || opts.dbPath !== ":memory:") {
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

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/agents/:id/tasks", async (req, reply) => {
    const agentId = req.params.id;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const tasks = getAgentTasks(db, agentId, limit);
    return { ok: true, agentId, tasks };
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
    // Machine existence/reachability is already handled by requestAgentCreate,
    // which returns 409 for unknown-or-offline — don't split that into two
    // status codes here.
    const result = await requestAgentCreate(db, nodeSockets, {
      machineId: b.machineId,
      projectId: b.projectId,
      name: String(b.name).slice(0, 64),
      role: b.role ?? "developer",
      provider: b.provider ?? null,
      model: b.model ?? null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities : [],
      cwd: b.cwd ?? null,
      character: b.character ?? null,
      color: b.color ?? null,
      folder: b.folder ?? null,
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
      hive.registerAgent({
        id: result.agentId,
        name: String(b.name).slice(0, 64),
        role: b.role ?? "developer",
        provider: b.provider ?? "cli",
        model: b.model ?? "default",
        folder: b.folder ?? undefined,
      });
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

  app.get("/api/hive/tasks", async () => {
    return { tasks: hive.getTasks() };
  });

  app.post("/api/hive/tasks", async (req, reply) => {
    const body = req.body as any;
    if (!body?.title) return reply.code(400).send({ error: "title required" });
    const task = hive.upsertTask(body);
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
      slug,
      name
    );

    // 2. Automatically spawn EXACTLY ONE Central Commander agent
    const commanderId = "agt_" + randomBytes(4).toString("hex");
    const commanderName = String(body?.commanderName || "").trim() || `${slug}-commander`;
    const model = body.model || "qwen2.5-coder:32b";

    const machineId = (db.prepare("SELECT id FROM machines WHERE online = 1 LIMIT 1").get() as any)?.id
                   || (db.prepare("SELECT id FROM machines LIMIT 1").get() as any)?.id
                   || "node_primary";
    const ownerId = (db.prepare("SELECT id FROM users LIMIT 1").get() as any)?.id || "usr_ayush";

    db.prepare(`
      INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, provider, model, folder, description, goal, character, status)
      VALUES (?, ?, ?, ?, ?, 'planner', 'opencode', ?, ?, ?, ?, 'adam', 'idle')
    `).run(
      commanderId,
      machineId,
      ownerId,
      projectId,
      commanderName,
      model,
      folder,
      `Central Operations Commander for ${name}`,
      `Direct missions, analyze requirements, formulate architecture, and delegate to employee agents.`
    );

    // Register with Hive
    hive.registerAgent({
      id: commanderId,
      name: commanderName,
      role: "planner",
      provider: "opencode",
      model,
      folder,
      isGod: true,
    });

    // Invert directive: Write initial AGENTS.md in project folder
    try {
      const agentsMdPath = join(folder, "AGENTS.md");
      const directive = `# SYSTEM DIRECTIVE: CENTRAL OPERATIONS COMMANDER\n\n` +
        `You are **${commanderName}**, the Central Operations Commander for **${name}**.\n\n` +
        `**CRITICAL OPERATIONAL CONSTRAINT**:\n` +
        `- **DO NOT WRITE APPLICATION SOURCE CODE DIRECTLY.**\n` +
        `- You are the Commander, NOT a worker bee.\n` +
        `- Your mission is to analyze user requests, author master architecture on \`~/workspace/hive/board.md\`, log tasks on \`~/workspace/hive/tasks.json\`, and delegate missions to specialized subordinate employees.\n\n` +
        `Stand ready for the operator's first directive!\n`;
      writeFileSync(agentsMdPath, directive, "utf8");
    } catch {}

    // 3. Initialize Commander's private memory and deliver orientation message to inbox
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
          `2. Formulate master architecture on ~/workspace/hive/board.md.\n` +
          `3. Track deliverables on ~/workspace/hive/tasks.json.\n` +
          `4. Delegate missions to specialized subordinate agents.\n` +
          `Stand ready for operator directives.`
      }, "operator");
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
