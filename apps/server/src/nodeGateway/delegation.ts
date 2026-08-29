import type { FastifyInstance } from "fastify";
import type { ChatMessageT, EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import { setGrant, appendEvent } from "../db.js";
import type { NodeSockets, HeldDelegation } from "./types.js";

export const pendingDelegationConsents = new Map<string, HeldDelegation>();

export function holdForConsent(
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

export function denySealedRequest(
  db: Db, nodeSockets: NodeSockets, reqEnv: EnvelopeT, requestId: string,
  _requesterOwnerId: string, reason: string, app: FastifyInstance
) {
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
