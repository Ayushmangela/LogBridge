import type { Db } from "./types.js";

// ---------------- machines: trust-on-first-sight, pubkey pinned after that ----------------
// No enrollment-code UI exists yet (that's a real web flow for later). For now an
// unknown machine id is registered on its first successful signature verification
// and its pubkey is pinned from then on — see apps/runner and DECISIONS.md D23.
export function getMachine(db: Db, id: string) {
  return db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as
    | { id: string; owner_id: string; name: string; pubkey: string; online: number; revoked: number }
    | undefined;
}

export function registerMachine(
  db: Db, id: string, ownerId: string, name: string, pubkey: string, sealingPubkey?: string | null
) {
  db.prepare(
    "INSERT INTO machines (id, owner_id, name, pubkey, sealing_pubkey, last_seen, online, revoked) VALUES (?, ?, ?, ?, ?, ?, 1, 0)"
  ).run(id, ownerId, name, pubkey, sealingPubkey ?? null, new Date().toISOString());
}

// Re-recorded on every handshake — these are runtime flags and PATH state,
// both of which change between runner restarts. Stale "installed providers"
// would grey out something that now exists (or offer something that's gone).
export function setMachineCapabilities(
  db: Db, machineId: string, providers: unknown,
  allowAgentCreation: boolean, allowUnsandboxed: boolean, acceptDelegations: boolean
) {
  db.prepare(
    "UPDATE machines SET providers = ?, allow_agent_creation = ?, allow_unsandboxed = ?, accept_delegations = ? WHERE id = ?"
  ).run(
    JSON.stringify(providers ?? []), allowAgentCreation ? 1 : 0,
    allowUnsandboxed ? 1 : 0, acceptDelegations ? 1 : 0, machineId
  );
}

// A machine that connected before it had a sealing key (or that rotated one)
// gets it recorded on the next handshake. Pinning is handled by the caller —
// this is the raw write.
export function setSealingPubkey(db: Db, machineId: string, sealingPubkey: string) {
  db.prepare("UPDATE machines SET sealing_pubkey = ? WHERE id = ?").run(sealingPubkey, machineId);
}

/** The sealing key to encrypt to when sending to an agent. Null means that
 *  agent's machine hasn't published one — the caller must NOT silently fall
 *  back to plaintext; see nodeGateway's delegate handler. */
export function sealingKeyForAgent(db: Db, agentId: string): { machineId: string; sealingPubkey: string | null } | null {
  const row = db
    .prepare(
      `SELECT a.machine_id AS machineId, m.sealing_pubkey AS sealingPubkey
       FROM agents a JOIN machines m ON m.id = a.machine_id WHERE a.id = ?`
    )
    .get(agentId) as any;
  return row ? { machineId: row.machineId, sealingPubkey: row.sealingPubkey ?? null } : null;
}

export function markMachineOnline(db: Db, id: string, online: boolean) {
  db.prepare("UPDATE machines SET online = ?, last_seen = ? WHERE id = ?").run(
    online ? 1 : 0,
    new Date().toISOString(),
    id
  );
}
