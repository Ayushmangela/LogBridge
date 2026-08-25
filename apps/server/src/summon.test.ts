import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "./index.js";
import { openDb, type Db, summonAgent, clearSummon, setAgentStatus } from "./db.js";
import { Positions, buildView } from "./view.js";
import { WorkspaceView } from "@logbridge/protocol";

function seedAgent(db: Db, status = "idle", online = true) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_acme_api", "acme/api", "acme/api", "office"
  );
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, ?)").run("usr_ayush", "ayush", "ayush", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)").run(
    "node_m1", "usr_ayush", "m1", new Date().toISOString(), online ? 1 : 0
  );
  db.prepare(
    "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("agt_1", "node_m1", "usr_ayush", "prj_acme_api", "dev-api", "developer", status);
}

describe("summon — DB and view", () => {
  test("summonedPos appears in view and validates against contract", () => {
    const db = openDb(":memory:");
    seedAgent(db, "idle", true);
    summonAgent(db, "agt_1", "you", 10, 20);
    const view = buildView(db, new Positions(), "usr_ayush");
    const ag = view.rooms[0].agents[0];
    expect(ag.summonedBy).toBe("you");
    expect(ag.summonedPos).toEqual({ x: 10, y: 20 });
    expect(WorkspaceView.safeParse(view).success).toBe(true);
    // second browser sees same
    const view2 = buildView(db, new Positions(), "usr_other");
    expect(view2.rooms[0].agents[0].summonedPos).toEqual({ x: 10, y: 20 });
    db.close();
  });

  test("dismiss clears summon and view shows null", () => {
    const db = openDb(":memory:");
    seedAgent(db, "idle", true);
    summonAgent(db, "agt_1", "you", 5, 6);
    clearSummon(db, "agt_1");
    const view = buildView(db, new Positions(), "usr_ayush");
    expect(view.rooms[0].agents[0].summonedPos).toBeNull();
    expect(view.rooms[0].agents[0].summonedBy).toBeNull();
    db.close();
  });

  test("work always wins: setAgentStatus to working clears summon", () => {
    const db = openDb(":memory:");
    seedAgent(db, "idle", true);
    summonAgent(db, "agt_1", "you", 8, 9);
    setAgentStatus(db, "agt_1", "working", "tsk_1");
    const view = buildView(db, new Positions(), "usr_ayush");
    expect(view.rooms[0].agents[0].summonedPos).toBeNull();
    // And placement would be working zone, not summoned
    expect(view.rooms[0].agents[0].zone).toBe("working");
    db.close();
  });

  test("summon and cancel land in activity feed", () => {
    const db = openDb(":memory:");
    seedAgent(db, "idle", true);
    summonAgent(db, "agt_1", "you", 10, 20);
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)").run(
      "prj_acme_api", null, "summon", JSON.stringify({ agentId: "agt_1", agentName: "dev-api", by: "you", x: 10, y: 20 }), new Date().toISOString()
    );
    let view = buildView(db, new Positions(), "usr_ayush");
    expect(view.rooms[0].activity.some((a) => a.type === "summon" && a.summary.includes("called"))).toBe(true);

    clearSummon(db, "agt_1");
    db.prepare("INSERT INTO events (project_id, task_id, type, body, ts) VALUES (?, ?, ?, ?, ?)").run(
      "prj_acme_api", null, "summon.cancel", JSON.stringify({ agentId: "agt_1", agentName: "dev-api", by: "you" }), new Date().toISOString()
    );
    view = buildView(db, new Positions(), "usr_ayush");
    expect(view.rooms[0].activity.some((a) => a.type === "summon.cancel")).toBe(true);
    db.close();
  });
});

describe("summon — HTTP endpoint", () => {
  let server: BuiltServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = await buildServer({ dbPath: ":memory:" });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    // seed minimal project/agent/machine via direct DB (same as unit seed)
    server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
      "prj_acme_api", "acme/api", "acme/api", "office"
    );
    server.db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, ?)").run("usr_ayush", "ayush", "ayush", 0);
    server.db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)").run(
      "node_m1", "usr_ayush", "m1", new Date().toISOString(), 1
    );
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_idle", "node_m1", "usr_ayush", "prj_acme_api", "dev-idle", "developer", "idle");
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_busy", "node_m1", "usr_ayush", "prj_acme_api", "dev-busy", "developer", "working");
    // offline machine
    server.db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)").run(
      "node_off", "usr_ayush", "off-m", new Date().toISOString(), 0
    );
    server.db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_off", "node_off", "usr_ayush", "prj_acme_api", "dev-off", "developer", "idle");
  });

  afterEach(async () => {
    await server.app.close();
  });

  test("POST /api/summon succeeds for idle, fails for busy and offline with readable reason", async () => {
    // idle succeeds
    let res = await fetch(`${baseUrl}/api/summon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_idle", x: 10, y: 20 }),
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.ok).toBe(true);
    // busy fails
    res = await fetch(`${baseUrl}/api/summon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_busy", x: 10, y: 20 }),
    });
    expect(res.status).toBe(409);
    body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/busy/i);
    // offline fails
    res = await fetch(`${baseUrl}/api/summon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_off", x: 10, y: 20 }),
    });
    expect(res.status).toBe(409);
    body = await res.json();
    expect(body.error).toMatch(/offline/i);
  });

  test("dismiss succeeds when summoned, fails when not summoned", async () => {
    // summon first
    await fetch(`${baseUrl}/api/summon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_idle", x: 5, y: 5 }),
    });
    let res = await fetch(`${baseUrl}/api/summon/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_idle" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // second cancel fails
    res = await fetch(`${baseUrl}/api/summon/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_idle" }),
    });
    expect(res.status).toBe(409);
  });

  test("summon is visible via view and stays until dismissed or work", async () => {
    await fetch(`${baseUrl}/api/summon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_idle", x: 12, y: 15 }),
    });
    // view shows summonedPos
    let viewRes = await fetch(`${baseUrl}/healthz`);
    // healthz not view — fetch view via ws? Instead we check DB via direct view helper
    // Use server.db directly for simplicity: view already tested above, here we test HTTP roundtrip
    const view = buildView(server.db, new Positions(), "usr_ayush");
    expect(view.rooms[0].agents.find((a) => a.id === "agt_idle")?.summonedPos).toEqual({ x: 12, y: 15 });
    // assign work -> should clear (simulate via setAgentStatus)
    setAgentStatus(server.db, "agt_idle", "working", "tsk_1");
    const view2 = buildView(server.db, new Positions(), "usr_ayush");
    expect(view2.rooms[0].agents.find((a) => a.id === "agt_idle")?.summonedPos).toBeNull();
  });
});
