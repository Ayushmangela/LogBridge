import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, type BuiltServer } from "./index.js";

/**
 * "@commando develop the website" acknowledged in chat with "On it —" but
 * never actually reached the terminal. Cause: sendTaskOffer only knows how
 * to deliver over a connected node-ws runner socket. An agent created
 * through "Create New Project" / "Add an agent" in the UI has no such
 * socket — its CLI runs as an in-process PTY the server spawned directly —
 * so the offer silently failed and the task sat `submitted` forever while
 * chat had already said the agent was on it.
 *
 * deliverTaskLocally (task-offers.ts) is the fallback: inject the task
 * straight into the agent's PTY and drive the same task.accept bookkeeping
 * a real runner's accept would. It's scoped to the human chat/approve paths
 * only, not folded into sendTaskOffer itself — see the comment on
 * deliverTaskLocally for why sendTaskOffer's callers need "false" to still
 * mean "wait for reconcileOnConnect."
 */
describe("a chat-assigned task reaches an agent with no connected runner", () => {
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
    dir = mkdtempSync(join(tmpdir(), "logbridge-local-delivery-"));

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T', ?)").run(dir);
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, folder, status, is_god)
       VALUES ('agt_boss','m_no_runner','u1','prj_t','commando','planner', ?, 'idle', 1)`
    ).run(dir);

    return { url: `ws://127.0.0.1:${address.port}/ws` };
  }

  test("the task is delivered to the PTY and marked working, not left submitted", async () => {
    const { url } = await boot();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "join", roomId: "prj_t", userId: "usr_alice" }));
    await new Promise((r) => setTimeout(r, 80));

    ws.send(JSON.stringify({
      type: "chat", roomId: "prj_t", userId: "usr_alice",
      text: "@commando develop the samsung website",
    }));
    await new Promise((r) => setTimeout(r, 300));

    const task = server!.db.prepare(
      "SELECT * FROM tasks WHERE project_id = 'prj_t' ORDER BY rowid DESC LIMIT 1"
    ).get() as any;
    expect(task).toBeTruthy();
    // The bug: this used to stay "submitted" forever with no connected runner.
    expect(task.state).toBe("working");

    const agent = server!.db.prepare("SELECT * FROM agents WHERE id = 'agt_boss'").get() as any;
    expect(agent.status).toBe("working");

    const attempt = server!.db.prepare(
      "SELECT * FROM task_attempts WHERE task_id = ?"
    ).get(task.id) as any;
    expect(attempt).toBeTruthy();

    ws.close();
  }, 15_000);
});
