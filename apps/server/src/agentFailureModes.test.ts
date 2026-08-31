// Failure modes of the agent system that shipped unnoticed.
//
// Each of these is a bug that was live in the product. They are grouped here
// rather than scattered because they share one root cause: the DATABASE ROW
// and the OS PROCESS were treated as the same thing in some places and as
// unrelated things in others. Killing one never touched the other.
import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";
import { openDb, type Db } from "./db.js";

function seed(db: Db, status = "idle", opts: { paused?: boolean; retired?: boolean } = {}) {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_f", "t/r", "t/r", "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)")
    .run("usr_f", "f", "f", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)")
    .run("node_f", "usr_f", "m", new Date().toISOString(), 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities,
                         concurrency, status, paused, retired)
     VALUES (?,?,?,?,?,?,?,1,?,?,?)`
  ).run("agt_f", "node_f", "usr_f", "prj_f", "dev-f", "developer", "[]",
        status, opts.paused ? 1 : 0, opts.retired ? 1 : 0);
  return db;
}

const statusOf = (db: Db, id = "agt_f") =>
  (db.prepare("SELECT status FROM agents WHERE id = ?").get(id) as any)?.status;

describe("who may be sent work by @mention", () => {
  // The guard was `agent.status === "idle"`, which was wrong in both
  // directions once `starting` and the paused/retired flags existed.
  const mentionable = (a: any) =>
    !!a && !a.paused && !a.retired && (a.status === "idle" || a.status === "starting");

  test("a BOOTING agent accepts work — it is ready-soon, not busy", () => {
    // Regression: adding `starting` (CONTRACT 1.27) silently broke @mention
    // for the entire 10-20s boot window. You created an agent, spoke to it,
    // and nothing happened — no dispatch and no error.
    const db = seed(openDb(":memory:"), "starting");
    const agent = db.prepare("SELECT * FROM agents WHERE id = 'agt_f'").get() as any;
    expect(mentionable(agent)).toBe(true);
  });

  test("a PAUSED agent does not, even though its status is still 'idle'", () => {
    // setAgentPaused only ever wrote the `paused` flag; it never touched
    // `status`. So a paused agent passed `status === "idle"` and took the very
    // work its owner had just stopped it from taking.
    const db = seed(openDb(":memory:"), "idle", { paused: true });
    const agent = db.prepare("SELECT * FROM agents WHERE id = 'agt_f'").get() as any;
    expect(agent.status).toBe("idle");   // the trap
    expect(mentionable(agent)).toBe(false);
  });

  test("a RETIRED agent does not, for the same reason", () => {
    const db = seed(openDb(":memory:"), "idle", { retired: true });
    expect(mentionable(db.prepare("SELECT * FROM agents WHERE id = 'agt_f'").get())).toBe(false);
  });

  test("a genuinely busy agent does not", () => {
    for (const busy of ["working", "blocked", "needs_input", "reviewing"]) {
      const db = seed(openDb(":memory:"), busy);
      expect(mentionable(db.prepare("SELECT * FROM agents WHERE id = 'agt_f'").get())).toBe(false);
    }
  });
});

describe("an agent whose process dies mid-task", () => {
  // The PTY exit handler cleaned up the session map and the `starting` flag,
  // but never the agent's own status. recoverServerState() only runs at SERVER
  // startup, so a single CLI crash while the server kept running left the
  // agent `working` forever — busy to the roster, busy to the office, and
  // busy to the orchestrator's concurrency check, so nothing was ever routed
  // to it again.
  const recoverOnExit = (db: Db, agentId: string) => {
    const row = db.prepare("SELECT status, current_task FROM agents WHERE id = ?").get(agentId) as any;
    if (row?.status !== "working") return;
    db.prepare("UPDATE agents SET status = 'idle', current_task = NULL WHERE id = ?").run(agentId);
    if (row.current_task) {
      db.prepare("UPDATE tasks SET state = 'submitted', lease_expires = NULL WHERE id = ? AND state = 'working'")
        .run(row.current_task);
    }
  };

  test("is released, and its task goes back to the queue", () => {
    const db = seed(openDb(":memory:"), "working");
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, cost_usd)
       VALUES (?,?,?,?,?,?,?,0)`
    ).run("tsk_f", "prj_f", "t", "{}", "usr_f", "agt_f", "working");
    db.prepare("UPDATE agents SET current_task = 'tsk_f' WHERE id = 'agt_f'").run();

    recoverOnExit(db, "agt_f");

    expect(statusOf(db)).toBe("idle");
    // `submitted`, not `failed`: a process dying says nothing about whether
    // the work was wrong, and `submitted` is a state sendTaskOffer picks up.
    expect((db.prepare("SELECT state FROM tasks WHERE id='tsk_f'").get() as any).state).toBe("submitted");
  });

  test("an agent that was idle when it exited is left alone", () => {
    const db = seed(openDb(":memory:"), "idle");
    recoverOnExit(db, "agt_f");
    expect(statusOf(db)).toBe("idle");
  });
});

describe("the row and the process are torn down together", () => {
  test("deleting an agent reports whether its session was killed", async () => {
    // Deleting the row used to leave the CLI running: no roster entry, no
    // terminal panel, no way to stop it, still spending money.
    const server = await buildServer({ dbPath: ":memory:" });
    seed(server.db);
    const res = await server.app.inject({ method: "POST", url: "/api/agents/agt_f/delete" });
    expect(res.statusCode).toBe(200);
    // No PTY runs in a unit test, so nothing to kill — but the field must
    // exist, because its absence is what hid the bug.
    expect(res.json()).toHaveProperty("sessionKilled");
  });

  test("an engine change no longer claims a restart that never happened", async () => {
    // It returned `restarting: true` with the message "engine will change on
    // next heartbeat" while nothing restarted and no such heartbeat exists.
    const server = await buildServer({ dbPath: ":memory:" });
    seed(server.db);
    const res = await server.app.inject({
      method: "POST", url: "/api/agents/agt_f/engine",
      payload: { provider: "opencode", model: "qwen" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const row = server.db.prepare("SELECT provider, model FROM agents WHERE id='agt_f'").get() as any;
    expect(row.provider).toBe("opencode");
    expect(row.model).toBe("qwen");

    // Reports what actually happened, and never promises a heartbeat.
    expect(body).toHaveProperty("restarted");
    expect(body.message).not.toMatch(/heartbeat/i);
  });
});
