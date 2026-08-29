import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import type { NodeSockets } from "./types.js";

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
