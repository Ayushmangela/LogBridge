import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WebSocket } from "ws";
import { openDb, type Db } from "./db.js";
import { recoverServerState } from "./recovery.js";
import { emitSequenceEvent } from "./communication/sequenceEvents.js";
import { Positions } from "./view.js";
import { registerCommandRoutes } from "./commands.js";
import { registerGateway } from "./gateway.js";
import { registerNodeGateway, type NodeSockets } from "./nodeGateway.js";
import { startEventLoop, startTriggerLoop } from "./triggers.js";
import { registerPtyGateway, submitPromptToAgent } from "./ptyGateway.js";
import { HiveManager } from "./hive.js";
import { registerAllRoutes } from "./routes/index.js";

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
          type: msg.act === "request" ? "DELEGATE_HANDOFF" : (msg.act === "done" ? "TASK_COMPLETED" : "DIRECT_ASSIGNMENT"),
          source: { type: "AGENT", id: fromId, label: sender?.name || fromId },
          target: { type: "AGENT", id: toId, label: receiver?.name || toId },
          summary: `[${msg.act.toUpperCase()}] ${msg.subject || msg.body?.slice(0, 80) || "Hive message"}`,
          metadata: msg as unknown as Record<string, unknown>,
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
      });
    }
  } catch {}

  const app = Fastify({ logger: false });
  await app.register(websocket);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Monorepo layout: server is at apps/server/src/, web is at apps/web/
  const webRoot = join(__dirname, "..", "..", "web");
  await app.register(fastifyStatic, { root: webRoot });

  // Single-page app: serve index.html at root (and fastifyStatic handles the
  // fallback for any other assets in apps/web)
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

  // Static reference data, deliberately not in the workspace view — see commands.ts for why.
  registerCommandRoutes(app);

  // Triggers: schedule and event loops — real tasks from standing rules.
  // Started here, like github's poll, so a task appears in the DB and the
  // office notices (firing pushes a view). Unref so they don't keep tests alive.
  const triggerLoop = startTriggerLoop(db, { onChange: broadcastView });
  const eventLoop = startEventLoop(db, { onChange: broadcastView });
  app.addHook("onClose", async () => {
    triggerLoop.stop();
    eventLoop.stop();
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

  // Register all domain API routes
  registerAllRoutes(app, {
    db,
    nodeSockets,
    browserSockets,
    broadcastView,
    app,
    hive,
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
