// The node runner's side of the wire. Separate from gateway.ts (browsers)
// because the trust level is completely different: a browser is "you,
// logged in"; a node is "some machine claiming an identity it must prove
// cryptographically." See SYSTEM.md §3b and DECISIONS.md D23.
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { canTransition, isSideEffecting, parseEnvelope, type ChatMessageT, type EnvelopeT } from "@logbridge/protocol";
import {
  type Db,
  appendEvent,
  expiredLeaseTasks,
  getTask,
  createTask,
  getGrant,
  setGrant,
  recallMemories,
  writeMemory,
  markMachineOnline,
  getMachine,
  registerMachine,
  setMachineCapabilities,
  setSealingPubkey,
  sealingKeyForAgent,
  renewLease,
  setAgentStatus,
  setTaskState,
  tasksForMachine,
  consumeAgentSteer,
  isAgentDeleted,
} from "./db.js";
import { makeChallenge, verifySignature } from "./nodeAuth.js";
import { parsePlan } from "./plan.js";
import { assignPendingTasks } from "./orchestrator.js";

/** Run the orchestrator and offer whatever it just assigned. The single entry
 *  point — called wherever capacity changes: a machine connects, an agent
 *  finishes, a new agent registers. */
export function orchestrate(db: Db, nodeSockets: NodeSockets, app?: FastifyInstance) {
  for (const { taskId, agentId } of assignPendingTasks(db)) {
    app?.log.info({ taskId, agentId }, "orchestrator assigned task");
    sendTaskOffer(db, nodeSockets, taskId);
  }
}

const HELLO_TIMEOUT_MS = 5000;

// Dedupes task.result within this process's lifetime — a late result
// re-delivered after a reconnect (at-least-once) must not double-apply.
// Persistent (cross-restart) idem tracking is a real gap, not silently
// ignored — see DECISIONS.md D23.
const seenResultIdem = new Set<string>();

// Browser-initiated agent creations awaiting the machine's verdict. Same
// process-lifetime caveat as above: an in-flight request at server restart
// just times out on the browser side, which is the honest outcome anyway.
const pendingAgentCreates = new Map<
  string,
  (r: { ok: boolean; agentId: string | null; error: string | null }) => void
>();

const pendingGitRequests = new Map<
  string,
  (r: any) => void
>();
const GIT_REQUEST_TIMEOUT_MS = 3000;

// Delegations held for the target machine's owner to approve or refuse
// (SEALED.md "Consent"). The held envelope is forwarded byte-for-byte on
// approval — rewriting it would break the AAD binding.
interface HeldDelegation {
  env: EnvelopeT;
  targetMachineId: string;
  requesterAgentId: string;
  capability: string;
  projectId: string | null;
  timer: NodeJS.Timeout;
}
const pendingDelegationConsents = new Map<string, HeldDelegation>();

export interface AgentCreateRequest {
  machineId: string;
  projectId: string;
  name: string;
  role: string;
  provider?: string | null;
  model?: string | null;
  capabilities?: string[];
  cwd?: string | null;
  allowTools?: string[];
  denyPaths?: string[];
  /** Identity from the Add Agent wizard — all optional. */
  character?: string | null;
  color?: string | null;
  folder?: string | null;
  isolation?: "shared" | "worktree" | "copy" | null;
  description?: string | null;
  goal?: string | null;
  /** Requested only — the machine decides. See ptyHarness. */
  bypassPermissions?: boolean;
}

/**
 * Ask a machine to create an agent at runtime. Resolves with the machine's
 * actual answer — including its refusal — or a timeout. The gates that matter
 * live on the runner; the pre-checks here exist so the browser gets an honest
 * error immediately instead of after a round trip the machine will refuse.
 */
