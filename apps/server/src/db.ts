import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  gh_login TEXT UNIQUE,
  name TEXT,
  avatar INT
);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT,
  pubkey TEXT,
  sealing_pubkey TEXT,
  last_seen TEXT,
  online INT DEFAULT 0,
  revoked INT DEFAULT 0,
  -- what the machine reported at handshake: installed providers (JSON array
  -- of {id,label,policy,verified,models}) and its own two gates. The UI
  -- renders these; the RUNNER is what enforces them.
  providers TEXT,
  allow_agent_creation INT DEFAULT 0,
  allow_unsandboxed INT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  owner_id TEXT,
  project_id TEXT,
  name TEXT,
  role TEXT,
  capabilities TEXT,
  concurrency INT DEFAULT 1,
  status TEXT DEFAULT 'idle',
  current_task TEXT,
  zone_anchor INT,
  waiting_on TEXT,
  github_ref TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  gh_repo TEXT UNIQUE,
  name TEXT,
  layout TEXT DEFAULT 'office',
  call_link TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT,
  spec TEXT,
  creator_id TEXT,
  agent_id TEXT,
  state TEXT,
  lease_expires TEXT,
  budget_seconds INTEGER DEFAULT 60,
  budget_usd REAL DEFAULT 1.0,
  cost_usd REAL DEFAULT 0,
  required_capability TEXT,
  created_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  parent_task TEXT,
  retry_of TEXT,
  idem TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  task_id TEXT,
  type TEXT,
  body TEXT,
  ts TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  grantor_id TEXT,
  grantee_id TEXT,
  project_id TEXT,
  capability TEXT,
  mode TEXT,
  created TEXT
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  scope TEXT,            -- 'project' (team knowledge) | 'agent' (own notes)
  scope_id TEXT,         -- agent id when scope='agent', else NULL
  kind TEXT,             -- fact | preference | decision | outcome
  text TEXT,
  source_task_id TEXT,
  agent_id TEXT,
  agent_name TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project_id, created_at DESC);
-- Same text, same scope, written twice is one memory, not two. This is what
-- stops an agent that repeats itself every task from burying everything else.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe
  ON memories (project_id, scope, IFNULL(scope_id, ''), text);

-- FTS5 external-content index over memories.text. Retrieval is lexical
-- (BM25), NOT semantic embeddings — see MEMORY.md's "what this is not".
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, content='memories', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks (agent_id);
`;

export function openDb(dbPath?: string): Db {
  const path = dbPath ?? process.env.DB_PATH ?? join(process.cwd(), "data.db");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // No migration framework (D7: SQLite, deliberately minimal) — `CREATE
  // TABLE IF NOT EXISTS` is a no-op against a db file from before a column
  // existed. This is the one column added after the fact so far; if more
  // pile up, that's the signal to actually build migrations.
  for (const alter of [
    "ALTER TABLE tasks ADD COLUMN created_at TEXT",
    "ALTER TABLE machines ADD COLUMN sealing_pubkey TEXT",
    "ALTER TABLE tasks ADD COLUMN required_capability TEXT",
    "ALTER TABLE machines ADD COLUMN providers TEXT",
    "ALTER TABLE machines ADD COLUMN allow_agent_creation INT DEFAULT 0",
    "ALTER TABLE machines ADD COLUMN allow_unsandboxed INT DEFAULT 0",
  ]) {
    try {
      db.exec(alter);
    } catch {
      // already there, either from SCHEMA on a fresh db or a prior run of this
    }
  }
  return db;
}

export function appendEvent(
  db: Db,
  projectId: string | null,
  taskId: string | null,
  type: string,
  body: unknown
): number {
  const row = db
    .prepare(
      "INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?) RETURNING seq"
    )
    .get(projectId, taskId, type, JSON.stringify(body ?? null), new Date().toISOString()) as {
    seq: number;
  };
  return row.seq;
}

