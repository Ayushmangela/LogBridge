import Database from "better-sqlite3";
import { blendByRecency, migrateMemoryDedupe, normalizeMemoryKey } from "../memory.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./types.js";

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

CREATE TABLE IF NOT EXISTS dead_letter_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  goal_id TEXT,
  failure_category TEXT NOT NULL,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  artifact_refs_json TEXT,
  recommended_action TEXT NOT NULL DEFAULT 'RETRY',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_project ON dead_letter_tasks (project_id, status);
CREATE INDEX IF NOT EXISTS idx_dead_letter_task ON dead_letter_tasks (task_id);

CREATE TABLE IF NOT EXISTS contract_net_cfps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  candidate_agent_ids_json TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  selected_proposal_id TEXT,
  deadline TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cfps_project ON contract_net_cfps (project_id, status);
CREATE INDEX IF NOT EXISTS idx_cfps_task ON contract_net_cfps (task_id);

CREATE TABLE IF NOT EXISTS agent_proposals (
  id TEXT PRIMARY KEY,
  cfp_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  approach TEXT NOT NULL,
  estimated_duration INTEGER,
  confidence REAL NOT NULL,
  capability_match REAL,
  availability_score REAL,
  reasoning_summary TEXT,
  score REAL,
  score_breakdown_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (cfp_id) REFERENCES contract_net_cfps(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_proposals_cfp ON agent_proposals (cfp_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_agent ON agent_proposals (agent_id);

CREATE TABLE IF NOT EXISTS sequence_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  correlation_id TEXT,
  type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_seq_events_project ON sequence_events (project_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_seq_events_task ON sequence_events (task_id);

CREATE TABLE IF NOT EXISTS review_verdicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  comments_json TEXT NOT NULL,
  artifact_id TEXT,
  findings_json TEXT,
  rework_task_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_verdicts_task ON review_verdicts (task_id);

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
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks (workflow_id);
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
