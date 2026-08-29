import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type BuiltServer } from "./index.js";

/**
 * deliverTaskLocally has no completion signal — a locally-delivered task
 * stays `working`, and the agent stays "busy," forever. That silently
 * drops every SUBSEQUENT chat instruction to the same agent, because
 * parseMention only creates a task for an idle agent — one locally
 * delivered task permanently ends a human's ability to talk to that agent
 * through chat again. completeLocalTask (and the /api/tasks/:id/complete
 * route wrapping it) is the manual escape hatch.
 */
describe("completing a locally-delivered task un-sticks the agent", () => {
  let server: BuiltServer | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (server) { await server.app.close(); server = null; }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} dir = null; }
  });

  async function boot() {
    server = await buildServer({ dbPath: ":memory:" });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address() as any;
    dir = mkdtempSync(join(tmpdir(), "logbridge-local-complete-"));

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T', ?)").run(dir);
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss','m_no_runner','u1','prj_t','commando','planner', ?, 'idle', 1)`
    ).run(dir);

    return { url: `ws://127.0.0.1:${address.port}/ws` };
  }

  async function sendMention(ws: WebSocket, text: string) {
    ws.send(JSON.stringify({ type: "chat", roomId: "prj_t", userId: "usr_alice", text }));
    await new Promise((r) => setTimeout(r, 250));
  }

  test("a second chat instruction is silently dropped until the first is completed", async () => {
    const { url } = await boot();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "join", roomId: "prj_t", userId: "usr_alice" }));
    await new Promise((r) => setTimeout(r, 80));

    await sendMention(ws, "@commando build the homepage");
    const first = server!.db.prepare(
      "SELECT * FROM tasks WHERE project_id='prj_t' ORDER BY rowid DESC LIMIT 1"
    ).get() as any;
    expect(first.state).toBe("working");

    // Reproduces the bug: silently no-op'd, not a new task, not an error.
    await sendMention(ws, "@commando now add a FAQ section");
    const stillOne = server!.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id='prj_t'").get() as any;
    expect(stillOne.n).toBe(1);

    // The fix: complete the first task through the real route...
    const complete = await server!.app.inject({
      method: "POST", url: `/api/tasks/${first.id}/complete`,
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().ok).toBe(true);

    const agent = server!.db.prepare("SELECT * FROM agents WHERE id='agt_boss'").get() as any;
    expect(agent.status).toBe("idle");
    expect(server!.db.prepare("SELECT state FROM tasks WHERE id=?").get(first.id)).toMatchObject({ state: "completed" });

    // ...and now the second instruction actually goes through.
    await sendMention(ws, "@commando now add a FAQ section");
    const total = server!.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id='prj_t'").get() as any;
    expect(total.n).toBe(2);

    ws.close();
  }, 15_000);
});
