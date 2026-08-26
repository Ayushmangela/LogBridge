import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import {
  appendEvent, clearSummon, createTask, openDb, summonAgent,
  setAgentPaused, setAgentRetired, deleteAgent,
  setAgentSteer, getAgentHistory, moveAgent, cloneAgent,
  getAgentTraces, getAgentOutput, getProjectGraph,
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

export interface BuiltServer {
  app: ReturnType<typeof Fastify>;
  db: Db;
  nodeSockets: NodeSockets;
  browserSockets: Set<WebSocket>;
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

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

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

  const { broadcastView, broadcastChat } = registerGateway(app, db, positions, browserSockets, nodeSockets);
  registerNodeGateway(app, db, nodeSockets, broadcastView, {
    leaseSeconds: opts.leaseSeconds,
    sweepIntervalMs: opts.sweepIntervalMs,
    onChat: broadcastChat,
    consentTimeoutMs: opts.consentTimeoutMs,
  });

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
    return { ok: true, steered: true };
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
    Body: { projectId: string; title: string; spec?: string; requiredCapability?: string; budgetSeconds?: number; budgetUsd?: number };
  }>("/debug/submit-task", async (req, reply) => {
    const { projectId, title, spec, requiredCapability, budgetSeconds, budgetUsd } = req.body;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return reply.code(404).send({ error: "no such project" });

    const taskId = createTask(db, {
      projectId, title, spec, creatorId: "you", agentId: null,
      requiredCapability: requiredCapability ?? null, budgetSeconds, budgetUsd,
    });
    orchestrate(db, nodeSockets, app);
    broadcastView();
    const assignedTo = (db.prepare("SELECT agent_id FROM tasks WHERE id = ?").get(taskId) as any)?.agent_id ?? null;
    return { ok: true, taskId, assignedTo, queued: assignedTo === null };
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

  return { app, db, nodeSockets, browserSockets };
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
