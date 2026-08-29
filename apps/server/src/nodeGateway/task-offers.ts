import type { FastifyInstance } from "fastify";
import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import {
  getTask, getWorkflow, isTaskDependenciesSatisfied,
  consumeAgentSteer, tasksForMachine
} from "../db.js";
import type { NodeSockets } from "./types.js";

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

// Shared by /debug/offer-task and the chat approve flow (gateway.ts) — the
// only two places a task actually gets sent to a runner. Returns false
// (task stays `submitted`, silently retried on the runner's next reconnect
// via reconcileOnConnect) if the runner isn't currently connected.
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
