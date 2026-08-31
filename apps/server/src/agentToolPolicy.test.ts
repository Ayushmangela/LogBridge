// Tool policy used to exist in exactly one place: the runner's
// created-agents.json, on the machine that runs the agent. On a shared floor
// that is somebody else's laptop, so nothing could show you what a teammate's
// agent was permitted to do, the edit dialog could not change it, and losing
// that file silently reverted the agent to the runner's defaults.
//
// The distinction these tests protect is null vs []:
//   null -> "no policy recorded", the runner applies its own defaults
//   []   -> "deliberately empty"
// Collapsing them would let a blank form field mean "this agent may use no
// tools at all", which is a permissions change nobody asked for.
import { describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { buildView, Positions } from "./view.js";
import { AgentView } from "@logbridge/protocol";

function seed(db: Db, allow: string | null = null, deny: string | null = null) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_p", "t/r", "t/r", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)")
    .run("usr_p", "p", "p", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)")
    .run("node_p", "usr_p", "m", new Date().toISOString(), 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, allow_tools, deny_paths)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run("agt_p", "node_p", "usr_p", "prj_p", "policy-test", "developer", "[]", 1, "idle", allow, deny);
  return db;
}

const agentIn = (db: Db) => buildView(db, new Positions(), "usr_p").rooms[0].agents[0];

describe("tool policy survives on the server, not only on the runner", () => {
  test("the columns exist — an older database is migrated, not broken", () => {
    const db = openDb(":memory:");
    const cols = (db.prepare("PRAGMA table_info(agents)").all() as any[]).map((c) => c.name);
    expect(cols).toContain("allow_tools");
    expect(cols).toContain("deny_paths");
    db.close();
  });

  test("a stored policy reaches the browser", () => {
    const db = seed(openDb(":memory:"), JSON.stringify(["Read", "Grep"]), JSON.stringify(["**/.env"]));
    const agent = agentIn(db);
    expect(agent.allowTools).toEqual(["Read", "Grep"]);
    expect(agent.denyPaths).toEqual(["**/.env"]);
    db.close();
  });

  test("never set stays null — NOT an empty array", () => {
    // The whole point. [] here would tell the browser this agent is permitted
    // no tools, when the truth is that nobody has said anything yet and the
    // runner's defaults are in force.
    const db = seed(openDb(":memory:"));
    const agent = agentIn(db);
    expect(agent.allowTools).toBeNull();
    expect(agent.denyPaths).toBeNull();
    db.close();
  });

  test("deliberately empty is preserved as empty", () => {
    const db = seed(openDb(":memory:"), "[]", "[]");
    const agent = agentIn(db);
    expect(agent.allowTools).toEqual([]);
    expect(agent.denyPaths).toEqual([]);
    db.close();
  });

  test("a corrupt column degrades to null rather than blanking the office", () => {
    // buildView validates the whole view and sends NOTHING when validation
    // fails (the 1.22 lesson), so one unparseable column must not cost every
    // viewer the entire office.
    const db = seed(openDb(":memory:"), "{not json", "[[[");
    const agent = agentIn(db);
    expect(agent.allowTools).toBeNull();
    expect(agent.denyPaths).toBeNull();
    expect(() => AgentView.parse(agent)).not.toThrow();
    db.close();
  });

  test("the view still validates against the contract with a policy present", () => {
    const db = seed(openDb(":memory:"), JSON.stringify(["Read"]), JSON.stringify(["**/secrets/**"]));
    expect(() => AgentView.parse(agentIn(db))).not.toThrow();
    db.close();
  });
});
