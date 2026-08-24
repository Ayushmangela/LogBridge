import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import { createTask, openDb, type Db } from "./db.js";
import { Positions } from "./view.js";
import { registerGateway } from "./gateway.js";
import { orchestrate, registerNodeGateway, requestAgentCreate, sendTaskOffer, taskCancelEnvelope, type NodeSockets } from "./nodeGateway.js";

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
  opts: { dbPath?: string; leaseSeconds?: number; sweepIntervalMs?: number } = {}
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

  const broadcastView = registerGateway(app, db, positions, browserSockets, nodeSockets);
  registerNodeGateway(app, db, nodeSockets, broadcastView, {
    leaseSeconds: opts.leaseSeconds,
    sweepIntervalMs: opts.sweepIntervalMs,
  });

  // ---------------------------------------------------------------------
  // DEV ONLY: stand-in for the chat / task-creation UI that doesn't exist
  // yet (SYSTEM.md §5, Phase 2). Not part of the product surface — no auth,
  // do not expose this off localhost/tailnet.
  // ---------------------------------------------------------------------
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
    };
  }>("/api/agents", async (req, reply) => {
    const b = req.body;
    if (!b?.machineId || !b?.projectId || !b?.name) {
      return reply.code(400).send({ error: "machineId, projectId and name are required" });
    }
    const result = await requestAgentCreate(db, nodeSockets, {
      machineId: b.machineId,
      projectId: b.projectId,
      name: String(b.name).slice(0, 64),
      role: b.role ?? "developer",
      provider: b.provider ?? null,
      model: b.model ?? null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities : [],
      cwd: b.cwd ?? null,
      allowTools: Array.isArray(b.allowTools) ? b.allowTools : [],
      denyPaths: Array.isArray(b.denyPaths) ? b.denyPaths : [],
    });
    broadcastView(); // success path already published a card; refresh either way
    return reply.code(result.ok ? 200 : 409).send(result);
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
