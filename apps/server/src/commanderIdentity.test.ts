import { describe, expect, test } from "vitest";
import { buildServer, type BuiltServer } from "./index.js";

/**
 * Live production data had two agents in one project with role "planner":
 * the real commander, and a subordinate the user deliberately gave a
 * planning-flavored role. Both server-side "who's the commander" checks —
 * GET /api/projects and the PTY spawn's isCommander heuristic — inferred
 * commander-ness from role/name alone, so the two agents tied. Whichever
 * one's terminal was spawned more recently won the shared project-root
 * AGENTS.md file: the real commander's own CLI then read that file on its
 * next cold start and introduced itself as the subordinate.
 *
 * is_god is the fix: set once, explicitly, only on the agent actually
 * created as a project's commander (routes/projects.ts) — never inferred.
 */
describe("commander identity survives a same-role subordinate", () => {
  async function projectWithCollidingRoles() {
    const server = await buildServer({ dbPath: ":memory:" });
    server.db.prepare(
      "INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t', 'T', '/tmp/t')"
    ).run();
    // The subordinate is inserted FIRST: a plain SELECT with no ORDER BY
    // returns SQLite rows in rowid order, so `.find(role === "planner")`
    // without is_god would hit this row before the real commander's — which
    // is what actually happened live once a second "planner" was added.
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_sub','m1','u1','prj_t','ram','planner','/tmp/t','idle',0)`
    ).run();
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss','m1','u1','prj_t','commando','planner','/tmp/t','idle',1)`
    ).run();
    return server;
  }

  test("GET /api/projects reports the real commander, not whichever planner sorts first", async () => {
    const server = await projectWithCollidingRoles();
    const res = await server.app.inject({ method: "GET", url: "/api/projects" });
    const body = res.json();
    const proj = body.projects.find((p: any) => p.id === "prj_t");
    expect(proj.commanderId).toBe("agt_boss");
    expect(proj.commanderName).toBe("commando");
    await server.app.close();
  });

  test("a legacy row with no is_god falls back to the old heuristic, not silently 'no commander'", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    server.db.prepare(
      "INSERT INTO projects (id, name, gh_repo) VALUES ('prj_legacy', 'L', '/tmp/l')"
    ).run();
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status)
       VALUES ('agt_old_boss','m1','u1','prj_legacy','commander','planner','/tmp/l','idle')`
    ).run();
    const res = await server.app.inject({ method: "GET", url: "/api/projects" });
    const proj = res.json().projects.find((p: any) => p.id === "prj_legacy");
    expect(proj.commanderId).toBe("agt_old_boss");
    await server.app.close();
  });
});
