// Telling the machine that runs an agent that its state changed.
//
// `agent.pause`, `agent.resume`, `agent.retire`, `agent.unretire` and
// `agent.delete` have been in the protocol since 1.25 with **no sender and no
// handler** — the same shape `agent.patch` was in before it was wired.
//
// The consequence is only invisible while every agent is local. On this
// machine, Delete kills the PTY directly (`killAgentSession`) and Pause works
// because the orchestrator filters `paused = 0` when picking candidates. On a
// FRIEND'S machine neither is true:
//
//   * Pause stopped new offers but the runner never heard, so an agent
//     mid-task kept going.
//   * Delete removed the row here and left their CLI running — no roster
//     entry, no terminal panel, no way to stop it short of finding the PID,
//     while it kept spending real money.
//
// Fire-and-forget, like agent-patch.ts: the server row is already the durable
// truth and a machine that is offline reconciles when it reconnects.
import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import type { NodeSockets } from "./types.js";

export type LifecycleEvent =
  | "agent.pause"
  | "agent.resume"
  | "agent.retire"
  | "agent.unretire"
  | "agent.delete";

/**
 * Tell the agent's machine. Returns false when there is nothing to tell —
 * a local agent (handled directly by the PTY gateway) or an offline runner.
 */
export function notifyAgentLifecycle(
  db: Db,
  nodeSockets: NodeSockets,
  agentId: string,
  type: LifecycleEvent
): boolean {
  const agent = db.prepare("SELECT id, project_id, machine_id FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) return false;

  const socket = nodeSockets.get(agent.machine_id);
  if (!socket || socket.readyState !== socket.OPEN) return false;

  const env: EnvelopeT = {
    v: 1,
    id: crypto.randomUUID(),
    type,
    project: agent.project_id ?? "",
    from: { kind: "server", id: "server" },
    to: { kind: "node", id: agent.machine_id },
    task: null,
    idem: crypto.randomUUID(),
    ts: new Date().toISOString(),
    body: { agentId },
  };

  try {
    socket.send(JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}