export function lastSeq(db: Db): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as {
    seq: number;
  };
  return row.seq;
}

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
  db: Db, machineId: string, providers: unknown, allowAgentCreation: boolean, allowUnsandboxed: boolean
) {
  db.prepare(
    "UPDATE machines SET providers = ?, allow_agent_creation = ?, allow_unsandboxed = ? WHERE id = ?"
  ).run(JSON.stringify(providers ?? []), allowAgentCreation ? 1 : 0, allowUnsandboxed ? 1 : 0, machineId);
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

// ---------------- tasks: the queue IS the tasks table ----------------
// A task in `submitted` assigned to one of a machine's agents is an offer
// waiting for that machine to come online. A task still `working`/`blocked`
// when a machine reconnects is what reconciliation resumes.
export function tasksForMachine(db: Db, machineId: string, states: string[]) {
  const placeholders = states.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT t.*, a.machine_id AS _machineId FROM tasks t
       JOIN agents a ON a.id = t.agent_id
       WHERE a.machine_id = ? AND t.state IN (${placeholders})
       ORDER BY t.id`
    )
    .all(machineId, ...states) as any[];
}

export function getTask(db: Db, id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any | undefined;
}

export function setTaskState(db: Db, id: string, state: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  const setSql = ["state = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  db.prepare(`UPDATE tasks SET ${setSql} WHERE id = ?`).run(state, ...cols.map((c) => extra[c]), id);
}

export function renewLease(db: Db, id: string, leaseSeconds: number) {
  const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  db.prepare("UPDATE tasks SET lease_expires = ? WHERE id = ?").run(expires, id);
  return expires;
}

// Tasks whose lease has silently expired — the runner went away without
// telling anyone. See SYSTEM.md "the idempotency trap".
export function expiredLeaseTasks(db: Db) {
  return db
    .prepare("SELECT * FROM tasks WHERE state IN ('working','blocked') AND lease_expires < ?")
    .all(new Date().toISOString()) as any[];
}

// Every caller of this (task.accept -> "working", task.result -> "idle")
// is a real lifecycle transition away from waiting on anyone — clear
// waiting_on here so it can't outlive the needs_input state that set it.
// waiting_on's only other writer is setAgentWaitingOnHuman/clearAgentWaiting.
export function setAgentStatus(db: Db, agentId: string, status: string, currentTask: string | null) {
  db.prepare("UPDATE agents SET status = ?, current_task = ?, waiting_on = NULL WHERE id = ?").run(
    status,
    currentTask,
    agentId
  );
}

// A task proposed via chat (D16: natural language in, typed contract out)
// sits in `submitted` without being offered to the runner yet — the human
// has to approve it first. See M4-KICKOFF.md.
export function createTask(
  db: Db,
  opts: {
    projectId: string;
    title: string;
    spec?: string | null;
    creatorId: string;
    agentId?: string | null;        // null = let the orchestrator decide
    requiredCapability?: string | null;
    budgetSeconds?: number;
    budgetUsd?: number;
  }
): string {
  const taskId = `tsk_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, required_capability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 0, ?, ?)`
  ).run(
    taskId, opts.projectId, opts.title, opts.spec ?? null, opts.creatorId, opts.agentId ?? null,
    opts.budgetSeconds ?? 60, opts.budgetUsd ?? 1.0, opts.requiredCapability ?? null, new Date().toISOString()
  );
  return taskId;
}

// The Kanban board's data source — every task in the project, most recent
// first, capped so a long-lived project's board doesn't ship its entire
// history on every view update (see CONTRACT.md invariant 1: full snapshot,
// no deltas — that only stays cheap if the snapshot itself stays bounded).
export function tasksForProject(db: Db, projectId: string, limit = 100) {
  return db
    .prepare(
      `SELECT t.*, a.name AS agent_name FROM tasks t
       LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.project_id = ?
       ORDER BY t.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as any[];
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

// ---------------- orchestrator (ORCHESTRATOR.md) ----------------

/** Tasks waiting for someone to run them, oldest first (fair queueing).
 *
 *  Tie-broken on rowid, not id: created_at is only millisecond-resolution, so
 *  several tasks submitted in the same millisecond carry identical timestamps,
 *  and falling back to a random UUID would make the "queue" arbitrary rather
 *  than FIFO. rowid is insertion order by definition. */
export function pendingUnassignedTasks(db: Db) {
  return db
    .prepare(
      `SELECT id, project_id, required_capability FROM tasks
       WHERE state = 'submitted' AND agent_id IS NULL
       ORDER BY created_at ASC, rowid ASC`
    )
    .all() as { id: string; project_id: string; required_capability: string | null }[];
}

/** How much each agent is already carrying. Only non-terminal, actually-held
 *  work counts — a completed task occupies nobody. */
export function activeTaskCountsByAgent(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT agent_id AS agentId, COUNT(*) AS n FROM tasks
       WHERE agent_id IS NOT NULL AND state IN ('submitted','working','blocked','input-required','auth-required')
       GROUP BY agent_id`
    )
    .all() as any[];
  return new Map(rows.map((r) => [r.agentId, Number(r.n)]));
}

export function candidateAgents(db: Db, projectId: string) {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.capabilities, a.concurrency, m.online
       FROM agents a JOIN machines m ON m.id = a.machine_id
       WHERE a.project_id = ?`
    )
    .all(projectId) as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    capabilities: (() => { try { return JSON.parse(r.capabilities ?? "[]"); } catch { return []; } })(),
    concurrency: Number(r.concurrency ?? 1),
    machineOnline: Boolean(r.online),
  }));
}

