// "starting" — the state between an agent existing and its CLI being usable.
//
// Before this existed a booting agent reported "idle", which is the same
// thing a ready agent reports. A 10-20s cold start therefore looked like an
// agent ignoring you, and there was no way to tell the two apart.
//
// These test the STATE MACHINE rather than the PTY: spawning a real CLI in a
// unit test would make the suite depend on which binaries the machine has
// installed, which is exactly the trap PROVIDERS.md warns about.
import { describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { zoneFor, AgentStatus } from "@logbridge/protocol";
import { recoverServerState } from "./recovery.js";

function seed(db: Db, status = "idle") {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_s", "t/r", "t/r", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)")
    .run("usr_s", "s", "s", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)")
    .run("node_s", "usr_s", "m", new Date().toISOString(), 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("agt_s", "node_s", "usr_s", "prj_s", "boot-test", "developer", "[]", 1, status);
  return db;
}

// The transitions ptyGateway performs around a CLI boot.
const markStarting = (db: Db, id: string) => {
  const row = db.prepare("SELECT status FROM agents WHERE id = ?").get(id) as any;
  if (!row || (row.status && row.status !== "idle")) return false;
  db.prepare("UPDATE agents SET status = 'starting' WHERE id = ?").run(id);
  return true;
};
const clearStarting = (db: Db, id: string) => {
  const row = db.prepare("SELECT status FROM agents WHERE id = ?").get(id) as any;
  if (row?.status === "starting") {
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(id);
  }
};
const statusOf = (db: Db, id: string) =>
  (db.prepare("SELECT status FROM agents WHERE id = ?").get(id) as any)?.status;

describe("agent readiness — the starting state", () => {
  test("'starting' is a real status in the protocol", () => {
    expect(AgentStatus.options).toContain("starting");
    expect(() => AgentStatus.parse("starting")).not.toThrow();
  });

  test("an idle agent goes to 'starting' while its CLI boots, then back to idle", () => {
    const db = seed(openDb(":memory:"));
    expect(markStarting(db, "agt_s")).toBe(true);
    expect(statusOf(db, "agt_s")).toBe("starting");
    clearStarting(db, "agt_s");
    expect(statusOf(db, "agt_s")).toBe("idle");
  });

  test("booting NEVER clobbers an agent that is already doing something", () => {
    // The runner owns working/needs_input/etc. A boot notice that overwrote
    // them would make the office lie about live work.
    for (const busy of ["working", "needs_input", "reviewing", "blocked"]) {
      const db = seed(openDb(":memory:"), busy);
      expect(markStarting(db, "agt_s")).toBe(false);
      expect(statusOf(db, "agt_s")).toBe(busy);
    }
  });

  test("an agent that starts working mid-boot keeps working, not idle", () => {
    // The readiness signal can land after the agent already took a task.
    // clearStarting re-reads for exactly this reason.
    const db = seed(openDb(":memory:"));
    markStarting(db, "agt_s");
    db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run("agt_s");
    clearStarting(db, "agt_s");
    expect(statusOf(db, "agt_s")).toBe("working");
  });

  test("a restart releases agents stranded mid-boot", () => {
    // Found by running it: `starting` is persisted in the database, but the
    // things that clear it — the CLI's readiness signal and its timeout — live
    // in the PTY session, which dies with the process. A restart mid-boot left
    // the agent claiming to be starting up with nothing alive to contradict
    // it, and it stayed that way indefinitely.
    const db = seed(openDb(":memory:"), "starting");
    const report = recoverServerState(db);
    expect(statusOf(db, "agt_s")).toBe("idle");
    expect(report.releasedStartingCount).toBe(1);
  });

  test("recovery leaves agents that are genuinely working alone", () => {
    const db = seed(openDb(":memory:"), "working");
    const report = recoverServerState(db);
    expect(statusOf(db, "agt_s")).toBe("working");
    expect(report.releasedStartingCount).toBe(0);
  });

  test("a starting agent stands in the idle zone, not a zone the map lacks", () => {
    // assets/office.json ships cabin/working/blocked/reviewing/collaborating/
    // idle/done. Returning a ZoneId with no rect would fail view validation
    // and blank the office for every viewer — see CONTRACT.md 1.22.
    const zone = zoneFor({ status: "starting", waitingOn: null });
    expect(zone).toBe("idle");
  });
});
