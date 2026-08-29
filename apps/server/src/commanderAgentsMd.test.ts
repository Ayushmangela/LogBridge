import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type BuiltServer } from "./index.js";
import { spawnOrGetPtySession } from "./ptyGateway.js";

/**
 * Multiple agents in a project commonly share one project folder as their
 * cwd. Every PTY spawn used to write that shared folder's AGENTS.md with
 * ITS OWN identity — so whichever agent's terminal opened most recently
 * decided what any agent's next cold start would read there, including the
 * real commander's. Only the commander should own that file; a subordinate's
 * identity already lives in its own hive/agents/<id>/identity.md.
 */
describe("only the commander writes the shared project AGENTS.md", () => {
  let server: BuiltServer | null = null;
  let dir: string | null = null;
  const liveProcs: { kill: () => void }[] = [];

  afterEach(async () => {
    for (const p of liveProcs.splice(0)) { try { p.kill(); } catch {} }
    if (server) { await server.app.close(); server = null; }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} dir = null; }
  });

  async function setup() {
    server = await buildServer({ dbPath: ":memory:" });
    dir = mkdtempSync(join(tmpdir(), "logbridge-agentsmd-"));
    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T', ?)").run(dir);
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss','m1','u1','prj_t','commando','planner', ?, 'idle', 1)`
    ).run(dir);
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_sub','m1','u1','prj_t','ram','planner', ?, 'idle', 0)`
    ).run(dir);
    return { db: server.db, dir: dir! };
  }

  test("commander's spawn writes AGENTS.md naming the commander", async () => {
    const { db, dir } = await setup();
    const session = spawnOrGetPtySession(db, "pty-t-boss", "agt_boss", 80, 24);
    liveProcs.push(session.proc);
    await new Promise((r) => setTimeout(r, 150));

    const path = join(dir, "AGENTS.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/commando/i);
  });

  test("a same-role subordinate's spawn does not touch AGENTS.md at all", async () => {
    const { db, dir } = await setup();
    const session = spawnOrGetPtySession(db, "pty-t-sub", "agt_sub", 80, 24);
    liveProcs.push(session.proc);
    await new Promise((r) => setTimeout(r, 150));

    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  test("a subordinate spawned after the commander cannot overwrite the commander's file", async () => {
    const { db, dir } = await setup();
    const boss = spawnOrGetPtySession(db, "pty-t-boss2", "agt_boss", 80, 24);
    liveProcs.push(boss.proc);
    await new Promise((r) => setTimeout(r, 120));

    const sub = spawnOrGetPtySession(db, "pty-t-sub2", "agt_sub", 80, 24);
    liveProcs.push(sub.proc);
    await new Promise((r) => setTimeout(r, 120));

    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).toMatch(/commando/i);
    expect(content).not.toMatch(/\bram\b/i);
  });
});