/** Claim a task for an agent. The `agent_id IS NULL` guard makes this a no-op
 *  if something else already claimed it, so a double call can't double-assign. */
export function assignTaskToAgent(db: Db, taskId: string, agentId: string): boolean {
  const res = db
    .prepare("UPDATE tasks SET agent_id = ? WHERE id = ? AND agent_id IS NULL AND state = 'submitted'")
    .run(agentId, taskId);
  return res.changes > 0;
}

// ---------------- shared memory (MEMORY.md) ----------------
// Lives on the server, not the node, precisely so an agent on one machine
// can recall what an agent on another machine learned (D2). The runner is
// stateless about memory — it asks, it writes, it never caches.

export interface MemoryRow {
  id: string;
  scope: "project" | "agent";
  kind: "fact" | "preference" | "decision" | "outcome";
  text: string;
  agentName: string;
  createdAt: string;
}

export function writeMemory(
  db: Db,
  m: {
    projectId: string;
    scope: "project" | "agent";
    scopeId: string | null;
    kind: string;
    text: string;
    sourceTaskId: string | null;
    agentId: string;
    agentName: string;
  }
): string | null {
  const id = `mem_${crypto.randomUUID()}`;
  // ON CONFLICT DO NOTHING against the dedupe index — re-learning a fact is
  // a no-op, not an error and not a duplicate row.
  const res = db
    .prepare(
      `INSERT INTO memories (id, project_id, scope, scope_id, kind, text, source_task_id, agent_id, agent_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      id, m.projectId, m.scope, m.scopeId, m.kind, m.text.trim(),
      m.sourceTaskId, m.agentId, m.agentName, new Date().toISOString()
    );
  return res.changes > 0 ? id : null;
}

// FTS5's MATCH takes a query *language*, not a plain string: bare `AND`,
// `*`, `"` or `:` in a user/agent-authored query are syntax, and malformed
// syntax throws rather than returning nothing. Reduce to bare word tokens
// and OR them as quoted phrases, so arbitrary text is always a valid query.
function toFtsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  const unique = [...new Set(tokens)].filter((t) => t.length > 1).slice(0, 24);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t}"`).join(" OR ");
}

// Returns the project's shared memories plus this agent's own notes, ranked
// by BM25 relevance. An empty/unmatchable query falls back to most-recent —
// a new agent with nothing to search for should still inherit context.
export function recallMemories(
  db: Db,
  opts: { projectId: string; agentId: string; query: string; limit: number }
): MemoryRow[] {
  const visible = "m.project_id = ? AND (m.scope = 'project' OR (m.scope = 'agent' AND m.scope_id = ?))";
  const fts = toFtsQuery(opts.query);

  const rows = fts
    ? (db
        .prepare(
          `SELECT m.id, m.scope, m.kind, m.text, m.agent_name, m.created_at
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE f.text MATCH ? AND ${visible}
           ORDER BY bm25(memories_fts) LIMIT ?`
        )
        .all(fts, opts.projectId, opts.agentId, opts.limit) as any[])
    : (db
        .prepare(
          `SELECT m.id, m.scope, m.kind, m.text, m.agent_name, m.created_at
           FROM memories m WHERE ${visible}
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(opts.projectId, opts.agentId, opts.limit) as any[]);

  return rows.map((r) => ({
    id: r.id, scope: r.scope, kind: r.kind, text: r.text,
    agentName: r.agent_name ?? "unknown", createdAt: r.created_at,
  }));
}

export function recentMemories(db: Db, projectId: string, limit = 50): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, scope, kind, text, agent_name, created_at FROM memories
       WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(projectId, limit) as any[];
  return rows.map((r) => ({
    id: r.id, scope: r.scope, kind: r.kind, text: r.text,
    agentName: r.agent_name ?? "unknown", createdAt: r.created_at,
  }));
}

export function clearAgentWaiting(db: Db, agentId: string) {
  db.prepare("UPDATE agents SET status = 'idle', waiting_on = NULL, current_task = NULL WHERE id = ?").run(agentId);
}
