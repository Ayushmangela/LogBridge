// The node runner's side of the wire. Separate from gateway.ts (browsers)
// because the trust level is completely different: a browser is "you,
// logged in"; a node is "some machine claiming an identity it must prove
// cryptographically." See SYSTEM.md §3b and DECISIONS.md D23.
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { canTransition, isSideEffecting, parseEnvelope, type EnvelopeT } from "@logbridge/protocol";
import {
  type Db,
  appendEvent,
  expiredLeaseTasks,
  getTask,
  recallMemories,
  writeMemory,
  markMachineOnline,
  getMachine,
  registerMachine,
  setSealingPubkey,
  sealingKeyForAgent,
  renewLease,
  setAgentStatus,
  setTaskState,
  tasksForMachine,
} from "./db.js";
import { makeChallenge, verifySignature } from "./nodeAuth.js";

const HELLO_TIMEOUT_MS = 5000;

// Dedupes task.result within this process's lifetime — a late result
// re-delivered after a reconnect (at-least-once) must not double-apply.
// Persistent (cross-restart) idem tracking is a real gap, not silently
// ignored — see DECISIONS.md D23.
const seenResultIdem = new Set<string>();

export type NodeSockets = Map<string, WebSocket>; // machineId -> socket, only while authenticated

export interface NodeGatewayOptions {
  leaseSeconds?: number;
  sweepIntervalMs?: number;
}

export function registerNodeGateway(
  app: FastifyInstance,
  db: Db,
  nodeSockets: NodeSockets,
  onChange: () => void,
  opts: NodeGatewayOptions = {}
) {
  // Read at call time, not module-load time — a module-level `const` here
  // would freeze at whatever process.env held on first import, which is
  // *before* any test's beforeEach() has a chance to set it. This bit us.
  const LEASE_SECONDS = opts.leaseSeconds ?? Number(process.env.LEASE_SECONDS ?? 60);
  const SWEEP_INTERVAL_MS = opts.sweepIntervalMs ?? Number(process.env.SWEEP_INTERVAL_MS ?? 10_000);
  app.get("/node-ws", { websocket: true }, (socket) => {
    let machineId: string | null = null;
    let nonce: string | null = null;
    let helloTimer: NodeJS.Timeout | null = setTimeout(() => socket.close(4000, "hello timeout"), HELLO_TIMEOUT_MS);

    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on("message", (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // ---- handshake phase: raw control messages, not protocol envelopes ----
      if (msg.type === "hello" && !machineId) {
        if (helloTimer) clearTimeout(helloTimer);
        const known = getMachine(db, msg.machineId);
        if (known?.revoked) {
          send({ type: "rejected", reason: "revoked" });
          socket.close(4003, "revoked");
          return;
        }
        if (known && known.pubkey !== msg.pubkey) {
          // Someone is presenting a different key for an already-known machine
          // id — exactly the impersonation TOFU exists to catch. Reject.
          send({ type: "rejected", reason: "pubkey mismatch" });
          socket.close(4001, "pubkey mismatch");
          return;
        }
        machineId = msg.machineId;
        nonce = makeChallenge();
        (socket as any)._pendingHello = msg;
        send({ type: "challenge", nonce });
        return;
      }

      if (msg.type === "challenge-response" && machineId && nonce) {
        const hello = (socket as any)._pendingHello;
        const ok = verifySignature(hello.pubkey, nonce, msg.signature);
        nonce = null;
        if (!ok) {
          send({ type: "rejected", reason: "bad signature" });
          socket.close(4002, "bad signature");
          machineId = null;
          return;
        }
        const known = getMachine(db, hello.machineId);
        if (!known) {
          db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, 0)").run(
            hello.ownerId,
            hello.ownerId,
            hello.ownerName ?? hello.ownerId
          );
          registerMachine(db, hello.machineId, hello.ownerId, hello.machineName, hello.pubkey, hello.sealingPubkey ?? null);
          app.log.info({ machineId: hello.machineId }, "new machine registered (trust-on-first-sight)");
        } else if (hello.sealingPubkey) {
          const existing = (known as any).sealing_pubkey as string | null | undefined;
          if (!existing) {
            // First sealing key we've seen for an already-known machine —
            // pin it, same TOFU rule the identity key follows (D23).
            setSealingPubkey(db, hello.machineId, hello.sealingPubkey);
          } else if (existing !== hello.sealingPubkey) {
            // The identity key already proved this really is that machine,
            // so this is a rotation, not an impostor — but it silently
            // invalidates anything sealed to the old key, so it's logged
            // rather than swapped in quietly.
            app.log.warn({ machineId: hello.machineId }, "sealing key rotated — payloads sealed to the old key can no longer be opened");
            setSealingPubkey(db, hello.machineId, hello.sealingPubkey);
          }
        }
        markMachineOnline(db, hello.machineId, true);
        nodeSockets.set(hello.machineId, socket as unknown as WebSocket);
        send({ type: "ready" });
        onChange();
        reconcileOnConnect(db, hello.machineId, send, app);
        // This machine learns who it can seal to; everyone else learns about
        // this machine. Without the second half, whoever connected first
        // could never reach whoever connected second.
        const dir = peerDirectoryEnvelope(db, hello.machineId);
        if (dir) send(dir);
        broadcastPeerDirectory(db, nodeSockets);
        return;
      }

      // ---- authenticated phase: real protocol envelopes only ----
      if (!machineId) return; // not authenticated yet — ignore anything else
      const parsed = parseEnvelope(msg);
      if (!parsed.ok) {
        app.log.warn({ err: parsed.error }, "node sent an invalid envelope");
        return;
      }
      // parsed.body is the zod-validated body (schema defaults applied);
      // env.body is the raw one the older handlers below still read.
      handleNodeEnvelope(db, parsed.envelope, app, onChange, LEASE_SECONDS, parsed.body, send, nodeSockets);
    });

    socket.on("close", () => {
      if (helloTimer) clearTimeout(helloTimer);
      if (machineId) {
        markMachineOnline(db, machineId, false);
        nodeSockets.delete(machineId);
        onChange();
      }
    });
  });

  // Lease sweep — SYSTEM.md §3c "the idempotency trap". Never auto-reassign;
  // a task whose runner went silent is surfaced as failed, not silently retried.
  const sweep = setInterval(() => {
    for (const t of expiredLeaseTasks(db)) {
      setTaskState(db, t.id, "failed", { ended_at: new Date().toISOString() });
      appendEvent(db, t.project_id, t.id, "lease.expired", {
        note: "machine went offline — work may still be running there",
      });
      if (t.agent_id) setAgentStatus(db, t.agent_id, "idle", null);
    }
    if (sweep.unref) sweep.unref();
    onChange();
  }, SWEEP_INTERVAL_MS);
}

