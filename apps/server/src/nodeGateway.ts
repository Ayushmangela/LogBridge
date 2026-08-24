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
  markMachineOnline,
  getMachine,
  registerMachine,
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
          registerMachine(db, hello.machineId, hello.ownerId, hello.machineName, hello.pubkey);
          app.log.info({ machineId: hello.machineId }, "new machine registered (trust-on-first-sight)");
        }
        markMachineOnline(db, hello.machineId, true);
        nodeSockets.set(hello.machineId, socket as unknown as WebSocket);
        send({ type: "ready" });
        onChange();
        reconcileOnConnect(db, hello.machineId, send, app);
        return;
      }

      // ---- authenticated phase: real protocol envelopes only ----
      if (!machineId) return; // not authenticated yet — ignore anything else
      const parsed = parseEnvelope(msg);
      if (!parsed.ok) {
        app.log.warn({ err: parsed.error }, "node sent an invalid envelope");
        return;
      }
      handleNodeEnvelope(db, parsed.envelope, app, onChange, LEASE_SECONDS);
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

function handleNodeEnvelope(db: Db, env: EnvelopeT, app: FastifyInstance, onChange: () => void, leaseSeconds: number) {
  const body = env.body as any;

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
