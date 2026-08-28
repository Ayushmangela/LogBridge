import Database from "better-sqlite3";
import { blendByRecency, migrateMemoryDedupe, normalizeMemoryKey } from "./memory.js";
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
  accept_delegations INT DEFAULT 0,
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
  github_ref TEXT,
  character TEXT,       -- which sprite the office draws (see CHAR_NAMES)
  color TEXT,           -- accent hex, chosen when the agent was created
  folder TEXT,          -- the repo/folder this agent works in
  isolation TEXT,       -- shared | worktree | copy (see WORKSPACE.md)
  note TEXT,            -- a human's scratch note, shown in the roster
  description TEXT,     -- one line: what this agent is ("runs the floor")
  goal TEXT,            -- its standing objective, from the briefing step
  provider TEXT,         -- which agent CLI it runs (PROVIDERS.md); null = the machine's default harness
  summoned_by TEXT,      -- who summoned it here (HANDOFF-PRESENCE Phase 4)
  summoned_at TEXT,      -- when the summon happened (ISO)
  summoned_x REAL,       -- tile coords where it was called (player position)
  summoned_y REAL,
  paused INT DEFAULT 0,  -- paused by a human: visible but never routed work
  paused_at TEXT,
  retired INT DEFAULT 0, -- retired: keeps history/memories, takes no work, can return
  retired_at TEXT,
  model TEXT,            -- model name for the provider
  steer_context TEXT,    -- one line of context for next task
  context_used INTEGER,  -- tokens used
  context_limit INTEGER, -- token limit
  tool_calls INTEGER     -- count of tool calls
);
CREATE TABLE IF NOT EXISTS deleted_agents (
  id TEXT PRIMARY KEY,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  gh_repo TEXT UNIQUE,
  name TEXT,
  layout TEXT DEFAULT 'office',
  call_link TEXT
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT,
  user_id TEXT,
  role TEXT DEFAULT 'member',
  joined_at TEXT,
  PRIMARY KEY (project_id, user_id)
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
  -- 'plan' marks a task whose OUTPUT is a list of other tasks. Set by the
  -- planning flow; null for ordinary work. See plan.ts.
  kind TEXT,
  created_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  parent_task TEXT,
  retry_of TEXT,
  workflow_id TEXT,
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
CREATE TABLE IF NOT EXISTS github_pulls (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  number INTEGER,
  title TEXT,
  state TEXT,
  author TEXT,
  ci TEXT,
  updated_at TEXT
);
-- Where the commit poller got to, per repo. Without a cursor the first poll
-- would narrate every commit in the repo's recent history; with one, only
-- genuinely new commits are announced.
CREATE TABLE IF NOT EXISTS github_cursors (
  repo TEXT PRIMARY KEY,
  last_sha TEXT,
  last_commit_at TEXT
);
-- Standing rules that create tasks when a condition is met (HANDOFF-TRIGGERS.md).
-- kind 'schedule' fires by the clock; kind 'event' (Phase 3) fires on log
-- events. tz holds an IANA zone so wall-clock schedules survive DST.
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT,
  enabled INT DEFAULT 1,
  kind TEXT,
  rule TEXT,
  task_title TEXT,
  task_spec TEXT,
  task_capability TEXT,
  budget_seconds INTEGER,
  budget_usd REAL,
  tz TEXT,
  created_at TEXT,
  last_fired_at TEXT,
  next_fire_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_triggers_due ON triggers (enabled, next_fire_at);
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
  created_at TEXT,
  -- Normalised form of text: the dedup KEY. Lowercased, clause punctuation
  -- and whitespace collapsed. The display text stays exactly what the
  -- agent wrote; only the key is normalised. See memory.ts for the rule and
  -- why it stops at formatting ("never deploy on Friday" is still a
  -- different FACT, not a differently formatted one).
  dedupe_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project_id, created_at DESC);