export async function requestAgentCreate(
  db: Db, nodeSockets: NodeSockets, opts: AgentCreateRequest
): Promise<{ ok: boolean; agentId: string | null; error: string | null }> {
  const machine = getMachine(db, opts.machineId) as any;
  if (!machine) return { ok: false, agentId: null, error: "unknown machine" };
  if (!machine.online) return { ok: false, agentId: null, error: `"${machine.name ?? opts.machineId}" is offline` };
  if (!machine.allow_agent_creation) {
    return {
      ok: false, agentId: null,
      error: `"${machine.name ?? opts.machineId}" has not enabled agent creation — start its runner with --allow-agent-creation`,
    };
  }

  const requestId = crypto.randomUUID();
  const env: EnvelopeT = {
    v: 1, id: crypto.randomUUID(), type: "agent.create", project: opts.projectId,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: opts.machineId },
    task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: {
      requestId, name: opts.name, role: opts.role,
      provider: opts.provider ?? null, model: opts.model ?? null,
      capabilities: opts.capabilities ?? [], projectId: opts.projectId,
      cwd: opts.cwd ?? null, allowTools: opts.allowTools ?? [], denyPaths: opts.denyPaths ?? [],
      character: opts.character ?? null, color: opts.color ?? null,
      folder: opts.folder ?? null, isolation: opts.isolation ?? null,
      description: opts.description ?? null, goal: opts.goal ?? null,
      bypassPermissions: Boolean(opts.bypassPermissions),
    },
  };

  const result = new Promise<{ ok: boolean; agentId: string | null; error: string | null }>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAgentCreates.delete(requestId)) {
        resolve({ ok: false, agentId: null, error: "the machine did not answer in time" });
      }
    }, AGENT_CREATE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingAgentCreates.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
  });

  const socket = nodeSockets.get(opts.machineId)!;
  socket.send(JSON.stringify(env));
  appendEvent(db, opts.projectId, null, "agent.create.request", {
    requestId, name: opts.name, role: opts.role, provider: opts.provider ?? null,
    model: opts.model ?? null, machineId: opts.machineId,
  });

  const answer = await result;
  appendEvent(db, opts.projectId, null, "agent.create.result", {
    requestId, ok: answer.ok, agentId: answer.agentId, error: answer.error,
    name: opts.name, machineId: opts.machineId,
  });
  return answer;
}

const AGENT_CREATE_TIMEOUT_MS = 8_000;

export type NodeSockets = Map<string, WebSocket>; // machineId -> socket, only while authenticated

