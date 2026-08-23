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