-- Same fact, same scope, written twice is one memory, not two — regardless of
-- capitalisation or a trailing period. Agents volunteering memories via the
-- REMEMBER convention phrase the same fact slightly differently every time;
-- raw-text dedup let each phrasing become its own row until recall's 100-row
-- cap was mostly echoes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe
  ON memories (project_id, scope, IFNULL(scope_id, ''), dedupe_key);

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

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  error_message TEXT,
  cost_usd REAL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts (task_id, attempt_number);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  creator_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_id);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  creator_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'completed' | 'failed' | 'canceled'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows (project_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies (task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies (depends_on_task_id);

CREATE TABLE IF NOT EXISTS retry_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  backoff_ms INTEGER NOT NULL DEFAULT 1000,
  retry_on TEXT NOT NULL,
  prefer_different_agent INT DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  workflow_id TEXT,
  creator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals (project_id);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  steps_json TEXT NOT NULL,
  impact_analysis_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_id TEXT,
  goal_id TEXT,
  task_id TEXT,
  requester_id TEXT NOT NULL,
  requester_type TEXT NOT NULL DEFAULT 'agent',
  approval_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  proposed_action_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_comment TEXT,
  expires_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_project ON approval_requests (project_id, state);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approval_requests (task_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs (project_id, timestamp);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  goal_id TEXT,
  agent_id TEXT,
  urgency TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  recommended_actions_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_escalations_project ON escalations (project_id, state);

CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks (agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks (workflow_id);
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
  // existed, so every column added after the fact is replayed here.
  //
  // This list has outgrown the "one column" it was written for. It still
  // works, and it is still idempotent, but the honest reading is that D7's
  // "deliberately minimal" has reached its limit: the next schema change
  // that needs to REWRITE or BACKFILL data, rather than append a nullable
  // column, cannot be expressed here and is the point where migrations stop
  // being optional.
  for (const alter of [
    "ALTER TABLE tasks ADD COLUMN created_at TEXT",
    "ALTER TABLE machines ADD COLUMN sealing_pubkey TEXT",
    "ALTER TABLE tasks ADD COLUMN required_capability TEXT",
    "ALTER TABLE tasks ADD COLUMN kind TEXT",
    "ALTER TABLE machines ADD COLUMN providers TEXT",
    "ALTER TABLE machines ADD COLUMN accept_delegations INT DEFAULT 0",
    "ALTER TABLE machines ADD COLUMN allow_agent_creation INT DEFAULT 0",
    "ALTER TABLE machines ADD COLUMN allow_unsandboxed INT DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN character TEXT",
    "ALTER TABLE agents ADD COLUMN color TEXT",
    "ALTER TABLE agents ADD COLUMN folder TEXT",
    "ALTER TABLE agents ADD COLUMN isolation TEXT",
    "ALTER TABLE agents ADD COLUMN note TEXT",
    "ALTER TABLE agents ADD COLUMN description TEXT",
    "ALTER TABLE agents ADD COLUMN goal TEXT",
    "ALTER TABLE agents ADD COLUMN provider TEXT",
    // Event-trigger bookkeeping. See triggers.ts fireEventTriggers.
    "ALTER TABLE triggers ADD COLUMN last_evt_seq INTEGER DEFAULT 0",
    "ALTER TABLE triggers ADD COLUMN last_evt_fire_ms INTEGER DEFAULT 0",
    "ALTER TABLE triggers ADD COLUMN last_consumed_task_id TEXT",
    "ALTER TABLE agents ADD COLUMN summoned_by TEXT",
    "ALTER TABLE agents ADD COLUMN summoned_at TEXT",
    "ALTER TABLE agents ADD COLUMN summoned_x REAL",
    "ALTER TABLE agents ADD COLUMN summoned_y REAL",
    "ALTER TABLE agents ADD COLUMN paused INT DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN paused_at TEXT",
    "ALTER TABLE agents ADD COLUMN retired INT DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN color TEXT",
    "ALTER TABLE tasks ADD COLUMN parent_task TEXT",
    "ALTER TABLE tasks ADD COLUMN retry_of TEXT",
    "ALTER TABLE tasks ADD COLUMN workflow_id TEXT",
    "ALTER TABLE tasks ADD COLUMN suggested_role TEXT",
    "ALTER TABLE tasks ADD COLUMN wave INTEGER",
    "ALTER TABLE tasks ADD COLUMN goal_id TEXT",
    "ALTER TABLE agents ADD COLUMN context_used INTEGER",
    "ALTER TABLE agents ADD COLUMN context_limit INTEGER",
    "ALTER TABLE agents ADD COLUMN tool_calls INTEGER",
    "ALTER TABLE users ADD COLUMN email TEXT",
    "ALTER TABLE users ADD COLUMN password_hash TEXT",
    "ALTER TABLE users ADD COLUMN created_at TEXT",
    "ALTER TABLE projects ADD COLUMN owner_id TEXT",
  ]) {
    try {
      db.exec(alter);
    } catch (e) {
      // "duplicate column name" is the expected case — the column is already
      // there from SCHEMA on a fresh db, or from a prior run. Anything else
      // is a real error (a typo in the DDL above would otherwise vanish here
      // and surface much later as a mystifying "no such column" at runtime).
      const msg = String((e as Error)?.message ?? "");
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  }
  // Memory dedup migration + backfill — explicit and idempotent (see
  // memory.ts). A backfill cannot live in this ALTER list, which only knows
  // how to add columns.
  migrateMemoryDedupe(db);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT,
        user_id TEXT,
        role TEXT DEFAULT 'member',
        joined_at TEXT,
        PRIMARY KEY (project_id, user_id)
      );
      INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
      SELECT p.id, u.id, 'member', datetime('now')
      FROM projects p CROSS JOIN users u;
    `);
  } catch {}

  try {
    const defaultProviders = JSON.stringify([
      {
        id: "claude",
        label: "Claude Code",
        policy: "claude-settings",
        verified: true,
        models: ["claude-3-7-sonnet-latest", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-opus-5"],
        command: {
          withModel: 'claude -p "<your task>" --output-format stream-json --verbose --model <model>',
          noModel: 'claude -p "<your task>" --output-format stream-json --verbose',
          bypassFlag: '--permission-mode bypassPermissions'
        }
      },
      {
        id: "opencode",
        label: "OpenCode",
        policy: "none",
        verified: true,
        models: [],
        command: {
          withModel: 'opencode run "<your task>" --format json -m <model>',
          noModel: 'opencode run "<your task>" --format json',
          bypassFlag: null
        }
      },
      {
        id: "gemini",
        label: "Gemini CLI",
        policy: "none",
        verified: false,
        models: [],
        command: {
          withModel: 'gemini -p "<your task>"',
          noModel: 'gemini -p "<your task>"',
          bypassFlag: null
        }
      },
      {
        id: "codex",
        label: "Codex · GPT",
        policy: "none",
        verified: false,
        models: [],
        command: {
          withModel: 'codex exec "<your task>"',
          noModel: 'codex exec "<your task>"',
          bypassFlag: null
        }
      }
    ]);
    db.prepare(`
      UPDATE machines
      SET providers = ?, allow_agent_creation = 1, allow_unsandboxed = 1
      WHERE id = 'node_demo' OR (providers IS NULL AND allow_agent_creation = 1)
    `).run(defaultProviders);
  } catch {}

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
    kind?: string | null;           // 'plan' = its output is a task list
    parentTask?: string | null;     // subtask link to parent goal
    retryOf?: string | null;
    workflowId?: string | null;
    budgetSeconds?: number;
    budgetUsd?: number;
    /** Idempotency key. A second call with the same key returns the FIRST
     *  task's id instead of creating another — which is what makes a firing
     *  loop safe across a restart that lands between "task created" and
     *  "bookkeeping written". */
    idem?: string | null;
  }
): string {
  if (opts.idem) {
    const existing = db.prepare("SELECT id FROM tasks WHERE idem = ?").get(opts.idem) as any;
    if (existing) return existing.id;
  }
  // A task against a project that does not exist is orphaned: it is in no
  // room, no view renders it, and the orchestrator will never route it — it
  // simply sits in the table looking like work. The same reasoning already
  // guards agent creation (see the 404 in /api/agents); SQLite will not
  // enforce it for us here because tasks carries no foreign key.
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(opts.projectId)) {
    throw new Error(`no such project "${opts.projectId}"`);
  }
  const taskId = `tsk_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, required_capability, created_at, kind, parent_task, retry_of, workflow_id, idem)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    taskId, opts.projectId, opts.title, opts.spec ?? null, opts.creatorId, opts.agentId ?? null,
    opts.budgetSeconds ?? 60, opts.budgetUsd ?? 1.0, opts.requiredCapability ?? null, new Date().toISOString(),
    opts.kind ?? null, opts.parentTask ?? null, opts.retryOf ?? null, opts.workflowId ?? null, opts.idem ?? null
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
  const tasks = db
    .prepare(
      `SELECT id, project_id, required_capability, workflow_id FROM tasks
       WHERE state = 'submitted' AND agent_id IS NULL
       ORDER BY created_at ASC, rowid ASC`
    )
    .all() as { id: string; project_id: string; required_capability: string | null; workflow_id: string | null }[];

  return tasks.filter((t) => {
    // If task is in a workflow, workflow must be active
    if (t.workflow_id) {
      const wf = db.prepare("SELECT state FROM workflows WHERE id = ?").get(t.workflow_id) as any;
      if (!wf || wf.state !== "active") return false;
    }
    // All dependencies must be satisfied (completed)
    return isTaskDependenciesSatisfied(db, t.id);
  });
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
       WHERE a.project_id = ? AND COALESCE(a.paused, 0) = 0 AND COALESCE(a.retired, 0) = 0`
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
  // The KEY is normalised so re-phrasings of one fact collide into the
  // no-op branch; `text` stored verbatim for display.
  const res = db
    .prepare(
      `INSERT INTO memories (id, project_id, scope, scope_id, kind, text, dedupe_key, source_task_id, agent_id, agent_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      id, m.projectId, m.scope, m.scopeId, m.kind, m.text.trim(),
      normalizeMemoryKey(m.text),
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

  // Candidates are fetched OVER the limit (3x) because ranking happens after
  // the query: a recency boost must be able to lift a slightly-less-lexical
  // row into the final page, which it can't do if that row was cut before
  // scoring. Nothing is deleted by any of this — age reorders, never evicts.
  const rows = fts
    ? (db
        .prepare(
          `SELECT m.id, m.scope, m.kind, m.text, m.agent_name, m.created_at,
                  bm25(memories_fts) AS bm25
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE f.text MATCH ? AND ${visible}
           ORDER BY bm25(memories_fts) LIMIT ?`
        )
        .all(fts, opts.projectId, opts.agentId, opts.limit * 3) as any[])
    : (db
        .prepare(
          // Ordered and capped in SQL, not in JS. Without the LIMIT this
          // materialised every visible memory on every recall and then threw
          // most of them away — correct, but a full scan per task, on the one
          // path that has no relevance ranking to justify over-fetching.
          `SELECT m.id, m.scope, m.kind, m.text, m.agent_name, m.created_at, 0 AS bm25
           FROM memories m WHERE ${visible}
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(opts.projectId, opts.agentId, opts.limit) as any[]);

  // No query (or an unmatchable one): most-recent first is already the right
  // order, and blending would just re-sort recency against itself.
  if (!fts) {
    return rows.slice(0, opts.limit).map((r) => ({
      id: r.id, scope: r.scope, kind: r.kind, text: r.text,
      agentName: r.agent_name ?? "unknown", createdAt: r.created_at,
    }));
  }

  return blendByRecency(rows, Date.now())
    .slice(0, opts.limit)
    .map((r) => ({
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

export function getSummon(db: Db, agentId: string): { by: string; at: string; x: number; y: number } | null {
  const row = db.prepare("SELECT summoned_by AS by, summoned_at AS at, summoned_x AS x, summoned_y AS y FROM agents WHERE id = ?").get(agentId) as any;
  if (!row?.by) return null;
  return row;
}

// ---- delegation consent grants (SEALED.md, DECISIONS.md D13) ----
// grantor = the owner whose machine would run the work; grantee = the owner
// whose agent asked. mode 'always' auto-forwards future requests for this
// capability; 'never' auto-denies them. Absence = ask every time.

export type GrantMode = "always" | "never";

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

// ---- Per-Agent History (HANDOFF-SERVER-2 Phase 2) ----
export function getAgentHistory(db: Db, agentId: string, limit = 20, offset = 0) {
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const boundedOffset = Math.max(0, offset);
  const rows = db.prepare(
    `SELECT id, project_id, title, spec, state, created_at, started_at, ended_at, budget_seconds, budget_usd, cost_usd
     FROM tasks WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(agentId, boundedLimit, boundedOffset) as any[];

  const countRow = db.prepare("SELECT COUNT(*) as total FROM tasks WHERE agent_id = ?").get(agentId) as any;
  const total = countRow?.total ?? 0;

  const tasks = rows.map((r) => {
    let durationSeconds: number | null = null;
    if (r.started_at && r.ended_at) {
      durationSeconds = Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000));
    } else if (r.started_at) {
      durationSeconds = Math.max(0, Math.round((Date.now() - new Date(r.started_at).getTime()) / 1000));
    }
    const evtCountRow = db.prepare("SELECT COUNT(*) as n FROM events WHERE task_id = ?").get(r.id) as any;
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      spec: r.spec,
      state: r.state,
      outcome: r.state,
      durationSeconds,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      budgetSeconds: r.budget_seconds,
      costUsd: r.cost_usd,
      eventCount: evtCountRow?.n ?? 0,
    };
  });

  return { agentId, tasks, total, limit: boundedLimit, offset: boundedOffset };
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

// ---- Traces (HANDOFF-SERVER-3 Phase 4) ----
export function getAgentTraces(db: Db, agentId: string, limit = 50) {
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const rows = db.prepare(
    `SELECT e.seq, e.task_id, e.type, e.body, e.ts, t.title as task_title
     FROM events e
     JOIN tasks t ON t.id = e.task_id
     WHERE t.agent_id = ? AND (e.type = 'task.event' OR e.type LIKE 'task%')
     ORDER BY e.seq DESC LIMIT ?`
  ).all(agentId, boundedLimit) as any[];

  return rows.map((r) => {
    let parsed: any = {};
    try { parsed = JSON.parse(r.body); } catch {}
    let kind = parsed.kind ?? "tool_call";
    if (r.type === "task_steer") kind = "steer";
    else if (r.type === "task.pause" || r.type === "task.resume" || r.type === "task.halt") kind = "control";

    // Redact absolute paths and potential secrets
    const summary = typeof parsed.summary === "string"
      ? parsed.summary.replace(/\/Users\/[^\/]+/g, "~").slice(0, 200)
      : (parsed.text ? String(parsed.text).slice(0, 200) : (parsed.reason ? `Halted: ${parsed.reason}` : r.type));
    return {
      id: `tr_${r.seq}`,
      seq: r.seq,
      taskId: r.task_id,
      taskTitle: r.task_title ?? r.task_id,
      kind,
      summary,
      ts: r.ts,
      data: parsed.data ? (typeof parsed.data === "object" ? "[data]" : String(parsed.data).slice(0, 100)) : null,
    };
  });
}

// ---- Output Stream (HANDOFF-SERVER-3 Phase 5) ----
export function getAgentOutput(db: Db, agentId: string, limit = 200, since?: number) {
  const boundedLimit = Math.max(1, Math.min(400, limit));
  let query = `
    SELECT e.seq, e.task_id, e.body, e.ts
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    WHERE t.agent_id = ? AND e.type = 'task.event'
  `;
  const params: any[] = [agentId];
  if (typeof since === "number" && since > 0) {
    query += ` AND e.seq > ?`;
    params.push(since);
  }
  query += ` ORDER BY e.seq ASC LIMIT ?`;
  params.push(boundedLimit);

  const rows = db.prepare(query).all(...params) as any[];
  const lines: string[] = [];
  for (const r of rows) {
    try {
      const b = JSON.parse(r.body);
      if (b.summary) lines.push(String(b.summary));
      else if (b.text) lines.push(String(b.text));
      else if (b.data?.output) {
        if (Array.isArray(b.data.output)) lines.push(...b.data.output.map(String));
        else lines.push(String(b.data.output));
      }
    } catch {}
  }
  const output = lines.slice(-400);
  return { agentId, output, count: output.length };
}

// ---- Message Graph (HANDOFF-SERVER-4 Phase 8) ----
export function getProjectGraph(db: Db, projectId: string, windowHours = 168) {
  const agents = db.prepare(
    `SELECT id, name, role, character, color FROM agents WHERE project_id = ?`
  ).all(projectId) as any[];

  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const evts = db.prepare(
    `SELECT seq, project_id, task_id, type, body, ts
     FROM events
     WHERE project_id = ? AND ts >= ? AND type IN ('delegate.request', 'delegate.decision', 'review.request', 'chat')
     ORDER BY seq DESC LIMIT 500`
  ).all(projectId, since) as any[];

  const edgeMap = new Map<string, { from: string; to: string; kind: string; count: number; lastTs: string }>();

  for (const e of evts) {
    let kind = "chat";
    if (e.type.startsWith("delegate")) kind = "delegation";
    else if (e.type.startsWith("review")) kind = "review";

    let from = "system";
    let to = "";

    try {
      const b = JSON.parse(e.body);
      from = b.fromName ?? b.fromId ?? b.from?.id ?? b.actor ?? "system";
      to = b.targetAgentId ?? b.to?.id ?? b.taskId ?? "";
    } catch {}

    const key = `${from}->${to}:${kind}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
      if (e.ts > existing.lastTs) existing.lastTs = e.ts;
    } else {
      edgeMap.set(key, { from, to, kind, count: 1, lastTs: e.ts });
    }
  }

  const edges = Array.from(edgeMap.values()).slice(0, 50);
  return { nodes: agents, edges };
}

export function pauseTask(db: Db, taskId: string): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return false;
  db.prepare("UPDATE tasks SET state = 'paused' WHERE id = ?").run(taskId);
  if (task.agent_id) {
    db.prepare("UPDATE agents SET status = 'waiting' WHERE id = ?").run(task.agent_id);
  }
  appendEvent(db, task.project_id, taskId, "task.pause", { taskId, agentId: task.agent_id, at: new Date().toISOString() });
  return true;
}

export function resumeTask(db: Db, taskId: string): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return false;
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(taskId);
  if (task.agent_id) {
    db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(task.agent_id);
  }
  appendEvent(db, task.project_id, taskId, "task.resume", { taskId, agentId: task.agent_id, at: new Date().toISOString() });
  return true;
}

export function haltTask(db: Db, taskId: string, reason = "User halted task"): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!task) return false;
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET state = 'cancelled', ended_at = ? WHERE id = ?").run(now, taskId);
  if (task.agent_id) {
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(task.agent_id);
  }
  appendEvent(db, task.project_id, taskId, "task.halt", { taskId, agentId: task.agent_id, reason, at: now });
  return true;
}

export function getAgentTasks(db: Db, agentId: string, limit = 50): any[] {
  return db.prepare(
    `SELECT id, project_id, title, spec, state, budget_seconds, budget_usd, cost_usd, created_at, started_at, ended_at, parent_task
     FROM tasks
     WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(agentId, limit) as any[];
}

export function getTaskTraces(db: Db, taskId: string): any[] {
  const rows = db.prepare(
    `SELECT seq, project_id, task_id, type, body, ts
     FROM events
     WHERE task_id = ?
     ORDER BY seq ASC`
  ).all(taskId) as any[];

  return rows.map((r) => {
    let parsed: any = {};
    try { parsed = JSON.parse(r.body); } catch { parsed = { raw: r.body }; }
    return {
      seq: r.seq,
      taskId: r.task_id,
      type: r.type,
      data: parsed,
      ts: r.ts,
    };
  });
}

// ---------------- Task Attempts & Artifacts ----------------

export interface TaskAttemptRow {
  id: string;
  task_id: string;
  attempt_number: number;
  agent_id: string;
  state: "running" | "completed" | "failed" | "timed_out" | "canceled";
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  error_message: string | null;
  cost_usd: number;
}

export function createTaskAttempt(
  db: Db,
  opts: {
    taskId: string;
    agentId: string;
    attemptNumber?: number;
  }
): TaskAttemptRow {
  // Idempotency: if an attempt is already running for this task and agent, reuse it
  const existingActive = db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? AND state = 'running' ORDER BY attempt_number DESC LIMIT 1")
    .get(opts.taskId) as TaskAttemptRow | undefined;
  if (existingActive) {
    return existingActive;
  }

  const num = opts.attemptNumber ??
    ((db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextNum FROM task_attempts WHERE task_id = ?").get(opts.taskId) as any)?.nextNum ?? 1);

  const attemptId = `att_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, state, started_at, cost_usd)
     VALUES (?, ?, ?, ?, 'running', ?, 0)`
  ).run(attemptId, opts.taskId, num, opts.agentId, now);

  return {
    id: attemptId,
    task_id: opts.taskId,
    attempt_number: num,
    agent_id: opts.agentId,
    state: "running",
    started_at: now,
    ended_at: null,
    exit_code: null,
    error_message: null,
    cost_usd: 0,
  };
}

export function getActiveTaskAttempt(db: Db, taskId: string): TaskAttemptRow | undefined {
  return db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? AND state = 'running' ORDER BY attempt_number DESC LIMIT 1")
    .get(taskId) as TaskAttemptRow | undefined;
}

export function getTaskAttempts(db: Db, taskId: string): TaskAttemptRow[] {
  return db
    .prepare("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC")
    .all(taskId) as TaskAttemptRow[];
}

export function finishTaskAttempt(
  db: Db,
  attemptId: string,
  opts: {
    state?: "completed" | "failed" | "timed_out" | "canceled";
    exitCode?: number | null;
    errorMessage?: string | null;
    costUsd?: number;
  } = {}
): boolean {
  const state = opts.state ?? "completed";
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE task_attempts
       SET state = ?, ended_at = ?, exit_code = ?, error_message = ?, cost_usd = COALESCE(?, cost_usd)
       WHERE id = ? AND state = 'running'`
    )
    .run(state, now, opts.exitCode ?? null, opts.errorMessage ?? null, opts.costUsd ?? null, attemptId);
  return res.changes > 0;
}

export function failActiveTaskAttempt(
  db: Db,
  taskId: string,
  errorMessage: string,
  state: "failed" | "timed_out" | "canceled" = "failed"
): boolean {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE task_attempts
       SET state = ?, ended_at = ?, error_message = ?
       WHERE task_id = ? AND state = 'running'`
    )
    .run(state, now, errorMessage, taskId);
  return res.changes > 0;
}

export interface ArtifactRow {
  id: string;
  project_id: string;
  task_id: string | null;
  attempt_id: string | null;
  creator_id: string;
  kind: string;
  title: string;
  summary: string | null;
  file_path: string | null;
  created_at: string;
}

export function storeArtifact(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    taskId?: string | null;
    attemptId?: string | null;
    creatorId: string;
    kind: string;
    title: string;
    summary?: string | null;
    filePath?: string | null;
  }
): string {
  const id = opts.id || `art_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO artifacts (id, project_id, task_id, attempt_id, creator_id, kind, title, summary, file_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.taskId ?? null,
    opts.attemptId ?? null,
    opts.creatorId,
    opts.kind,
    opts.title,
    opts.summary ?? null,
    opts.filePath ?? null,
    now
  );
  return id;
}

export function getTaskArtifacts(db: Db, taskId: string): ArtifactRow[] {
  return db
    .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as ArtifactRow[];
}

export function getProjectArtifacts(db: Db, projectId: string, limit = 50): ArtifactRow[] {
  return db
    .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(projectId, limit) as ArtifactRow[];
}

export function getArtifact(db: Db, id: string): ArtifactRow | undefined {
  return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
}

// ─── Workflows & Task Dependencies (Phase 2) ─────────────────────────

export interface WorkflowRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  creator_id: string;
  state: "active" | "paused" | "completed" | "failed" | "canceled";
  created_at: string;
  updated_at: string;
}

export function createWorkflow(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    title: string;
    description?: string | null;
    creatorId: string;
  }
): string {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(opts.projectId);
  if (!project) throw new Error(`Project "${opts.projectId}" does not exist`);

  const id = opts.id || `wf_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflows (id, project_id, title, description, creator_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, opts.projectId, opts.title.trim(), opts.description?.trim() ?? null, opts.creatorId, now, now);
  return id;
}

export function getWorkflow(db: Db, id: string): WorkflowRow | undefined {
  return db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | undefined;
}

export function getProjectWorkflows(db: Db, projectId: string): WorkflowRow[] {
  return db
    .prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as WorkflowRow[];
}

export function setWorkflowState(
  db: Db,
  id: string,
  state: "active" | "paused" | "completed" | "failed" | "canceled"
): boolean {
  const res = db
    .prepare("UPDATE workflows SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, new Date().toISOString(), id);
  return res.changes > 0;
}

export function updateTaskWorkflow(db: Db, taskId: string, workflowId: string | null): boolean {
  const res = db.prepare("UPDATE tasks SET workflow_id = ? WHERE id = ?").run(workflowId, taskId);
  return res.changes > 0;
}

export function hasDependencyCycle(db: Db, taskId: string, dependsOnTaskId: string): boolean {
  if (taskId === dependsOnTaskId) return true;
  const visited = new Set<string>();
  const queue: string[] = [dependsOnTaskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = db
      .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
      .all(current) as { depends_on_task_id: string }[];

    for (const d of deps) {
      if (!visited.has(d.depends_on_task_id)) {
        queue.push(d.depends_on_task_id);
      }
    }
  }
  return false;
}

export function addTaskDependency(
  db: Db,
  taskId: string,
  dependsOnTaskId: string
): { ok: boolean; error?: string } {
  if (taskId === dependsOnTaskId) {
    return { ok: false, error: "Task cannot depend on itself" };
  }
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: `Task "${taskId}" not found` };
  const depTask = getTask(db, dependsOnTaskId);
  if (!depTask) return { ok: false, error: `Dependency task "${dependsOnTaskId}" not found` };

  if (task.project_id !== depTask.project_id) {
    return { ok: false, error: "Cross-project dependencies are forbidden" };
  }

  if (hasDependencyCycle(db, taskId, dependsOnTaskId)) {
    return { ok: false, error: "Circular dependency detected" };
  }

  db.prepare(
    `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
     VALUES (?, ?, ?)`
  ).run(taskId, dependsOnTaskId, new Date().toISOString());

  return { ok: true };
}

export function removeTaskDependency(db: Db, taskId: string, dependsOnTaskId: string): boolean {
  const res = db
    .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
    .run(taskId, dependsOnTaskId);
  return res.changes > 0;
}

export function getTaskDependencies(
  db: Db,
  taskId: string
): Array<{ taskId: string; dependsOnTaskId: string; title: string; state: string; agentId: string | null }> {
  return db
    .prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId, t.title, t.state, t.agent_id AS agentId
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(taskId) as any[];
}

export function getTaskDependents(
  db: Db,
  taskId: string
): Array<{ taskId: string; dependsOnTaskId: string; title: string; state: string; agentId: string | null }> {
  return db
    .prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId, t.title, t.state, t.agent_id AS agentId
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ?`
    )
    .all(taskId) as any[];
}

export function isTaskDependenciesSatisfied(db: Db, taskId: string): boolean {
  const deps = db
    .prepare(
      `SELECT t.state FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(taskId) as { state: string }[];

  if (deps.length === 0) return true;
  return deps.every((d) => d.state === "completed");
}

export function getTaskDependencyStatus(db: Db, taskId: string) {
  const deps = db
    .prepare(
      `SELECT d.depends_on_task_id AS dependsOnTaskId, t.title, t.state, t.agent_id AS agentId
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(taskId) as Array<{ dependsOnTaskId: string; title: string; state: string; agentId: string | null }>;

  const completedCount = deps.filter((d) => d.state === "completed").length;
  const failedCount = deps.filter((d) => ["failed", "canceled", "rejected"].includes(d.state)).length;
  const pendingCount = deps.length - completedCount - failedCount;
  const isSatisfied = deps.length === 0 || completedCount === deps.length;
  const isBlocked = failedCount > 0;

  return {
    satisfied: isSatisfied,
    blocked: isBlocked,
    totalDependencies: deps.length,
    completedCount,
    failedCount,
    pendingCount,
    dependencies: deps,
  };
}

export function getWorkflowGraph(db: Db, workflowId: string) {
  const wf = getWorkflow(db, workflowId);
  if (!wf) return null;

  const tasks = db
    .prepare(
      `SELECT t.*, a.name AS agent_name FROM tasks t
       LEFT JOIN agents a ON a.id = t.agent_id
       WHERE t.workflow_id = ?
       ORDER BY t.created_at ASC`
    )
    .all(workflowId) as any[];

  const taskIds = tasks.map((t) => t.id);
  let dependencies: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => "?").join(",");
    dependencies = db
      .prepare(
        `SELECT task_id AS taskId, depends_on_task_id AS dependsOnTaskId
         FROM task_dependencies
         WHERE task_id IN (${placeholders})`
      )
      .all(...taskIds) as any[];
  }

  const nodes = tasks.map((t) => {
    const depStatus = getTaskDependencyStatus(db, t.id);
    let derivedStatus = t.state;
    if (t.state === "submitted") {
      if (depStatus.blocked) derivedStatus = "blocked";
      else if (!depStatus.satisfied) derivedStatus = "waiting";
      else derivedStatus = "ready";
    }
    return {
      ...t,
      derivedStatus,
      dependencyStatus: depStatus,
    };
  });

  return {
    workflow: wf,
    tasks: nodes,
    edges: dependencies,
  };
}

export function updateWorkflowStatusFromTasks(db: Db, workflowId: string): string {
  const wf = getWorkflow(db, workflowId);
  if (!wf || wf.state === "paused" || wf.state === "canceled") return wf?.state ?? "active";

  const tasks = db.prepare("SELECT state FROM tasks WHERE workflow_id = ?").all(workflowId) as { state: string }[];
  if (tasks.length === 0) return wf.state;

  const allCompleted = tasks.every((t) => t.state === "completed");
  const anyFailed = tasks.some((t) => t.state === "failed" || t.state === "rejected");

  let newState = wf.state;
  if (allCompleted) {
    newState = "completed";
  } else if (anyFailed) {
    const allTerminal = tasks.every((t) => ["completed", "failed", "canceled", "rejected"].includes(t.state));
    if (allTerminal) newState = "failed";
  }

  if (newState !== wf.state) {
    setWorkflowState(db, workflowId, newState as any);
  }
  return newState;
}

// ─── Phase 3: Autonomous Intelligence, Health & Recovery ─────────────

export type FailureCategory =
  | "TIMEOUT"
  | "MACHINE_OFFLINE"
  | "TRANSIENT"
  | "AGENT_FAILURE"
  | "INVALID_TASK"
  | "DEPENDENCY_FAILURE"
  | "UNKNOWN";

export function classifyFailure(
  error?: string | null,
  exitCode?: number | null,
  timedOut?: boolean
): FailureCategory {
  if (timedOut) return "TIMEOUT";
  const str = String(error ?? "").toLowerCase();
  if (str.includes("lease expired") || str.includes("timed out") || str.includes("timeout")) {
    return "TIMEOUT";
  }
  if (
    str.includes("offline") ||
    str.includes("socket closed") ||
    str.includes("connection refused") ||
    str.includes("econnrefused") ||
    str.includes("econnreset")
  ) {
    return "MACHINE_OFFLINE";
  }
  if (
    str.includes("transient") ||
    str.includes("502") ||
    str.includes("503") ||
    str.includes("504") ||
    str.includes("429") ||
    str.includes("rate limit") ||
    str.includes("temporary")
  ) {
    return "TRANSIENT";
  }
  if (
    str.includes("syntax") ||
    str.includes("invalid") ||
    str.includes("bad request") ||
    str.includes("400") ||
    str.includes("unauthorized") ||
    str.includes("permission denied")
  ) {
    return "INVALID_TASK";
  }
  if (str.includes("dependency")) {
    return "DEPENDENCY_FAILURE";
  }
  if (exitCode != null && exitCode !== 0) {
    return "AGENT_FAILURE";
  }
  return "UNKNOWN";
}

export interface RetryPolicy {
  id?: string;
  projectId: string;
  taskId?: string | null;
  maxAttempts: number;
  backoffMs: number;
  retryOn: FailureCategory[];
  preferDifferentAgent: boolean;
  createdAt?: string;
}

export function getRetryPolicy(db: Db, projectId: string, taskId?: string | null): RetryPolicy {
  if (taskId) {
    const taskPolicy = db.prepare("SELECT * FROM retry_policies WHERE task_id = ?").get(taskId) as any;
    if (taskPolicy) {
      return {
        id: taskPolicy.id,
        projectId: taskPolicy.project_id,
        taskId: taskPolicy.task_id,
        maxAttempts: Number(taskPolicy.max_attempts),
        backoffMs: Number(taskPolicy.backoff_ms),
        retryOn: (() => { try { return JSON.parse(taskPolicy.retry_on); } catch { return ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"]; } })(),
        preferDifferentAgent: Boolean(taskPolicy.prefer_different_agent),
        createdAt: taskPolicy.created_at,
      };
    }
  }

  const projPolicy = db.prepare("SELECT * FROM retry_policies WHERE project_id = ? AND task_id IS NULL").get(projectId) as any;
  if (projPolicy) {
    return {
      id: projPolicy.id,
      projectId: projPolicy.project_id,
      taskId: null,
      maxAttempts: Number(projPolicy.max_attempts),
      backoffMs: Number(projPolicy.backoff_ms),
      retryOn: (() => { try { return JSON.parse(projPolicy.retry_on); } catch { return ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"]; } })(),
      preferDifferentAgent: Boolean(projPolicy.prefer_different_agent),
      createdAt: projPolicy.created_at,
    };
  }

  return {
    projectId,
    taskId: taskId ?? null,
    maxAttempts: 3,
    backoffMs: 1000,
    retryOn: ["TIMEOUT", "MACHINE_OFFLINE", "TRANSIENT", "AGENT_FAILURE"],
    preferDifferentAgent: true,
  };
}

export function setRetryPolicy(db: Db, opts: RetryPolicy): string {
  const id = opts.id || `rp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO retry_policies (id, project_id, task_id, max_attempts, backoff_ms, retry_on, prefer_different_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.taskId ?? null,
    opts.maxAttempts,
    opts.backoffMs,
    JSON.stringify(opts.retryOn),
    opts.preferDifferentAgent ? 1 : 0,
    now
  );
  return id;
}

export interface AgentMetrics {
  agentId: string;
  name: string;
  role: string;
  machineOnline: boolean;
  status: string;
  totalAttempts: number;
  tasksCompleted: number;
  tasksFailed: number;
  timeouts: number;
  successRate: number; // 0.0 to 1.0
  avgDurationSec: number;
  totalCostUsd: number;
  currentLoad: number;
}

export function getAgentMetrics(db: Db, agentId: string): AgentMetrics | null {
  const agent = db.prepare("SELECT a.*, m.online FROM agents a JOIN machines m ON m.id = a.machine_id WHERE a.id = ?").get(agentId) as any;
  if (!agent) return null;

  const attempts = db.prepare("SELECT * FROM task_attempts WHERE agent_id = ?").all(agentId) as any[];
  const tasksCompleted = attempts.filter((a) => a.state === "completed").length;
  const tasksFailed = attempts.filter((a) => a.state === "failed").length;
  const timeouts = attempts.filter((a) => a.state === "timed_out").length;
  const totalAttempts = attempts.length;
  const successRate = totalAttempts > 0 ? Number((tasksCompleted / totalAttempts).toFixed(3)) : 1.0;

  let totalDurationSec = 0;
  let durationCount = 0;
  let totalCostUsd = 0;

  for (const a of attempts) {
    if (a.cost_usd) totalCostUsd += Number(a.cost_usd);
    if (a.started_at && a.ended_at) {
      const dur = (new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) / 1000;
      if (dur > 0 && Number.isFinite(dur)) {
        totalDurationSec += dur;
        durationCount++;
      }
    }
  }

  const avgDurationSec = durationCount > 0 ? Number((totalDurationSec / durationCount).toFixed(1)) : 0;
  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND state IN ('submitted','working','blocked','input-required','auth-required')").get(agentId) as any;

  return {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    machineOnline: Boolean(agent.online),
    status: agent.status,
    totalAttempts,
    tasksCompleted,
    tasksFailed,
    timeouts,
    successRate,
    avgDurationSec,
    totalCostUsd: Number(totalCostUsd.toFixed(3)),
    currentLoad: Number(activeCount?.n ?? 0),
  };
}

export interface ProjectMetrics {
  projectId: string;
  totalWorkflows: number;
  activeWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  totalAttempts: number;
  successRate: number;
  totalCostUsd: number;
  onlineAgents: number;
  totalAgents: number;
}

export function getProjectMetrics(db: Db, projectId: string): ProjectMetrics {
  const workflows = db.prepare("SELECT state FROM workflows WHERE project_id = ?").all(projectId) as any[];
  const tasks = db.prepare("SELECT state, cost_usd FROM tasks WHERE project_id = ?").all(projectId) as any[];
  const attempts = db.prepare("SELECT ta.state, ta.cost_usd FROM task_attempts ta JOIN tasks t ON t.id = ta.task_id WHERE t.project_id = ?").all(projectId) as any[];
  const agents = db.prepare("SELECT a.id, m.online FROM agents a JOIN machines m ON m.id = a.machine_id WHERE a.project_id = ?").all(projectId) as any[];

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.state === "completed").length;
  const failedTasks = tasks.filter((t) => t.state === "failed" || t.state === "rejected").length;
  const activeTasks = tasks.filter((t) => ["submitted", "working", "blocked", "input-required", "auth-required"].includes(t.state)).length;

  const totalAttempts = attempts.length;
  const completedAttempts = attempts.filter((a) => a.state === "completed").length;
  const successRate = totalAttempts > 0 ? Number((completedAttempts / totalAttempts).toFixed(3)) : (totalTasks > 0 ? Number((completedTasks / totalTasks).toFixed(3)) : 1.0);

  let totalCostUsd = 0;
  for (const t of tasks) if (t.cost_usd) totalCostUsd += Number(t.cost_usd);

  return {
    projectId,
    totalWorkflows: workflows.length,
    activeWorkflows: workflows.filter((w) => w.state === "active").length,
    completedWorkflows: workflows.filter((w) => w.state === "completed").length,
    failedWorkflows: workflows.filter((w) => w.state === "failed").length,
    totalTasks,
    completedTasks,
    failedTasks,
    activeTasks,
    totalAttempts,
    successRate,
    totalCostUsd: Number(totalCostUsd.toFixed(3)),
    onlineAgents: agents.filter((a) => a.online).length,
    totalAgents: agents.length,
  };
}

export function getAgentHistoricalPerformance(db: Db, agentId: string, projectId: string) {
  const metrics = getAgentMetrics(db, agentId);
  if (!metrics) return { successRate: 1.0, tasksCompleted: 0, totalAttempts: 0 };
  return {
    successRate: metrics.successRate,
    tasksCompleted: metrics.tasksCompleted,
    totalAttempts: metrics.totalAttempts,
  };
}

// ─── Phase 4: Goals, Plans & Revisions ──────────────────────────────

export type GoalState =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "paused"
  | "replanning"
  | "completed"
  | "failed"
  | "canceled";

export interface GoalRow {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  state: GoalState;
  workflowId: string | null;
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export function createGoal(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    title: string;
    description?: string | null;
    creatorId: string;
    workflowId?: string | null;
    state?: GoalState;
  }
): string {
  const id = opts.id || `gol_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO goals (id, project_id, title, description, state, workflow_id, creator_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.title,
    opts.description ?? null,
    opts.state ?? "draft",
    opts.workflowId ?? null,
    opts.creatorId,
    now,
    now
  );
  return id;
}

export function getGoal(db: Db, id: string): GoalRow | null {
  const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    state: row.state,
    workflowId: row.workflow_id,
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function getProjectGoals(db: Db, projectId: string): GoalRow[] {
  const rows = db.prepare("SELECT * FROM goals WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as any[];
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    state: row.state,
    workflowId: row.workflow_id,
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

export function setGoalState(
  db: Db,
  id: string,
  state: GoalState,
  extra?: { approvedAt?: string; startedAt?: string; completedAt?: string; workflowId?: string }
): boolean {
  const now = new Date().toISOString();
  let sql = "UPDATE goals SET state = ?, updated_at = ?";
  const params: any[] = [state, now];

  if (extra?.approvedAt !== undefined) {
    sql += ", approved_at = ?";
    params.push(extra.approvedAt);
  }
  if (extra?.startedAt !== undefined) {
    sql += ", started_at = ?";
    params.push(extra.startedAt);
  }
  if (extra?.completedAt !== undefined) {
    sql += ", completed_at = ?";
    params.push(extra.completedAt);
  }
  if (extra?.workflowId !== undefined) {
    sql += ", workflow_id = ?";
    params.push(extra.workflowId);
  }

  sql += " WHERE id = ?";
  params.push(id);

  const res = db.prepare(sql).run(...params);
  return res.changes > 0;
}

export function updateGoalWorkflow(db: Db, goalId: string, workflowId: string): boolean {
  const res = db.prepare("UPDATE goals SET workflow_id = ?, updated_at = ? WHERE id = ?").run(
    workflowId,
    new Date().toISOString(),
    goalId
  );
  return res.changes > 0;
}

export interface PlanRevisionRow {
  id: string;
  goalId: string;
  projectId: string;
  revisionNumber: number;
  state: "draft" | "awaiting_approval" | "approved" | "superseded" | "rejected";
  summary: string | null;
  stepsJson: string;
  impactAnalysisJson: string | null;
  createdBy: string;
  createdAt: string;
  approvedAt: string | null;
}

export function createPlanRevision(
  db: Db,
  opts: {
    id?: string;
    goalId: string;
    projectId: string;
    revisionNumber?: number;
    state?: "draft" | "awaiting_approval" | "approved" | "superseded" | "rejected";
    summary?: string | null;
    steps: any[];
    impactAnalysis?: any | null;
    createdBy: string;
  }
): string {
  const id = opts.id || `plnrev_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  let revNum = opts.revisionNumber;
  if (revNum === undefined) {
    const latest = db
      .prepare("SELECT MAX(revision_number) as max_rev FROM plan_revisions WHERE goal_id = ?")
      .get(opts.goalId) as any;
    revNum = (latest?.max_rev ?? 0) + 1;
  }

  db.prepare(
    `INSERT INTO plan_revisions (id, goal_id, project_id, revision_number, state, summary, steps_json, impact_analysis_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.goalId,
    opts.projectId,
    revNum,
    opts.state ?? "draft",
    opts.summary ?? null,
    JSON.stringify(opts.steps),
    opts.impactAnalysis ? JSON.stringify(opts.impactAnalysis) : null,
    opts.createdBy,
    now
  );
  return id;
}

export function getPlanRevision(db: Db, id: string): PlanRevisionRow | null {
  const row = db.prepare("SELECT * FROM plan_revisions WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    goalId: row.goal_id,
    projectId: row.project_id,
    revisionNumber: Number(row.revision_number),
    state: row.state,
    summary: row.summary,
    stepsJson: row.steps_json,
    impactAnalysisJson: row.impact_analysis_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export function getLatestPlanRevision(db: Db, goalId: string): PlanRevisionRow | null {
  const row = db
    .prepare("SELECT * FROM plan_revisions WHERE goal_id = ? ORDER BY revision_number DESC LIMIT 1")
    .get(goalId) as any;
  if (!row) return null;
  return {
    id: row.id,
    goalId: row.goal_id,
    projectId: row.project_id,
    revisionNumber: Number(row.revision_number),
    state: row.state,
    summary: row.summary,
    stepsJson: row.steps_json,
    impactAnalysisJson: row.impact_analysis_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export function getPlanRevisions(db: Db, goalId: string): PlanRevisionRow[] {
  const rows = db
    .prepare("SELECT * FROM plan_revisions WHERE goal_id = ? ORDER BY revision_number ASC")
    .all(goalId) as any[];
  return rows.map((row) => ({
    id: row.id,
    goalId: row.goal_id,
    projectId: row.project_id,
    revisionNumber: Number(row.revision_number),
    state: row.state,
    summary: row.summary,
    stepsJson: row.steps_json,
    impactAnalysisJson: row.impact_analysis_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  }));
}

export function setPlanRevisionState(
  db: Db,
  id: string,
  state: "draft" | "awaiting_approval" | "approved" | "superseded" | "rejected",
  approvedAt?: string
): boolean {
  let sql = "UPDATE plan_revisions SET state = ?";
  const params: any[] = [state];
  if (approvedAt !== undefined) {
    sql += ", approved_at = ?";
    params.push(approvedAt);
  }
  sql += " WHERE id = ?";
  params.push(id);
  const res = db.prepare(sql).run(...params);
  return res.changes > 0;
}

// ─── Phase 5: Project Membership & Roles ────────────────────────────

export interface ProjectMemberRow {
  projectId: string;
  userId: string;
  name: string;
  ghLogin: string;
  avatar: number;
  role: string;
  joinedAt: string;
}

export function getProjectMembers(db: Db, projectId: string): ProjectMemberRow[] {
  const rows = db
    .prepare(
      `SELECT pm.project_id AS projectId, pm.user_id AS userId, pm.role, pm.joined_at AS joinedAt,
              u.name, u.gh_login AS ghLogin, u.avatar
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY pm.joined_at ASC`
    )
    .all(projectId) as any[];
  return rows.map((r) => ({
    projectId: r.projectId,
    userId: r.userId,
    name: r.name,
    ghLogin: r.ghLogin,
    avatar: Number(r.avatar ?? 0),
    role: r.role,
    joinedAt: r.joinedAt,
  }));
}

export function getUserProjectRole(db: Db, projectId: string, userId: string): string | null {
  const row = db
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as any;
  return row?.role ?? null;
}

export function setProjectMember(
  db: Db,
  projectId: string,
  userId: string,
  role: string = "member"
): boolean {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .run(projectId, userId, role, now);
  return res.changes > 0;
}

export function removeProjectMember(db: Db, projectId: string, userId: string): boolean {
  const res = db
    .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
    .run(projectId, userId);
  return res.changes > 0;
}