export interface NodeGatewayOptions {
  leaseSeconds?: number;
  sweepIntervalMs?: number;
  /** Broadcast a chat message to every browser — the question inbox lives
   *  in the room, not in a private channel. See PLAN.md §8. */
  onChat?: (chat: ChatMessageT) => void;
  /** How long a delegation may sit awaiting its owner's consent before the
   *  requester gets "denied (no answer)". Tests shorten this. */
  consentTimeoutMs?: number;
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
  const CONSENT_TIMEOUT_MS = opts.consentTimeoutMs ?? Number(process.env.CONSENT_TIMEOUT_MS ?? 600_000);
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
        // Capabilities are re-recorded every connect (see db.ts comment).
        setMachineCapabilities(
          db, hello.machineId,
          hello.providers ?? [],
          Boolean(hello.allowAgentCreation),
          Boolean(hello.allowUnsandboxed),
          Boolean(hello.acceptDelegations)
        );
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
        orchestrate(db, nodeSockets, app); // this machine's agents are capacity
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
      handleNodeEnvelope(db, parsed.envelope, app, onChange, LEASE_SECONDS, parsed.body, send, nodeSockets, {
        onChat: opts.onChat,
        consentTimeoutMs: CONSENT_TIMEOUT_MS,
      });
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
    orchestrate(db, nodeSockets, app); // a swept task released its agent
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

// ---- delegation consent (SEALED.md) ----

/** Hold a request and ask the target machine's owner. The sealed envelope is
 *  NOT touched while we wait — on approval it is forwarded byte-for-byte. */
function holdForConsent(
  db: Db,
  nodeSockets: NodeSockets,
  app: FastifyInstance,
  extra: { onChat?: (chat: ChatMessageT) => void; consentTimeoutMs?: number },
  ctx: {
    env: EnvelopeT; requestId: string; summary: string | null;
    requesterName: string; requesterOwner: string;
    targetMachineId: string; targetAgentName: string;
    grantorId: string; capability: string;
  }
) {
  const timer = setTimeout(() => {
    if (pendingDelegationConsents.delete(ctx.requestId)) {
      denySealedRequest(db, nodeSockets, ctx.env, ctx.requestId, ctx.requesterOwner,
        "the machine owner did not answer in time", app);
    }
  }, extra.consentTimeoutMs ?? 600_000);
  if (timer.unref) timer.unref();

  pendingDelegationConsents.set(ctx.requestId, {
    env: ctx.env, targetMachineId: ctx.targetMachineId,
    requesterAgentId: ctx.env.from.id, capability: ctx.capability,
    projectId: ctx.env.project ?? null, timer,
  });

  // Ask in the room, presented as the target agent's inbox entry. `taskId`
  // in the ask payload is actually the requestId here — the client's answer
  // flow is identical, so no contract change was needed for correlation.
  if (extra.onChat) {
    extra.onChat({
      id: crypto.randomUUID(),
      roomId: ctx.env.project ?? "",
      from: { kind: "agent", id: ctx.targetAgentName, name: ctx.targetAgentName },
      text:
        `${ctx.requesterName} asks to run ${ctx.capability} here` +
        (ctx.summary ? `: ${ctx.summary}` : "") +
        " — allow?",
      ts: new Date().toISOString(),
      ask: { taskId: ctx.requestId, options: ["approve", "reject"] },
    });
  }
  app.log.info({ requestId: ctx.requestId }, "delegation held for owner consent");
}

/** Refuse a held request on the requester's behalf, in the shape their
 *  pending promise expects: a failed delegate.result / review.result, or a
 *  context.ack(false). Their await settles honestly either way. */
function denySealedRequest(
  db: Db, nodeSockets: NodeSockets, reqEnv: EnvelopeT, requestId: string,
  _requesterOwnerId: string, reason: string, app: FastifyInstance
) {
  // The refusal must reach the REQUESTING AGENT's machine.
  const requesterAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(reqEnv.from.id) as any;
  const socket = requesterAgent ? nodeSockets.get(requesterAgent.machine_id) : undefined;
  if (!socket || socket.readyState !== socket.OPEN) {
    app.log.warn({ requestId }, "cannot deny a sealed request to an offline requester");
    return;
  }

  let type = "delegate.result";
  let body: Record<string, unknown> = { requestId, taskId: reqEnv.task ?? requestId, state: "failed", verified: false, sealed: null, note: reason };
  if (reqEnv.type === "review.request") {
    type = "review.result";
    body = { requestId, taskId: null, state: "failed", verified: false, sealed: null, note: reason };
  } else if (reqEnv.type === "context.share") {
    type = "context.ack";
    body = { shareId: requestId, accepted: false };
  }
  socket.send(JSON.stringify({
    v: 1, id: crypto.randomUUID(), type, project: reqEnv.project,
    from: { kind: "server", id: "server" }, to: reqEnv.to,
    task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body,
  }));
  appendEvent(db, reqEnv.project, null, `${reqEnv.type}.denied`, { requestId, reason });
  app.log.info({ requestId, reason }, "sealed request denied");
}

/** The owner answered. Forward or refuse; persist always/never grants.
 *  Returns false if the requestId isn't a held delegation. */
export function resolveDelegationConsent(
  db: Db,
  nodeSockets: NodeSockets,
  app: FastifyInstance,
  requestId: string,
  approved: boolean,
  mode?: "once" | "always" | "never",
  onChat?: (chat: ChatMessageT) => void
): boolean {
  const held = pendingDelegationConsents.get(requestId);
  if (!held) return false;
  clearTimeout(held.timer);
  pendingDelegationConsents.delete(requestId);

  const requesterAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(held.requesterAgentId) as any;
  const targetMachine = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(held.targetMachineId) as any;
  const grantorId = targetMachine?.owner_id ?? "unknown";
  const granteeId = requesterAgent?.owner_id ?? "unknown";

  if (!approved) {
    if (mode === "never") setGrant(db, grantorId, granteeId, held.projectId, held.capability, "never");
    appendEvent(db, held.projectId, null, "delegate.decision", { requestId, decision: mode ?? "denied", by: grantorId });
    denySealedRequest(db, nodeSockets, held.env, requestId, granteeId, "denied by the machine owner", app);
    return true;
  }

  if (mode === "always") {
    setGrant(db, grantorId, granteeId, held.projectId, held.capability, "always");
    appendEvent(db, held.projectId, null, "delegate.decision", { requestId, decision: "always", by: grantorId });
  } else {
    appendEvent(db, held.projectId, null, "delegate.decision", { requestId, decision: "once", by: grantorId });
  }

  // Forward exactly what arrived — the AAD binding forbids anything else.
  const socket = nodeSockets.get(held.targetMachineId);
  if (!socket || socket.readyState !== socket.OPEN) {
    denySealedRequest(db, nodeSockets, held.env, requestId, granteeId, "machine went offline before consent was given", app);
    return true;
  }
  socket.send(JSON.stringify(held.env));
  if (onChat) {
    onChat({
      id: crypto.randomUUID(),
      roomId: held.projectId ?? "",
      from: { kind: "user", id: "you", name: "you" },
      text: `approved ${held.capability} from ${requesterAgent?.name ?? "a teammate"}${mode === "always" ? " — always for this project" : " — this once"}`,
      ts: new Date().toISOString(),
      ask: null,
    });
  }
  return true;
}

/**
 * Turn a finished planning task into a proposal in the room.
 *
 * The agent's words arrive as task.event rows, so the plan is reassembled
 * from the log — no extra protocol, and it survives a reconnect because the
 * log does. Nothing is created until a human approves: a bad decomposition
 * silently spawning six tasks is worse than no planning at all.
 */
export function proposePlanFromOutput(db: Db, task: any, onChat?: (c: any) => void) {
  const rows = db
    .prepare("SELECT body FROM events WHERE task_id = ? AND type = 'task.event' ORDER BY seq")
    .all(task.id) as any[];
  const output = rows
    .map((r) => { try { return JSON.parse(r.body)?.summary ?? ""; } catch { return ""; } })
    .join("\n");

  const tasks = parsePlan(output);
  const planId = `pln_${crypto.randomUUID()}`;
  appendEvent(db, task.project_id, task.id, "plan.proposed", { planId, tasks, goal: task.title });

  const say = (text: string, ask: any = null) => {
    const chat = {
      id: crypto.randomUUID(), roomId: task.project_id,
      from: { kind: "agent", id: "system", name: "office" },
      text, ts: new Date().toISOString(), ask,
    };
    // Persist BEFORE broadcasting. Planning takes minutes against a real CLI,
    // so nobody is necessarily watching when it lands — broadcast-only meant
    // the proposal vanished for anyone who wasn't joined at that instant, and
    // an unapprovable plan is a dead end.
    appendEvent(db, task.project_id, task.id, "chat", chat);
    onChat?.(chat);
  };

  if (tasks.length === 0) {
    // Say so rather than leaving the room wondering. An empty plan is a
    // failure of the model or the prompt, not an empty backlog.
    say(`I couldn't turn “${task.title.replace(/^Plan: /, "")}” into tasks — the agent didn't return a usable list. Try rewording the goal.`);
    return;
  }

  const list = tasks
    .map((t, i) => `${i + 1}. ${t.title}${t.capability ? `  (${t.capability})` : ""}`)
    .join("\n");
  say(
    `Plan for “${task.title.replace(/^Plan: /, "")}” — ${tasks.length} tasks:\n\n${list}\n\nCreate them?`,
    { taskId: planId, options: ["approve", "reject"] }
  );
}

/** Create the tasks a plan proposed. Returns how many were created. */
export function acceptPlan(db: Db, planId: string): number {
  const row = db
    .prepare("SELECT project_id, body FROM events WHERE type = 'plan.proposed' ORDER BY seq DESC")
    .all()
    .map((r: any) => ({ projectId: r.project_id, body: JSON.parse(r.body) }))
    .find((r: any) => r.body?.planId === planId);
  if (!row) return 0;

  // A plan can only be cashed in once. Without this, double-clicking approve
  // (or a retried message) creates the whole plan again — and the second
  // copy is indistinguishable from real work.
  const already = db
    .prepare("SELECT body FROM events WHERE type = 'plan.accepted'")
    .all()
    .some((r: any) => { try { return JSON.parse(r.body)?.planId === planId; } catch { return false; } });
  if (already) return 0;

  let created = 0;
  for (const t of row.body.tasks ?? []) {
    // Unassigned on purpose — the orchestrator routes each one by capability
    // and load, which is exactly the job it already does.
    createTask(db, {
      projectId: row.projectId,
      title: t.title,
      creatorId: "plan",
      agentId: null,
      requiredCapability: t.capability ?? null,
    });
    created++;
  }
  appendEvent(db, row.projectId, null, "plan.accepted", { planId, created });
  return created;
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
  const steer = consumeAgentSteer(db, task.agent_id);
  socket.send(JSON.stringify(taskOfferEnvelope({ ...task, _machineId: agent.machine_id }, steer)));
  return true;
}

export function taskOfferEnvelope(t: any, steer?: string | null): EnvelopeT {
  let spec = t.spec ?? null;
  if (steer) {
    spec = `[Steer Context]: ${steer}\n\n${spec ?? ""}`;
  }
  return {
    v: 1, id: crypto.randomUUID(), type: "task.offer", project: t.project_id,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: t._machineId ?? "" },
    task: t.id, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: {
      taskId: t.id, agentId: t.agent_id ?? null, title: t.title, spec,
      acceptance: null, budget: { seconds: t.budget_seconds ?? 60, usd: t.budget_usd ?? 1.0 },
    },
  };
}

