import type { FastifyInstance } from "fastify";
import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import {
  getTask, getWorkflow, isTaskDependenciesSatisfied,
  consumeAgentSteer, tasksForMachine, setTaskState, setAgentStatus,
  createTaskAttempt, renewLease, appendEvent,
} from "../db.js";
import type { NodeSockets } from "./types.js";
import { spawnOrGetPtySession, submitPromptToAgent } from "../ptyGateway.js";
import type { HiveManager } from "../hive.js";

export function taskCancelEnvelope(taskId: string, projectId: string, machineId: string, by: string, reason: string | null): EnvelopeT {
  return {
    v: 1, id: crypto.randomUUID(), type: "task.cancel", project: projectId,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: machineId },
    task: taskId, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: { taskId, by, reason },
  };
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

// Local fallback lease: an agent whose CLI runs as an in-process PTY on this
// same machine (the common case — "Create New Project" / "Add an agent" in
// the UI, no separate `apps/runner` process) never speaks the node-ws
// protocol, so it can never send task.accept/task.status heartbeats to renew
// a lease the normal way. A short lease would make the sweep in
// nodeGateway/gateway.ts fail the task out from under a terminal that is
// still genuinely working on it. A day is long enough that the sweep is not
// the thing that ends a locally-delivered task — the terminal reporting
// done (or a human stopping it) is.
const LOCAL_DELIVERY_LEASE_SECONDS = 24 * 60 * 60;

/**
 * Fallback for the human-facing chat/approve paths in gateway.ts ONLY — not
 * folded into sendTaskOffer itself, deliberately. sendTaskOffer returning
 * false is a load-bearing signal for its OTHER callers (retries, workflow
 * steps, the lease sweep's requeue): "no runner right now" there can mean a
 * real remote machine mid-reconnect, and the correct, safe behavior is to
 * leave the task `submitted` and let reconcileOnConnect deliver it the
 * moment that machine's hello lands — folding this in there caused exactly
 * that race to fail (a test's "restart the runner, immediately offer a
 * task" now missed the reconnect because the task had already been silently
 * claimed and marked `working` here before the real hello arrived).
 *
 * The chat/approve paths are different: they're a human typing to an agent
 * they are looking at right now, most commonly one created through the UI
 * with no separate `apps/runner` process at all — there the right answer to
 * "no runner connected" is "run it in the terminal that's already open,"
 * not "wait and hope."
 *
 * Not full parity with the remote protocol: nothing here detects
 * completion, so the task sits `working` until the terminal (or a human)
 * says otherwise.
 */
export function deliverTaskLocally(db: Db, taskId: string, hive?: HiveManager): boolean {
  const task = getTask(db, taskId);
  if (!task || !task.agent_id) return false;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any;
  if (!agent) return false;

  const ptyId = "pty-" + String(agent.name).toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + String(agent.id).slice(-8);
  try {
    spawnOrGetPtySession(db, ptyId, agent.id, 100, 30, hive);
  } catch {
    return false;
  }
  const spec = task.spec ?? task.title;
  if (!submitPromptToAgent(agent.id, spec)) return false;

  setTaskState(db, task.id, "working", { started_at: task.started_at ?? new Date().toISOString() });
  renewLease(db, task.id, LOCAL_DELIVERY_LEASE_SECONDS);
  setAgentStatus(db, agent.id, "working", task.id);
  createTaskAttempt(db, { taskId: task.id, agentId: agent.id });
  appendEvent(db, task.project_id, task.id, "task.accept", {
    taskId: task.id, agentId: agent.id, via: "local-pty",
  });
  return true;
}

// Shared by /debug/offer-task, internal retries, and the chat approve flow
// (gateway.ts) — every place a task actually gets sent to a runner. Returns
// false (task stays `submitted`, silently retried on the runner's next
// reconnect via reconcileOnConnect) if the runner isn't currently connected.
export function sendTaskOffer(db: Db, nodeSockets: NodeSockets, taskId: string): boolean {
  const task = getTask(db, taskId);
  if (!task || !task.agent_id) return false;
  if (task.workflow_id) {
    const wf = getWorkflow(db, task.workflow_id);
    if (!wf || wf.state !== "active") return false;
  }
  if (!isTaskDependenciesSatisfied(db, task.id)) return false;

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any;
  if (!agent) return false;
  const socket = nodeSockets.get(agent.machine_id);
  if (!socket || socket.readyState !== socket.OPEN) return false;
  const steer = consumeAgentSteer(db, task.agent_id);
  socket.send(JSON.stringify(taskOfferEnvelope({ ...task, _machineId: agent.machine_id }, steer)));
  return true;
}

export function reconcileOnConnect(db: Db, machineId: string, send: (m: unknown) => void, app: FastifyInstance) {
  for (const t of tasksForMachine(db, machineId, ["submitted"])) {
    send(taskOfferEnvelope(t));
  }
  for (const t of tasksForMachine(db, machineId, ["working", "blocked"])) {
    send({
      v: 1, id: crypto.randomUUID(), type: "task.status", project: t.project_id,
      from: { kind: "server", id: "server" }, to: { kind: "node", id: machineId },
      task: t.id, idem: null, ts: new Date().toISOString(),
      body: { taskId: t.id, state: t.state, note: "resume-check" },
    });
  }
  app.log.info({ machineId }, "reconciled tasks on reconnect");
}
