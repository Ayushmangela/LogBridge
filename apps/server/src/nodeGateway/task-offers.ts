import type { FastifyInstance } from "fastify";
import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import {
  getTask, getWorkflow, isTaskDependenciesSatisfied,
  consumeAgentSteer, tasksForMachine, setTaskState, setAgentStatus,
  createTaskAttempt, renewLease, appendEvent,
  getActiveTaskAttempt, finishTaskAttempt, getTaskDependents,
} from "../db.js";
import type { NodeSockets } from "./types.js";
import { spawnAndSubmit, watchForCompletion, extractRecentReply } from "../ptyGateway.js";
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
 * Completion is detected, not assumed — watchForCompletion (ptyGateway.ts)
 * watches the PTY for the CLI returning to its ready-for-input prompt after
 * genuinely having been mid-task, and calls completeLocalTask when it does.
 * That is a heuristic (see watchForCompletion's own comment for its known
 * gaps), not a real protocol — POST /api/tasks/:id/complete remains the
 * manual fallback for whatever it misses.
 *
 * postChat, if given, is how the agent's actual answer reaches the room.
 * Before this, a direct "@cat hi" got exactly one line back — "On it —
 * hi" — and then silence forever: the task machinery tracked that
 * something ran, but nothing ever looked at what the agent actually said
 * and put it where the human were looking. extractRecentReply
 * (ptyGateway.ts) renders the session's raw output through the same engine
 * the browser's terminal widget uses and reads back the plain text.
 *
 * When extractRecentReply comes back empty (its own filtering rejected
 * everything it saw as chrome or an unreadable fragment), a short, honest
 * note is posted instead of nothing — a null reply completing in total
 * silence is the exact same dead end "hi" -> "On it" -> nothing was, just
 * rarer. The note says plainly that nothing readable was captured, not
 * that the agent said nothing.
 */
export function deliverTaskLocally(
  db: Db, nodeSockets: NodeSockets, taskId: string, hive?: HiveManager,
  postChat?: (agentId: string, agentName: string, text: string) => void
): boolean {
  const task = getTask(db, taskId);
  if (!task || !task.agent_id) return false;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any;
  if (!agent) return false;

  const spec = task.spec ?? task.title;
  const submitted = spawnAndSubmit(db, agent.id, agent.name, spec, hive, () => {
    watchForCompletion(agent.id, () => {
      extractRecentReply(agent.id).then((reply) => {
        if (postChat) {
          postChat(agent.id, agent.name, reply ||
            "(finished, but nothing readable came through — open my terminal to see what happened)");
        }
        completeLocalTask(db, nodeSockets, task.id, true);
      });
    });
  });
  if (!submitted) return false;

  setTaskState(db, task.id, "working", { started_at: task.started_at ?? new Date().toISOString() });
  renewLease(db, task.id, LOCAL_DELIVERY_LEASE_SECONDS);
  setAgentStatus(db, agent.id, "working", task.id);
  createTaskAttempt(db, { taskId: task.id, agentId: agent.id });
  appendEvent(db, task.project_id, task.id, "task.accept", {
    taskId: task.id, agentId: agent.id, via: "local-pty",
  });
  return true;
}

/**
 * The other half of deliverTaskLocally's honest gap: nothing watches a local
 * PTY for completion, so a task it delivered stays `working` — and the
 * agent stays "busy" — until something says otherwise. Concretely: a second
 * chat instruction to the same agent is silently dropped (parseMention in
 * gateway.ts only creates a task for an idle agent), so without this, one
 * locally-delivered task permanently ends a human's ability to talk to that
 * agent through chat again.
 *
 * This does by hand what a real runner's `task.result` WS message does
 * automatically — same state transition, same attempt bookkeeping, same
 * dependent-task wakeup — for the case where a human (or, later, a real
 * output-completion detector) is the one reporting it, not a runner.
 */
export function completeLocalTask(db: Db, nodeSockets: NodeSockets, taskId: string, ok = true): boolean {
  const task = getTask(db, taskId);
  if (!task || task.state === "completed" || task.state === "failed") return false;

  const activeAttempt = getActiveTaskAttempt(db, task.id);
  if (activeAttempt) {
    finishTaskAttempt(db, activeAttempt.id, {
      state: ok ? "completed" : "failed",
      exitCode: ok ? 0 : 1,
      errorMessage: null,
      costUsd: 0,
    });
  }

  const finalState = ok ? "completed" : "failed";
  setTaskState(db, task.id, finalState, { ended_at: new Date().toISOString() });
  if (task.agent_id) setAgentStatus(db, task.agent_id, "idle", null);
  appendEvent(db, task.project_id, task.id, "task.result", { taskId: task.id, state: finalState, via: "local-pty" });

  if (ok) {
    for (const dep of getTaskDependents(db, task.id)) {
      if (isTaskDependenciesSatisfied(db, dep.taskId)) {
        appendEvent(db, task.project_id, dep.taskId, "task.dependency_satisfied", {
          completedDependency: task.id, taskId: dep.taskId,
        });
        const depTask = getTask(db, dep.taskId);
        if (depTask && depTask.state === "submitted" && depTask.agent_id) {
          sendTaskOffer(db, nodeSockets, depTask.id);
        }
      }
    }
  }
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