// Everyone this machine's agents could seal a message to. Sent on connect;
// a machine that joins later is picked up on the next directory push.
export function peerDirectoryEnvelope(db: Db, machineId: string): EnvelopeT | null {
  const projects = db
    .prepare("SELECT DISTINCT project_id FROM agents WHERE machine_id = ?")
    .all(machineId) as any[];
  if (projects.length === 0) return null;

  const placeholders = projects.map(() => "?").join(",");
  const peers = db
    .prepare(
      `SELECT a.id AS agentId, a.name AS agentName, a.machine_id AS machineId,
              a.capabilities AS capabilities,
              m.name AS machineName, m.online AS online, m.sealing_pubkey AS sealingPubkey,
              COALESCE(u.name, u.gh_login, m.owner_id) AS ownerName
       FROM agents a
       JOIN machines m ON m.id = a.machine_id
       LEFT JOIN users u ON u.id = m.owner_id
       WHERE a.project_id IN (${placeholders}) AND a.machine_id != ?`
    )
    .all(...projects.map((p) => p.project_id), machineId) as any[];

  return {
    v: 1, id: crypto.randomUUID(), type: "peer.directory", project: projects[0].project_id,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: machineId },
    task: null, idem: null, ts: new Date().toISOString(),
    body: {
      peers: peers.map((p) => ({
        agentId: p.agentId,
        agentName: p.agentName,
        machineId: p.machineId,
        machineName: p.machineName ?? p.machineId,
        ownerName: p.ownerName ?? "unknown",
        capabilities: (() => { try { return JSON.parse(p.capabilities ?? "[]"); } catch { return []; } })(),
        online: Boolean(p.online),
        sealingPubkey: p.sealingPubkey ?? null,
      })),
    },
  };
}

/** Push a fresh directory to every connected node — called when the set of
 *  agents or their keys changes, so a machine that joins second still becomes
 *  reachable by one that connected first. */
export function broadcastPeerDirectory(db: Db, nodeSockets: NodeSockets) {
  for (const [mid, socket] of nodeSockets) {
    const env = peerDirectoryEnvelope(db, mid);
    if (env && socket.readyState === socket.OPEN) socket.send(JSON.stringify(env));
  }
}