export async function requestAgentGit(
  db: Db,
  nodeSockets: NodeSockets,
  agentId: string
): Promise<{
  ok: boolean;
  branch: string | null;
  clean: boolean;
  ahead: number;
  behind: number;
  changedFiles: string[];
  commits: Array<{ sha: string; message: string; author?: string; ts?: string }>;
  error: string | null;
}> {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    return { ok: false, branch: null, clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "agent not found" };
  }
  const machine = getMachine(db, agent.machine_id) as any;
  if (!machine || !machine.online) {
    return { ok: true, branch: "unknown", clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "machine offline" };
  }
  if (agent.isolation === "shared") {
    return { ok: true, branch: null, clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: null };
  }

  const socket = nodeSockets.get(agent.machine_id);
  if (!socket || socket.readyState !== socket.OPEN) {
    return { ok: true, branch: "unknown", clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "runner disconnected" };
  }

  const requestId = crypto.randomUUID();
  const env: EnvelopeT = {
    v: 1,
    id: crypto.randomUUID(),
    type: "agent.git",
    project: agent.project_id ?? "",
    from: { kind: "server", id: "server" },
    to: { kind: "node", id: agent.machine_id },
    task: null,
    idem: crypto.randomUUID(),
    ts: new Date().toISOString(),
    body: { requestId, agentId: agent.id },
  };

  const result = new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingGitRequests.delete(requestId)) {
        resolve({ ok: true, branch: "unknown", clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "timeout" });
      }
    }, GIT_REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingGitRequests.set(requestId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });

  socket.send(JSON.stringify(env));
  return result;
}

