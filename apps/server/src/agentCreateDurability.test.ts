import { describe, expect, test } from "vitest";
import { openDb } from "./db.js";
import { requestAgentCreate, pendingAgentCreates } from "./nodeGateway/agent-creation.js";

/**
 * A subordinate agent could be added through the UI, appear in the hive
 * (registry.json, its own identity.md, a live terminal) — and never show up
 * in the sidebar or receive task offers, because the SQL row for it was
 * never created. Cause: when a runner is connected, requestAgentCreate sends
 * the request over the socket and trusted the runner's "ok" acknowledgment
 * at face value, leaving the actual INSERT to a separate, later "agent.card"
 * broadcast the runner sends afterward. If that second message never
 * arrived — runner attached to a different project, dropped connection,
 * anything — the row simply never existed, silently.
 *
 * requestAgentCreate now inserts the row itself as soon as the runner
 * confirms, so the row's existence never depends on a second message.
 */
describe("a runner's create confirmation is durable on its own", () => {
  function machineOnlineWithSocket(db: ReturnType<typeof openDb>) {
    db.prepare(
      `INSERT INTO machines (id, owner_id, name, online, allow_agent_creation)
       VALUES ('m1','u1','Test Machine',1,1)`
    ).run();
  }

  test("a bare ok:true from the runner is enough to create the row — no agent.card needed", async () => {
    const db = openDb(":memory:");
    machineOnlineWithSocket(db);
    db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T','/tmp/t')").run();

    const sent: any[] = [];
    const fakeSocket = { send: (data: string) => sent.push(JSON.parse(data)) };
    const nodeSockets = new Map([["m1", fakeSocket as any]]);

    const promise = requestAgentCreate(db, nodeSockets as any, {
      machineId: "m1", projectId: "prj_t", name: "ram", role: "planner",
    } as any);

    // Simulate the runner replying with agent.create.result and, crucially,
    // never sending a follow-up agent.card — the exact condition that left
    // the row missing in production.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    const requestId = sent[0].body.requestId;
    pendingAgentCreates.get(requestId)?.({ ok: true, agentId: "agt_ram_1", error: null });

    const result = await promise;
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT id, name, project_id, is_god FROM agents WHERE id = ?").get("agt_ram_1") as any;
    expect(row).toBeTruthy();
    expect(row.name).toBe("ram");
    expect(row.project_id).toBe("prj_t");
    // A runner-created agent is never the commander — that row is always
    // inserted directly by routes/projects.ts.
    expect(row.is_god).toBe(0);
  });

  test("a refusal from the runner creates no row", async () => {
    const db = openDb(":memory:");
    machineOnlineWithSocket(db);
    db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_t','T','/tmp/t')").run();

    const sent: any[] = [];
    const fakeSocket = { send: (data: string) => sent.push(JSON.parse(data)) };
    const nodeSockets = new Map([["m1", fakeSocket as any]]);

    const promise = requestAgentCreate(db, nodeSockets as any, {
      machineId: "m1", projectId: "prj_t", name: "ram", role: "planner",
    } as any);
    await new Promise((r) => setTimeout(r, 10));
    const requestId = sent[0].body.requestId;
    pendingAgentCreates.get(requestId)?.({ ok: false, agentId: null, error: "refused" });

    const result = await promise;
    expect(result.ok).toBe(false);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = 'prj_t'").get() as any).n;
    expect(count).toBe(0);
  });
});
