// Seed the e2e database with a populated room.
//
// WHY THIS EXISTS: playwright.config.ts boots the server on a THROWAWAY
// database, so every run started with zero agents and zero tasks. That meant
// the densest, most bug-prone surfaces in the app — the Command Center, the
// inspector, the agent hover card, the roster, the board — were never reached
// by a single test. A whole tab (Artifacts) shipped throwing a ReferenceError
// on its first line, invisible for exactly this reason.
//
// Writing straight to SQLite rather than adding a test-only HTTP endpoint is
// deliberate: an endpoint that creates agents would be new attack surface in
// production code, and this project has already had to close an
// unauthenticated RCE. The database is opened in WAL mode (db/schema.ts), so a
// second writer alongside the running server is safe.
import Database from "better-sqlite3";

/** Must match playwright.config.ts's DB_PATH. */
export const E2E_DB = "/tmp/logbridge-e2e.db";

export interface SeededRoom {
  projectId: string;
  agentIds: string[];
  /** The agent that is deliberately mid-task — use it for task-control UI. */
  workingAgentId: string;
}

/**
 * Insert a room that looks like a real one: several agents across statuses,
 * an agent mid-task, and tasks spread over the board's five columns.
 *
 * Idempotent — safe to call from more than one spec.
 */
export function seedRoom(dbPath = E2E_DB): SeededRoom {
  const db = new Database(dbPath);
  // The server holds the same file; wait rather than fail if it is mid-write.
  db.pragma("busy_timeout = 5000");

  const projectId = "prj_e2e_seed";
  const ownerId = "usr_e2e";
  const machineId = "node_e2e";

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)"
    ).run(projectId, "acme/web-platform", "acme/web-platform", "office");
    db.prepare(
      "INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)"
    ).run(ownerId, "e2e", "E2E User", 0);
    db.prepare(
      "INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)"
    ).run(machineId, ownerId, "e2e-mbp", new Date().toISOString(), 1);
    db.prepare(
      "INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)"
    ).run(projectId, ownerId);

    // Statuses chosen to cover every branch the UI switches on: the pill
    // tints, the roster dots, the zone mapping, and "starting" (CONTRACT 1.27).
    const agents: [string, string, string, string, string][] = [
      // id, name, role, status, description
      ["agt_e2e_dev", "dev-api", "developer", "working", "Backend feature agent. Owns the API surface."],
      ["agt_e2e_plan", "planner-ada", "planner", "idle", "Orchestrator. Breaks epics into tasks."],
      ["agt_e2e_boot", "ui-polish", "developer", "starting", "Frontend agent, still booting."],
      ["agt_e2e_qa", "qa-runner", "qa", "blocked", "Runs the suite; blocked on CI."],
      ["agt_e2e_rev", "review-hawk", "review", "reviewing", "Reviews every PR that touches auth."],
    ];
    const insertAgent = db.prepare(
      `INSERT OR IGNORE INTO agents
         (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency,
          status, character, color, folder, description, provider, is_god)
       VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`
    );
    const chars = ["nancy", "adam", "ash", "lucy"];
    // The status is then FORCED, not just inserted. Two things would otherwise
    // desync it across runs: /tmp/logbridge-e2e.db survives between runs so
    // `INSERT OR IGNORE` is a no-op on the second one, and the server's own
    // recoverServerState() clears `starting` -> `idle` on every boot (by
    // design — a booting agent cannot survive a restart, CONTRACT 1.27). A
    // seed that only inserts would therefore quietly stop seeding the one
    // status this suite most needs to assert.
    const forceStatus = db.prepare("UPDATE agents SET status = ?, description = ? WHERE id = ?");
    agents.forEach(([id, name, role, status, description], i) => {
      insertAgent.run(
        id, machineId, ownerId, projectId, name, role, JSON.stringify(["backend"]),
        status, chars[i % chars.length], "#5DB3C0", "/tmp/e2e-repo",
        description, "claude", role === "planner" ? 1 : 0
      );
      forceStatus.run(status, description, id);
    });

    // Tasks across every board column, so counts, empty states and the
    // summary strip all render against real data.
    const insertTask = db.prepare(
      `INSERT OR IGNORE INTO tasks
         (id, project_id, title, spec, creator_id, agent_id, state, cost_usd, created_at, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    const now = new Date();
    const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    const tasks: [string, string, string, string | null, number, number][] = [
      // id-suffix, title, state, agentId, costUsd, minutesAgo
      ["1", "Triage 14 inbound issues", "submitted", null, 0, 5],
      ["2", "Fix the login redirect loop", "working", "agt_e2e_dev", 2.984, 42],
      ["3", "Add rate-limit to /login", "blocked", "agt_e2e_qa", 0.51, 90],
      ["4", "Rotate OAuth refresh tokens", "completed", "agt_e2e_dev", 1.22, 300],
      ["5", "Redact PII from logs", "completed", "agt_e2e_rev", 0.4, 420],
      ["6", "Migrate ledger to bigint", "failed", "agt_e2e_qa", 0.08, 600],
    ];
    for (const [n, title, state, agentId, cost, mins] of tasks) {
      insertTask.run(
        `tsk_e2e_${n}`, projectId, title, "{}", ownerId, agentId, state, cost,
        ago(mins), agentId ? ago(mins) : null
      );
    }
    // The task the working agent is actually on — the office reads this to
    // place it, and the inspector reads it for the task card.
    db.prepare("UPDATE agents SET current_task = ? WHERE id = ?").run("tsk_e2e_2", "agt_e2e_dev");
  });

  tx();
  db.close();

  return {
    projectId,
    agentIds: ["agt_e2e_dev", "agt_e2e_plan", "agt_e2e_boot", "agt_e2e_qa", "agt_e2e_rev"],
    workingAgentId: "agt_e2e_dev",
  };
}
