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
  last_seen TEXT,
  online INT DEFAULT 0,
  revoked INT DEFAULT 0
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

export function registerMachine(db: Db, id: string, ownerId: string, name: string, pubkey: string) {
  db.prepare(
    "INSERT INTO machines (id, owner_id, name, pubkey, last_seen, online, revoked) VALUES (?, ?, ?, ?, ?, 1, 0)"
  ).run(id, ownerId, name, pubkey, new Date().toISOString());
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

export function setAgentStatus(db: Db, agentId: string, status: string, currentTask: string | null) {
  db.prepare("UPDATE agents SET status = ?, current_task = ? WHERE id = ?").run(status, currentTask, agentId);
}
