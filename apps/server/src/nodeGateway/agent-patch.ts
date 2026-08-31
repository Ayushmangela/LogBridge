// Push an agent edit down to the machine that runs it.
//
// `agent.patch` has been in the protocol since 1.25 with no sender and no
// handler — editing an agent updated the server row and stopped there. That
// was harmless for display fields (a colour lives only in the view), but tool
// policy is ENFORCED on the runner, from its own created-agents.json. Without
// this message the browser shows a policy the runner is not applying.
//
// Fire-and-forget on purpose: there is no result envelope to await, the server
// row is already the durable copy, and the runner re-reads it at handshake. A
// machine that is offline picks the change up when it reconnects.
import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import type { NodeSockets } from "./types.js";

export function notifyAgentPatched(
  db: Db,
  nodeSockets: NodeSockets,
  agentId: string,
  patch: { allowTools?: string[] | null; denyPaths?: string[] | null }
): boolean {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) return false;

  const socket = nodeSockets.get(agent.machine_id);
  if (!socket || socket.readyState !== socket.OPEN) return false;

  const env: EnvelopeT = {
    v: 1,
    id: crypto.randomUUID(),
    type: "agent.patch",
    project: agent.project_id ?? "",
    from: { kind: "server", id: "server" },
    to: { kind: "node", id: agent.machine_id },
    task: null,
    idem: crypto.randomUUID(),
    ts: new Date().toISOString(),
    // Only the fields that were actually edited. An omitted field means
    // "leave it alone" on the runner, which is why they are not defaulted.
    body: {
      agentId,
      ...(patch.allowTools !== undefined ? { allowTools: patch.allowTools } : {}),
      ...(patch.denyPaths !== undefined ? { denyPaths: patch.denyPaths } : {}),
    },
  };

  try {
    socket.send(JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}