function reconcileOnConnect(db: Db, machineId: string, send: (m: unknown) => void, app: FastifyInstance) {
  for (const t of tasksForMachine(db, machineId, ["submitted"])) {
    send(taskOfferEnvelope(t));
  }
  for (const t of tasksForMachine(db, machineId, ["working", "blocked"])) {
    // "you still hold this, per our records" — the runner decides whether it
    // actually does (still running locally) or must report it lost.
    send({
      v: 1, id: crypto.randomUUID(), type: "task.status", project: t.project_id,
      from: { kind: "server", id: "server" }, to: { kind: "node", id: machineId },
      task: t.id, idem: null, ts: new Date().toISOString(),
      body: { taskId: t.id, state: t.state, note: "resume-check" },
    });
  }
  app.log.info({ machineId }, "reconciled tasks on reconnect");
}

export function taskCancelEnvelope(taskId: string, projectId: string, machineId: string, by: string, reason: string | null): EnvelopeT {
  return {
    v: 1, id: crypto.randomUUID(), type: "task.cancel", project: projectId,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: machineId },
    task: taskId, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: { taskId, by, reason },
  };
}

// Shared by /debug/offer-task and the chat approve flow (gateway.ts) — the
// only two places a task actually gets sent to a runner. Returns false
// (task stays `submitted`, silently retried on the runner's next reconnect
// via reconcileOnConnect) if the runner isn't currently connected.
export function sendTaskOffer(db: Db, nodeSockets: NodeSockets, taskId: string): boolean {
  const task = getTask(db, taskId);
  if (!task || !task.agent_id) return false;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any;
  if (!agent) return false;
  const socket = nodeSockets.get(agent.machine_id);
  if (!socket || socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify(taskOfferEnvelope({ ...task, _machineId: agent.machine_id })));
  return true;
}

export function taskOfferEnvelope(t: any): EnvelopeT {
  return {
    v: 1, id: crypto.randomUUID(), type: "task.offer", project: t.project_id,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: t._machineId ?? "" },
    task: t.id, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: {
      taskId: t.id, title: t.title, spec: t.spec ?? null,
      acceptance: null, budget: { seconds: t.budget_seconds ?? 60, usd: t.budget_usd ?? 1.0 },
    },
  };
}

