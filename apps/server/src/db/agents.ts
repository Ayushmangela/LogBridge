import type { Db } from "./types.js";
import { appendEvent } from "./schema.js";

// Every caller of this (task.accept -> "working", task.result -> "idle")
// is a real lifecycle transition away from waiting on anyone — clear
// waiting_on here so it can't outlive the needs_input state that set it.
// waiting_on's only other writer is setAgentWaitingOnHuman/clearAgentWaiting.
export function setAgentStatus(db: Db, agentId: string, status: string, currentTask: string | null) {
  // Work always wins over being summoned (Phase 4): the moment an agent
  // gets a task it must leave the caller's position and return to its zone.
  if (status === "working") {
    db.prepare("UPDATE agents SET status = ?, current_task = ?, waiting_on = NULL, summoned_by = NULL, summoned_at = NULL, summoned_x = NULL, summoned_y = NULL WHERE id = ?").run(
      status, currentTask, agentId
    );
  } else {
    db.prepare("UPDATE agents SET status = ?, current_task = ?, waiting_on = NULL WHERE id = ?").run(
      status, currentTask, agentId
    );
  }
}

// The agent is now blocked on a specific human decision — a task proposal,
// a mid-task question, whatever. zoneFor() already maps this to needs_human
// and resolves the right cabin; this is the only write side of that.
export function setAgentWaitingOnHuman(db: Db, agentId: string, humanName: string) {
  db.prepare("UPDATE agents SET status = 'needs_input', waiting_on = ? WHERE id = ?").run(
    `human: ${humanName}`,
    agentId
  );
}

export function clearAgentWaiting(db: Db, agentId: string) {
  db.prepare("UPDATE agents SET status = 'idle', waiting_on = NULL, current_task = NULL WHERE id = ?").run(agentId);
}

export function setAgentPaused(db: Db, agentId: string, paused: boolean): void {
  db.prepare("UPDATE agents SET paused = ?, paused_at = ? WHERE id = ?").run(
    paused ? 1 : 0, paused ? new Date().toISOString() : null, agentId
  );
}

export function setAgentRetired(db: Db, agentId: string, retired: boolean): void {
  db.prepare("UPDATE agents SET retired = ?, retired_at = ? WHERE id = ?").run(
    retired ? 1 : 0, retired ? new Date().toISOString() : null, agentId
  );
}

export function deleteAgent(db: Db, agentId: string): void {
  // Keep memories and task history — see HANDOFF-SERVER-2 Phase 1 decision:
  // deleting the rows would lose team knowledge the memory feature exists to
  // accumulate. Retire is the soft-delete; hard-delete keeps the history but
  // removes the roster entry.
  db.prepare("INSERT OR IGNORE INTO deleted_agents (id, deleted_at) VALUES (?, ?)").run(
    agentId, new Date().toISOString()
  );
  db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
}

export function isAgentDeleted(db: Db, agentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM deleted_agents WHERE id = ?").get(agentId);
}

// ---- Agent Steer (HANDOFF-SERVER-2 Phase 3) ----
export function setAgentSteer(db: Db, agentId: string, text: string): void {
  db.prepare("UPDATE agents SET steer_context = ? WHERE id = ?").run(text.trim(), agentId);
}

export function consumeAgentSteer(db: Db, agentId: string): string | null {
  const row = db.prepare("SELECT steer_context FROM agents WHERE id = ?").get(agentId) as any;
  if (!row?.steer_context) return null;
  db.prepare("UPDATE agents SET steer_context = NULL WHERE id = ?").run(agentId);
  return row.steer_context;
}

// ---- Move & Clone Agent (HANDOFF-SERVER-2 Phase 3) ----
export function moveAgent(db: Db, agentId: string, targetProjectId: string): boolean {
  const prj = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(targetProjectId);
  if (!prj) return false;
  const res = db.prepare("UPDATE agents SET project_id = ? WHERE id = ?").run(targetProjectId, agentId);
  return res.changes > 0;
}

export function cloneAgent(db: Db, agentId: string, targetProjectId: string, newName?: string): any {
  const prj = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(targetProjectId);
  if (!prj) return null;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) return null;

  const newId = `agt_${crypto.randomUUID()}`;
  const name = newName?.trim() || `${agent.name}-clone`;
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, current_task,
                         character, color, folder, isolation, description, goal, provider, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId, agent.machine_id, agent.owner_id, targetProjectId,
    name, agent.role, agent.capabilities, agent.concurrency,
    agent.character, agent.color, agent.folder, agent.isolation,
    agent.description, agent.goal, agent.provider, agent.model ?? null
  );

  return db.prepare("SELECT * FROM agents WHERE id = ?").get(newId);
}

// ---------------- summon (HANDOFF-PRESENCE Phase 4) ----------------
// A real event, not a local tween — stored on the agent row so every
// browser sees it, cleared when the agent gets work (work always wins) or
// when the caller dismisses.
export function summonAgent(db: Db, agentId: string, by: string, x: number, y: number): void {
  db.prepare(
    "UPDATE agents SET summoned_by = ?, summoned_at = ?, summoned_x = ?, summoned_y = ? WHERE id = ?"
  ).run(by, new Date().toISOString(), x, y, agentId);
}

export function clearSummon(db: Db, agentId: string): void {
  db.prepare(
    "UPDATE agents SET summoned_by = NULL, summoned_at = NULL, summoned_x = NULL, summoned_y = NULL WHERE id = ?"
  ).run(agentId);
}

export function getSummon(db: Db, agentId: string): { by: string; at: string; x: number; y: number } | null {
  const row = db.prepare("SELECT summoned_by AS by, summoned_at AS at, summoned_x AS x, summoned_y AS y FROM agents WHERE id = ?").get(agentId) as any;
  if (!row?.by) return null;
  return row;
}

// ---- delegation consent grants (SEALED.md, DECISIONS.md D13) ----
// grantor = the owner whose machine would run the work; grantee = the owner
// whose agent asked. mode 'always' auto-forwards future requests for this
// capability; 'never' auto-denies them. Absence = ask every time.

import type { GrantMode } from "./types.js";

export function getGrant(
  db: Db, grantorId: string, granteeId: string, projectId: string | null, capability: string
): GrantMode | null {
  const row = db
    .prepare(
      `SELECT mode FROM grants
       WHERE grantor_id = ? AND grantee_id = ? AND capability = ?
         AND (project_id IS NULL OR project_id = ?)
       ORDER BY created DESC LIMIT 1`
    )
    .get(grantorId, granteeId, capability, projectId ?? null) as any;
  return row?.mode === "always" || row?.mode === "never" ? row.mode : null;
}

export function setGrant(
  db: Db, grantorId: string, granteeId: string, projectId: string | null,
  capability: string, mode: GrantMode
): void {
  // One row per (grantor, grantee, project, capability): a new decision
  // REPLACES the old one — changing your mind is allowed and expected.
  db.prepare(
    `INSERT INTO grants (id, grantor_id, grantee_id, project_id, capability, mode, created)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, created = excluded.created`
  ).run(
    `gr_${grantorId}_${granteeId}_${projectId ?? "*"}_${capability}`,
    grantorId, granteeId, projectId ?? null, capability, mode, new Date().toISOString()
  );
}
