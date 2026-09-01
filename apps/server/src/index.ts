import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WebSocket } from "ws";
import { openDb, appendEvent, type Db } from "./db.js";
import { recoverServerState } from "./recovery.js";
import { emitSequenceEvent } from "./communication/sequenceEvents.js";
import { Positions } from "./view.js";
import { registerCommandRoutes } from "./commands.js";
import { registerAuthGate } from "./sessions.js";
import { wakeRecipient, defaultInject, roomLineFor } from "./hiveWake.js";
import { tripBreakers } from "./circuitBreaker.js";
import { superviseOnce } from "./supervisorLoop.js";
import { recordDelivery, checkForAcks, sweepDeliveries } from "./hiveDelivery.js";
import type { ChatMessageT } from "@logbridge/protocol";
import { registerGateway } from "./gateway.js";
import { registerNodeGateway, type NodeSockets } from "./nodeGateway.js";
import { startEventLoop, startTriggerLoop } from "./triggers.js";
import { registerPtyGateway, spawnAndSubmit } from "./ptyGateway.js";
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
  // Same deferred-reference pattern as broadcastViewRef: the hive callback
  // below is built before registerGateway() exists to provide it.
  let broadcastChatRef: ((c: ChatMessageT) => void) | null = null;
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

        // Wake the recipient. This used to be a bare submitPromptToAgent()
        // whose return value was discarded inside a catch{} — so when no PTY
        // session was live it silently did nothing, which is exactly how
        // three agents ended up idle while the board recorded "the delegation
        // harness was NOT live". Inject when a session exists, spawn when it
        // does not, and record undeliverable when the machine is offline
        // (D28) rather than pretending either worked.
        const wake = wakeRecipient(msg, toId, {
          db,
          inject: defaultInject,
          spawn: (agentId, prompt) => {
            const target = db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as any;
            // The message is the prompt: a freshly spawned CLI has no context,
            // so telling it to "read your inbox" alone would waste the turn.
            // spawnAndSubmit both names the ptyId the same way the UI's own
            // terminal panel does (so this session is the one a human
            // actually sees) and waits out the CLI's boot before writing.
            return spawnAndSubmit(db, agentId, target?.name || agentId, prompt, hive);
          },
          log: (m) => app.log.info(m),
        });

        // The room shows the conversation, not the payload. `say` is the
        // agent's own words when it wrote them, a generated line when it did
        // not — a silent office is the failure this design exists to prevent.
        if (wake.outcome === "injected" || wake.outcome === "spawned") {
          // Phase 1: durable delivery record. Replaces the in-memory-only
          // dedup that reset on server restart.
          recordDelivery(db, msg, toId, projectId, wake);

          const line: ChatMessageT = {
            id: crypto.randomUUID(),
            roomId: projectId,
            from: { kind: "agent", id: fromId, name: sender?.name || fromId },
            text: `→ ${receiver?.name || toId}: ${roomLineFor(msg, sender?.name || fromId, receiver?.name || toId)}`,
            ts: new Date().toISOString(),
            ask: null,   // a report between agents, not a question for a human
          };
          appendEvent(db, projectId, null, "chat", line);
          broadcastChatRef?.(line);
        } else if (wake.outcome === "undeliverable") {
          // Also record undeliverable so the table tracks every outcome.
          recordDelivery(db, msg, toId, projectId, wake);
        }
      } catch (err) {
        app.log.warn({ err }, "hive wake failed");
      }
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

    const getActiveHiveRoots = () => {
      const roots = [hiveHome];
      try {
        const projects = db.prepare("SELECT gh_repo FROM projects").all() as any[];
        for (const p of projects) {
          if (p.gh_repo && existsSync(p.gh_repo)) {
            roots.push(join(p.gh_repo, "hive"));
          }
        }
      } catch {}
      return Array.from(new Set(roots));
    };

    setInterval(() => {
      try { checkForAcks(db, getActiveHiveRoots()); } catch {}
    }, 30_000);

    // The circuit breaker the employee prompt has always described. Injects
    // only — it never spawns, because starting a CLI to tell it to stop
    // spending would spend money to say "stop spending money".
    setInterval(() => {
      try {
        tripBreakers({
          db,
          inject: defaultInject,
          log: (m) => app.log.info(m),
          postChat: (projectId, text) => {
            const line: ChatMessageT = {
              id: crypto.randomUUID(),
              roomId: projectId,
              from: { kind: "system" as any, id: "breaker", name: "Circuit breaker" },
              text,
              ts: new Date().toISOString(),
              ask: null,
            };
            appendEvent(db, projectId, null, "chat", line);
            broadcastChatRef?.(line);
          },
        });
      } catch {}
    }, 20_000);

    // The supervisor, on a clock at last. It only ever applies the additive
    // recoveries (reassign, retry); pausing and cancelling stay a person's
    // call — see supervisorLoop.ts.
    setInterval(() => {
      try {
        superviseOnce({
          db,
          log: (m) => app.log.info(m),
          broadcastView: () => { try { broadcastViewRef?.(); } catch {} },
          postChat: (projectId, text) => {
            const line: ChatMessageT = {
              id: crypto.randomUUID(),
              roomId: projectId,
              from: { kind: "system" as any, id: "supervisor", name: "Supervisor" },
              text,
              ts: new Date().toISOString(),
              ask: null,
            };
            appendEvent(db, projectId, null, "chat", line);
            broadcastChatRef?.(line);
          },
        });
      } catch {}
    }, 45_000);
    setInterval(() => {
      try {
        sweepDeliveries({
          db,
          hiveRoots: getActiveHiveRoots(),
          inject: defaultInject,
          spawn: (agentId, prompt) => {
            const target = db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as any;
            return spawnAndSubmit(db, agentId, target?.name || agentId, prompt, hive);
          },
          log: (m) => app.log.info(m),
          emitEvent: (projectId, _msgId, type, body) => {
            appendEvent(db, projectId, null, type, body);
          },
          postChat: (projectId, text) => {
            const line: ChatMessageT = {
              id: crypto.randomUUID(),
              roomId: projectId,
              from: { kind: "system" as any, id: "delivery", name: "Delivery" },
              text,
              ts: new Date().toISOString(),
              ask: null,
            };
            appendEvent(db, projectId, null, "chat", line);
            broadcastChatRef?.(line);
          },
        });
      } catch {}
    }, 60_000);
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

  // forceCloseConnections: close() otherwise waits on keep-alive sockets that
  // a browser tab (or Node's fetch pool) is holding open, so shutdown hangs
  // until they time out. Surfaced as a teardown hook timing out at 20s under
  // CPU load, blamed on whichever test happened to run last.
  const app = Fastify({ logger: false, forceCloseConnections: true });
  await app.register(websocket);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Monorepo layout: server is at apps/server/src/, web is at apps/web/
  const webRoot = join(__dirname, "..", "..", "web");
  await app.register(fastifyStatic, { root: webRoot });

  // The office's map and every sprite live in the repo-root `assets/`, not in
  // apps/web. This registration was dropped by the modularisation refactor,
  // which left the whole office 404ing — no floor, no characters — while every
  // test stayed green, because nothing tests static serving. The smoke test in
  // staticAssets.test.ts exists so that cannot happen silently again.
  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "..", "..", "assets"),
    prefix: "/assets/",
    decorateReply: false,
  });

  // Single-page app: serve index.html at root (and fastifyStatic handles the
  // fallback for any other assets in apps/web)
  app.get("/", async (_req, reply) => reply.sendFile("index.html"));

  const { broadcastView, broadcastChat } = registerGateway(app, db, positions, browserSockets, nodeSockets, hive);
  broadcastViewRef = broadcastView;
  broadcastChatRef = broadcastChat;

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

  // Loopback by DEFAULT. This used to bind 0.0.0.0 unconditionally, which put
  // an unauthenticated interactive shell (/pty-ws accepts `spawn` then raw
  // `data` keystrokes) on every network interface — every device on the same
  // wifi could open a WebSocket and get $SHELL with this process's full
  // environment. Until enrolment exists (D23), exposing the server beyond
  // loopback has to be a deliberate act by the operator, not the default.
  //
  // Set LOGBRIDGE_HOST=0.0.0.0 to expose it, and read SECURITY-REVIEW.md
  // first — it is only safe behind a tailnet or with LOGBRIDGE_TOKEN set.
  const HOST = process.env.LOGBRIDGE_HOST ?? "127.0.0.1";
  const { app, db } = await buildServer();

  // Enforced on the real entry point only. Under vitest the gate is off, so
  // the 21 existing test files that call these routes directly keep working;
  // sessions.test.ts turns it on explicitly and tests the gate itself.
  registerAuthGate(app, db);

  if (HOST !== "127.0.0.1" && HOST !== "localhost" && !process.env.LOGBRIDGE_TOKEN) {
    app.log.warn(
      `binding ${HOST} with no LOGBRIDGE_TOKEN set — /pty-ws is an unauthenticated ` +
      `shell on this machine. Set LOGBRIDGE_TOKEN, or bind loopback only.`
    );
  }

  app.listen({ port: PORT, host: HOST }).catch((err: Error) => {
    app.log.error(err);
    process.exit(1);
  });
}

// Only auto-start when run directly (`tsx src/index.ts`), not when imported
// by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