function handleNodeEnvelope(
  db: Db,
  env: EnvelopeT,
  app: FastifyInstance,
  onChange: () => void,
  leaseSeconds: number,
  validBody: any,
  send: (m: unknown) => void,
  nodeSockets: NodeSockets
) {
  const body = env.body as any;

  // ---- cross-machine delegation, end-to-end sealed (SEALED.md) ----
  // The server is a router here and nothing more. It reads capability,
  // target and budget to decide where the message goes and to draw the
  // office; `sealed` passes through untouched, and the event log records
  // only that a delegation happened — never what was in it.
  if (env.type === "delegate.request" || env.type === "delegate.result") {
    const isRequest = env.type === "delegate.request";
    const targetAgentId = isRequest ? validBody.targetAgentId : null;
    const target = isRequest
      ? sealingKeyForAgent(db, targetAgentId)
      : sealingKeyForAgent(db, (env.to as any).id);

    if (!target) {
      app.log.warn({ to: env.to }, "delegation for an unknown agent — dropped");
      return;
    }
    const socket = nodeSockets.get(target.machineId);
    if (!socket || socket.readyState !== socket.OPEN) {
      appendEvent(db, env.project, env.task, `${env.type}.undeliverable`, {
        targetMachine: target.machineId, reason: "machine offline",
      });
      onChange();
      return;
    }

    // Forwarded byte-for-byte. Rewriting any of from/to/type/project/id here
    // would break the AAD binding and the recipient's open() would fail —
    // that is the intended behaviour, not an inconvenience to work around.
    socket.send(JSON.stringify(env));

    const sender = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
    if (isRequest && sender) {
      // Blocked on another machine's agent -> zoneFor() reads the "@" and
      // renders both of them in the meeting room. That's PHASES.md's M5
      // visual, driven by real state rather than staged.
      const targetAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(targetAgentId) as any;
      const targetMachine = db.prepare("SELECT name FROM machines WHERE id = ?").get(target.machineId) as any;
      db.prepare("UPDATE agents SET status = 'blocked', waiting_on = ? WHERE id = ?").run(
        `${targetAgent?.name ?? targetAgentId}@${targetMachine?.name ?? target.machineId}`,
        sender.id
      );
    } else if (!isRequest) {
      const requester = db.prepare("SELECT * FROM agents WHERE id = ?").get((env.to as any).id) as any;
      if (requester) {
        db.prepare("UPDATE agents SET status = 'idle', waiting_on = NULL WHERE id = ?").run(requester.id);
      }
    }

    appendEvent(db, env.project, env.task, env.type, {
      requestId: validBody.requestId,
      capability: validBody.capability ?? null,
      from: env.from.id,
      to: isRequest ? targetAgentId : (env.to as any).id,
      state: validBody.state ?? null,
      sealed: true, // the payload itself is deliberately not logged
    });
    onChange();
    return;
  }

  // ---- shared memory (MEMORY.md) ----
  if (env.type === "memory.write") {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
    if (!agent) return; // memory is always attributed to a real registered agent
    const id = writeMemory(db, {
      projectId: agent.project_id,
      scope: validBody.scope,
      scopeId: validBody.scope === "agent" ? agent.id : null,
      kind: validBody.kind,
      text: validBody.text,
      sourceTaskId: validBody.sourceTaskId ?? null,
      agentId: agent.id,
      agentName: agent.name,
    });
    // A duplicate write returns null — log it as such rather than pretending
    // a new memory was formed.
    appendEvent(db, agent.project_id, validBody.sourceTaskId ?? null,
      id ? "memory.write" : "memory.write.duplicate", { ...validBody, agentName: agent.name });
    onChange();
    return;
  }

  if (env.type === "memory.recall") {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
    const memories = agent
      ? recallMemories(db, {
          projectId: agent.project_id,
          agentId: agent.id,
          query: validBody.query,
          limit: validBody.limit ?? 5,
        })
      : [];
    send({
      v: 1, id: crypto.randomUUID(), type: "memory.result", project: env.project,
      from: { kind: "server", id: "server" }, to: env.from,
      task: env.task, idem: null, ts: new Date().toISOString(),
      body: { requestId: validBody.requestId, memories },
    });
    return;
  }

  if (env.type === "task.accept") {
    const t = getTask(db, body.taskId);
    if (!t) return;
    setTaskState(db, t.id, "working", { started_at: t.started_at ?? new Date().toISOString() });
    renewLease(db, t.id, leaseSeconds);
    if (t.agent_id) setAgentStatus(db, t.agent_id, "working", t.id);
    appendEvent(db, t.project_id, t.id, "task.accept", body);
    onChange();
    return;
  }

  if (env.type === "task.status") {
    const t = getTask(db, body.taskId);
    if (!t || t.state === "completed" || t.state === "failed" || t.state === "canceled" || t.state === "rejected") return;
    renewLease(db, t.id, leaseSeconds); // heartbeat
    if (body.state && body.state !== t.state && canTransition(t.state, body.state)) {
      setTaskState(db, t.id, body.state);
    }
    appendEvent(db, t.project_id, t.id, "task.status", body);
    onChange();
    return;
  }

  if (env.type === "agent.card") {
    // The machine owner declares agents locally; the server just upserts
    // the card. Simplification: one project per agent for now (the schema
    // and buildView both assume this already) — take the first of `projects`.
    const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(body.machineId) as any;
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, current_task)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL)
       ON CONFLICT(id) DO UPDATE SET
         machine_id=excluded.machine_id, owner_id=excluded.owner_id, project_id=excluded.project_id,
         name=excluded.name, role=excluded.role, capabilities=excluded.capabilities, concurrency=excluded.concurrency`
    ).run(
      body.id, body.machineId, owner?.owner_id ?? "usr_dev", body.projects[0] ?? null,
      body.name, body.role, JSON.stringify(body.capabilities ?? []), body.concurrency ?? 1
    );
    broadcastPeerDirectory(db, nodeSockets); // a new agent is a new possible peer
    onChange();
    return;
  }

  if (env.type === "task.event") {
    appendEvent(db, env.project, body.taskId, "task.event", body);
    return; // pure progress log — no state/lease change, no view churn needed
  }

  if (env.type === "task.result") {
    const t = getTask(db, body.taskId);
    if (!t) return;
    const isSideEffect = isSideEffecting(env.type);
    if (isSideEffect && env.idem) {
      if (seenResultIdem.has(env.idem)) return; // exact redelivery — at-least-once, already applied
      seenResultIdem.add(env.idem);
    }
    const terminal = ["completed", "failed", "canceled", "rejected"].includes(t.state);
    if (terminal) {
      // Late result — the lease already expired and the sweep marked this
      // failed. The task-state machine forbids leaving a terminal state, so
      // we don't touch t.state. The result is preserved, not discarded.
      appendEvent(db, t.project_id, t.id, "task.late_result", body);
      app.log.warn({ taskId: t.id }, "late result for an already-terminal task — preserved, not applied");
      onChange();
      return;
    }
    if (!canTransition(t.state, body.state)) {
      appendEvent(db, t.project_id, t.id, "task.result.rejected", { attempted: body.state, from: t.state });
      return;
    }
    setTaskState(db, t.id, body.state, { ended_at: new Date().toISOString(), cost_usd: body.costUsd ?? t.cost_usd });
    if (t.agent_id) setAgentStatus(db, t.agent_id, "idle", null);
    appendEvent(db, t.project_id, t.id, "task.result", body);
    onChange();
    return;
  }
}
