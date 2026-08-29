import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { canTransition, isSideEffecting, parseEnvelope, type ChatMessageT, type EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import {
  appendEvent,
  expiredLeaseTasks,
  getTask,
  createTask,
  getGrant,
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
  isAgentDeleted,
  createTaskAttempt,
  finishTaskAttempt,
  getActiveTaskAttempt,
  failActiveTaskAttempt,
  isTaskDependenciesSatisfied,
  getTaskDependents,
  updateWorkflowStatusFromTasks,
  classifyFailure,
  getRetryPolicy,
  getTaskAttempts,
  candidateAgents,
} from "../db.js";
import { makeChallenge, verifySignature } from "../nodeAuth.js";
import type { NodeSockets, NodeGatewayOptions } from "./types.js";
import { orchestrate } from "./orchestration.js";
import { sendTaskOffer, taskOfferEnvelope, reconcileOnConnect } from "./task-offers.js";
import { peerDirectoryEnvelope, broadcastPeerDirectory } from "./peer-directory.js";
import { holdForConsent, denySealedRequest } from "./delegation.js";
import { proposePlanFromOutput } from "./plan-proposals.js";
import { pendingAgentCreates } from "./agent-creation.js";
import { pendingGitRequests } from "./git-queries.js";

const HELLO_TIMEOUT_MS = 5000;
const seenResultIdem = new Set<string>();

export function registerNodeGateway(
  app: FastifyInstance,
  db: Db,
  nodeSockets: NodeSockets,
  onChange: () => void,
  opts: NodeGatewayOptions = {}
) {
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

      // Handshake phase
      if (msg.type === "hello" && !machineId) {
        if (helloTimer) clearTimeout(helloTimer);
        const known = getMachine(db, msg.machineId);
        if (known?.revoked) {
          send({ type: "rejected", reason: "revoked" });
          socket.close(4003, "revoked");
          return;
        }
        if (known && known.pubkey !== msg.pubkey) {
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
            setSealingPubkey(db, hello.machineId, hello.sealingPubkey);
          } else if (existing !== hello.sealingPubkey) {
            app.log.warn({ machineId: hello.machineId }, "sealing key rotated — payloads sealed to the old key can no longer be opened");
            setSealingPubkey(db, hello.machineId, hello.sealingPubkey);
          }
        }
        markMachineOnline(db, hello.machineId, true);
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

        const dir = peerDirectoryEnvelope(db, hello.machineId);
        if (dir) send(dir);
        broadcastPeerDirectory(db, nodeSockets);
        orchestrate(db, nodeSockets, app);
        return;
      }

      if (!machineId) return;
      const parsed = parseEnvelope(msg);
      if (!parsed.ok) {
        app.log.warn({ err: parsed.error }, "node sent an invalid envelope");
        return;
      }
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

  // Lease sweep
  const sweep = setInterval(() => {
    for (const t of expiredLeaseTasks(db)) {
      failActiveTaskAttempt(db, t.id, "machine went offline — lease expired", "timed_out");
      setTaskState(db, t.id, "failed", { ended_at: new Date().toISOString() });
      appendEvent(db, t.project_id, t.id, "lease.expired", {
        note: "machine went offline — work may still be running there",
      });
      if (t.agent_id) setAgentStatus(db, t.agent_id, "idle", null);

      const failureCat = classifyFailure("machine went offline — lease expired", 1, true);
      appendEvent(db, t.project_id, t.id, "task.failure_classified", {
        taskId: t.id,
        failureCategory: failureCat,
        error: "machine went offline — lease expired",
      });

      const policy = getRetryPolicy(db, t.project_id, t.id);
      const attempts = getTaskAttempts(db, t.id);
      if (attempts.length < policy.maxAttempts && policy.retryOn.includes(failureCat)) {
        const candidates = candidateAgents(db, t.project_id);
        const altAgent = policy.preferDifferentAgent
          ? candidates.find((c) => c.machineOnline && c.id !== t.agent_id)
          : candidates.find((c) => c.machineOnline);

        const retryTaskId = createTask(db, {
          projectId: t.project_id,
          title: `[Retry ${attempts.length + 1}] ${t.title.replace(/^\[Retry \d+\]\s*/, "")}`,
          spec: t.spec,
          creatorId: "supervisor",
          parentTask: t.parent_task || t.id,
          retryOf: t.id,
          agentId: altAgent?.id ?? null,
          requiredCapability: t.required_capability,
          workflowId: t.workflow_id,
          budgetSeconds: t.budget_seconds,
          budgetUsd: t.budget_usd,
        });

        appendEvent(db, t.project_id, t.id, "task.retry_scheduled", {
          originalTaskId: t.id,
          retryTaskId,
          attemptNumber: attempts.length + 1,
          assignedAgentId: altAgent?.id ?? null,
        });
        appendEvent(db, t.project_id, retryTaskId, "task.recovery_started", {
          originalTaskId: t.id,
          retryTaskId,
        });

        if (altAgent) {
          sendTaskOffer(db, nodeSockets, retryTaskId);
        }
      } else if (attempts.length >= policy.maxAttempts) {
        appendEvent(db, t.project_id, t.id, "task.retry_exhausted", {
          taskId: t.id,
          attemptsCount: attempts.length,
          maxAttempts: policy.maxAttempts,
        });
      }
    }
    orchestrate(db, nodeSockets, app);
    if (sweep.unref) sweep.unref();
    onChange();
  }, SWEEP_INTERVAL_MS);
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

    if (isRequest) {
      const requesterAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
      const targetMachine = db.prepare("SELECT * FROM machines WHERE id = ?").get(target.machineId) as any;
      const targetAgentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(targetAgentId) as any;
      const grantorId = targetMachine?.owner_id ?? "unknown";
      const granteeId = requesterAgent?.owner_id ?? "unknown";
      const requestId = String(validBody.requestId ?? validBody.shareId);
      const capability =
        validBody.capability ??
        (env.type === "review.request" ? "request_review" : "share_context");
      const summary =
        validBody.summary ??
        validBody.title ??
        (Array.isArray(validBody.criteria) ? validBody.criteria.join("; ") : null);

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
        sealed: true,
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
      appendEvent(db, env.project, env.task, `${env.type}.granted`, {
        requestId, by: `standing grant from ${grantorId}`,
      });
    }

    socket.send(JSON.stringify(env));

    const sender = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
    if (isRequest && env.type !== "context.share" && sender) {
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
        sealed: true,
      });
    }
    onChange();
    return;
  }

  if (env.type === "memory.write") {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(env.from.id) as any;
    if (!agent) return;
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
    if (t.agent_id) {
      setAgentStatus(db, t.agent_id, "working", t.id);
      createTaskAttempt(db, { taskId: t.id, agentId: t.agent_id });
    }
    appendEvent(db, t.project_id, t.id, "task.accept", body);
    onChange();
    return;
  }

  if (env.type === "task.status") {
    const t = getTask(db, body.taskId);
    if (!t || t.state === "completed" || t.state === "failed" || t.state === "canceled" || t.state === "rejected") return;
    renewLease(db, t.id, leaseSeconds);
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
    const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(body.machineId) as any;
    // is_god = 0 on insert only, never touched on conflict: a card is always
    // the runner announcing a subordinate it created — the commander is
    // always inserted directly by routes/projects.ts, never through this
    // path — so a card can never legitimately claim commander status here.
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, current_task,
                           character, color, folder, isolation, description, goal, provider, is_god)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?, ?, ?, ?, ?, ?, 0)
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
      body.harness && body.harness !== "fake-worker" ? body.harness : null
    );
    broadcastPeerDirectory(db, nodeSockets);
    orchestrate(db, nodeSockets, app);
    onChange();
    return;
  }

  if (env.type === "task.event") {
    appendEvent(db, env.project, body.taskId, "task.event", body);
    return;
  }

  if (env.type === "task.result") {
    const t = getTask(db, body.taskId);
    if (!t) return;
    const isSideEffect = isSideEffecting(env.type);
    if (isSideEffect && env.idem) {
      if (seenResultIdem.has(env.idem)) return;
      seenResultIdem.add(env.idem);
    }
    const terminal = ["completed", "failed", "canceled", "rejected"].includes(t.state);
    if (terminal) {
      appendEvent(db, t.project_id, t.id, "task.late_result", body);
      app.log.warn({ taskId: t.id }, "late result for an already-terminal task — preserved, not applied");
      onChange();
      return;
    }
    if (!canTransition(t.state, body.state)) {
      appendEvent(db, t.project_id, t.id, "task.result.rejected", { attempted: body.state, from: t.state });
      return;
    }

    const activeAttempt = getActiveTaskAttempt(db, t.id);
    if (activeAttempt) {
      finishTaskAttempt(db, activeAttempt.id, {
        state: body.state === "completed" ? "completed" : "failed",
        exitCode: body.exitCode ?? (body.state === "completed" ? 0 : 1),
        errorMessage: body.error ?? body.summary ?? null,
        costUsd: body.costUsd ?? 0,
      });
    }

    setTaskState(db, t.id, body.state, { ended_at: new Date().toISOString(), cost_usd: body.costUsd ?? t.cost_usd });
    if (t.kind === "plan" && body.state === "completed") {
      proposePlanFromOutput(db, t, extra.onChat);
    }
    if (t.agent_id) setAgentStatus(db, t.agent_id, "idle", null);
    appendEvent(db, t.project_id, t.id, "task.result", body);

    if (body.state === "completed") {
      const dependents = getTaskDependents(db, t.id);
      for (const dep of dependents) {
        if (isTaskDependenciesSatisfied(db, dep.taskId)) {
          appendEvent(db, t.project_id, dep.taskId, "task.dependency_satisfied", {
            completedDependency: t.id,
            taskId: dep.taskId,
          });
          const depTask = getTask(db, dep.taskId);
          if (depTask && depTask.state === "submitted" && depTask.agent_id) {
            sendTaskOffer(db, nodeSockets, depTask.id);
          }
        }
      }
    } else if (["failed", "canceled", "rejected"].includes(body.state)) {
      const dependents = getTaskDependents(db, t.id);
      for (const dep of dependents) {
        appendEvent(db, t.project_id, dep.taskId, "task.dependency_blocked", {
          failedDependency: t.id,
          state: body.state,
          taskId: dep.taskId,
        });
      }

      const failureCat = classifyFailure(body.error || body.summary, body.exitCode, false);
      appendEvent(db, t.project_id, t.id, "task.failure_classified", {
        taskId: t.id,
        failureCategory: failureCat,
        error: body.error || body.summary || null,
        exitCode: body.exitCode ?? 1,
      });

      const policy = getRetryPolicy(db, t.project_id, t.id);
      const attempts = getTaskAttempts(db, t.id);
      if (attempts.length < policy.maxAttempts && policy.retryOn.includes(failureCat) && body.state === "failed") {
        const candidates = candidateAgents(db, t.project_id);
        const altAgent = policy.preferDifferentAgent
          ? candidates.find((c) => c.machineOnline && c.id !== t.agent_id)
          : candidates.find((c) => c.machineOnline);

        const retryTaskId = createTask(db, {
          projectId: t.project_id,
          title: `[Retry ${attempts.length + 1}] ${t.title.replace(/^\[Retry \d+\]\s*/, "")}`,
          spec: t.spec,
          creatorId: "supervisor",
          parentTask: t.parent_task || t.id,
          retryOf: t.id,
          agentId: altAgent?.id ?? null,
          requiredCapability: t.required_capability,
          workflowId: t.workflow_id,
          budgetSeconds: t.budget_seconds,
          budgetUsd: t.budget_usd,
        });

        appendEvent(db, t.project_id, t.id, "task.retry_scheduled", {
          originalTaskId: t.id,
          retryTaskId,
          attemptNumber: attempts.length + 1,
          assignedAgentId: altAgent?.id ?? null,
        });
        appendEvent(db, t.project_id, retryTaskId, "task.recovery_started", {
          originalTaskId: t.id,
          retryTaskId,
        });

        if (altAgent) {
          sendTaskOffer(db, nodeSockets, retryTaskId);
        }
      } else if (attempts.length >= policy.maxAttempts) {
        appendEvent(db, t.project_id, t.id, "task.retry_exhausted", {
          taskId: t.id,
          attemptsCount: attempts.length,
          maxAttempts: policy.maxAttempts,
        });
      }
    }

    if (t.workflow_id) {
      updateWorkflowStatusFromTasks(db, t.workflow_id);
    }

    orchestrate(db, nodeSockets, app);
    onChange();
    return;
  }
}