function handleNodeEnvelope(
  db: Db,
  env: EnvelopeT,
  app: FastifyInstance,
  onChange: () => void,
  leaseSeconds: number,
  validBody: any,
  send: (m: unknown) => void,
  nodeSockets: NodeSockets,
  extra: { onChat?: (chat: ChatMessageT) => void; consentTimeoutMs?: number } = {}
) {
  const body = env.body as any;

  // ---- cross-machine sealed flows: delegation, review, context (SEALED.md) ----
  // The server is a router here and nothing more. It reads routing metadata
  // to decide where messages go and to draw the office; sealed payloads pass
  // through untouched. Requests for a capability the target owner hasn't
  // granted are HELD for consent; every result/reply always flows.
  if (
    env.type === "delegate.request" || env.type === "delegate.result" ||
    env.type === "review.request" || env.type === "review.result" ||
    env.type === "context.share" || env.type === "context.ack"
  ) {
    const isReply =
      env.type === "delegate.result" || env.type === "review.result" || env.type === "context.ack";
    const isRequest = !isReply;
    const targetAgentId = isRequest
      ? (validBody.targetAgentId ?? validBody.toAgentId ?? null)
      : null;
    const target = isRequest
      ? sealingKeyForAgent(db, targetAgentId)
      : sealingKeyForAgent(db, (env.to as any).id);

    // context.share's recipient key lives on the ADDRESSEE agent; requests
    // name their target in the body. Both resolve through the same table.
    if (!target) {
      app.log.warn({ to: env.to }, "sealed flow for an unknown agent — dropped");
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

    // ---- per-request consent (prompt 5): requests to a machine whose owner
    // hasn't granted this capability are HELD here, surfaced in the room, and
    // forwarded only when the owner answers. Results always flow untouched —
    // they are a reply to work already consented to. ----
    if (isRequest) {
      const requesterAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
      const targetMachine = db.prepare("SELECT * FROM machines WHERE id = ?").get(target.machineId) as any;
      const targetAgentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(targetAgentId) as any;
      const grantorId = targetMachine?.owner_id ?? "unknown";
      const granteeId = requesterAgent?.owner_id ?? "unknown";
      const requestId = String(validBody.requestId ?? validBody.shareId);
      // What consent is being asked FOR. Reviews and context shares use a
      // derived capability so owners can grant them separately from work.
      const capability =
        validBody.capability ??
        (env.type === "review.request" ? "request_review" : "share_context");
      const summary =
        validBody.summary ??
        validBody.title ??
        (Array.isArray(validBody.criteria) ? validBody.criteria.join("; ") : null);

      // The machine-level gate comes first: a machine that never opted into
      // outside work gets an immediate refusal — asking its owner to approve
      // something the runner would refuse anyway is just noise.
      if (!targetMachine?.accept_delegations) {
        appendEvent(db, env.project, env.task, env.type, {
          requestId,
          capability,
          from: env.from.id, to: targetAgentId, state: null,
          sealed: true, consent: "refused — machine not accepting outside requests",
        });
        denySealedRequest(db, nodeSockets, env, requestId, granteeId,
          "the target machine does not accept outside requests", app);
        onChange();
        return;
      }

      const grant = getGrant(db, grantorId, granteeId, env.project ?? null, capability);

      appendEvent(db, env.project, env.task, env.type, {
        requestId,
        capability,
        from: env.from.id,
        to: targetAgentId,
        state: null,
        sealed: true, // the payload itself is deliberately not logged
        summary: summary ?? null,
        consent: grant === "never" ? "auto-denied" : grant === "always" ? "granted" : "asked",
      });

      if (grant === "never") {
        denySealedRequest(db, nodeSockets, env, requestId, granteeId, "denied by the machine owner's standing rule", app);
        onChange();
        return;
      }
      if (grant !== "always") {
        holdForConsent(db, nodeSockets, app, extra, {
          env,
          requestId,
          summary: summary ?? null,
          requesterName: requesterAgent?.name ?? env.from.id,
          requesterOwner: granteeId,
          targetMachineId: target.machineId,
          targetAgentName: targetAgentRow?.name ?? String(targetAgentId),
          grantorId,
          capability,
        });
        onChange();
        return;
      }
      // grant === 'always': fall through and forward immediately.
      appendEvent(db, env.project, env.task, `${env.type}.granted`, {
        requestId, by: `standing grant from ${grantorId}`,
      });
    }

    // Forwarded byte-for-byte. Rewriting any of from/to/type/project/id here
    // would break the AAD binding and the recipient's open() would fail —
    // that is the intended behaviour, not an inconvenience to work around.
    socket.send(JSON.stringify(env));

    const sender = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
    if (isRequest && env.type !== "context.share" && sender) {
      // Blocked on ANOTHER MACHINE'S agent -> zoneFor() reads the "@" and
      // renders both of them in the meeting room. That's PHASES.md's M5
      // visual, driven by real state rather than staged. Context shares are
      // fire-and-forget — they block nobody.
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

    if (!isRequest) {
      appendEvent(db, env.project, env.task, env.type, {
        requestId: validBody.requestId,
        capability: validBody.capability ?? null,
        from: env.from.id,
        to: (env.to as any).id,
        state: validBody.state ?? null,
        sealed: true, // the payload itself is deliberately not logged
      });
    }
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

  // ---- runtime agent creation ----
  if (env.type === "agent.create.result") {
    const resolve = pendingAgentCreates.get(validBody.requestId);
    if (resolve) {
      pendingAgentCreates.delete(validBody.requestId);
      resolve({
        ok: validBody.ok,
        agentId: validBody.agentId ?? null,
        error: validBody.error ?? null,
      });
    }
    return;
  }

  // ---- mid-task questions (HANDOFF.md prompt 3) ----
  // The runner already moved the task to input-required; this surfaces the
  // question to the room and pins the agent in its owner's cabin. The task
  // stays input-required until the human's answer is relayed back.
  if (env.type === "human.ask") {
    const t = getTask(db, validBody.taskId);
    if (!t || !t.agent_id) return;
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(t.agent_id) as any;
    if (!agent) return;
    const owner = db.prepare("SELECT name FROM users WHERE id = ?").get(agent.owner_id) as any;
    setAgentStatus(db, agent.id, "needs_input", t.id);
    db.prepare("UPDATE agents SET waiting_on = ? WHERE id = ?").run(
      `human: ${owner?.name ?? "you"}`, agent.id
    );
    appendEvent(db, env.project, t.id, "human.ask", { question: validBody.question });
    // The question lives in the room where everyone can see it (PLAN.md §8) —
    // same feed as proposals, different options.
    if (extra.onChat) {
      extra.onChat({
        id: crypto.randomUUID(),
        roomId: env.project,
        from: { kind: "agent", id: agent.id, name: agent.name },
        text: String(validBody.question),
        ts: new Date().toISOString(),
        ask: { taskId: t.id, options: ["answer"] },
      });
    }
    onChange();
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

  if (env.type === "agent.git.result") {
    const cb = pendingGitRequests.get(body.requestId);
    if (cb) {
      pendingGitRequests.delete(body.requestId);
      cb(body);
    }
    return;
  }

  if (env.type === "agent.card") {
    if (isAgentDeleted(db, body.id)) {
      return;
    }
    // The machine owner declares agents locally; the server just upserts
    // the card. Simplification: one project per agent for now (the schema
    // and buildView both assume this already) — take the first of `projects`.
    const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(body.machineId) as any;
    // Identity travels with the card because the machine owner declares it
    // (SYSTEM.md §7) — the same reason name and role do. `note` is absent on
    // purpose: a human types it in the browser, so overwriting it here would
    // erase it every time the runner reconnected.
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, current_task,
                           character, color, folder, isolation, description, goal, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         machine_id=excluded.machine_id, owner_id=excluded.owner_id, project_id=excluded.project_id,
         name=excluded.name, role=excluded.role, capabilities=excluded.capabilities, concurrency=excluded.concurrency,
         character=excluded.character, color=excluded.color, folder=excluded.folder,
         isolation=excluded.isolation, description=excluded.description, goal=excluded.goal,
         provider=excluded.provider`
    ).run(
      body.id, body.machineId, owner?.owner_id ?? "usr_dev", body.projects[0] ?? null,
      body.name, body.role, JSON.stringify(body.capabilities ?? []), body.concurrency ?? 1,
      body.character ?? null, body.color ?? null, body.folder ?? null,
      body.isolation ?? null, body.description ?? null, body.goal ?? null,
      // The card reports `harness`, which is the provider id or the literal
      // "fake-worker" when the agent uses the runner's default. Normalising
      // that placeholder to null here keeps "has no provider" a single idea
      // rather than a magic string every reader has to know.
      body.harness && body.harness !== "fake-worker" ? body.harness : null
    );
    broadcastPeerDirectory(db, nodeSockets); // a new agent is a new possible peer
    orchestrate(db, nodeSockets, app);
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
    // A planning task's output IS a task list. Read it back from the events
    // the runner already logged rather than inventing a new channel.
    if (t.kind === "plan" && body.state === "completed") {
      proposePlanFromOutput(db, t, extra.onChat);
    }
    if (t.agent_id) setAgentStatus(db, t.agent_id, "idle", null);
    appendEvent(db, t.project_id, t.id, "task.result", body);
    orchestrate(db, nodeSockets, app); // that agent just freed up — drain the queue
    onChange();
    return;
  }
}
