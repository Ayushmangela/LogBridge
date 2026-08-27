import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceView, type WorkspaceViewT } from "@logbridge/protocol";
import { appendEvent, openDb, type Db } from "./db.js";
import { Positions, buildView } from "./view.js";
import { HiveManager } from "./hive.js";

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_acme_api", "acme/api", "acme/api", "office"
  );
  const insUser = db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?, ?, ?, ?)");
  insUser.run("usr_sam", "sam", "sam", 1);
  insUser.run("usr_ayush", "ayush", "ayush", 0);
  db.prepare(
    "INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)"
  ).run("node_sams_mbp", "usr_sam", "sams-mbp", new Date().toISOString(), 1);

  const insAgent = db.prepare(
    "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status, current_task, waiting_on, zone_anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insAgent.run("agt_qa", "node_sams_mbp", "usr_sam", "prj_acme_api",
    "qa-api", "qa", "working", null, null, null);
  insAgent.run("agt_dev", "node_sams_mbp", "usr_sam", "prj_acme_api",
    "dev-api", "developer", "blocked", null, "qa-api@sams-mbp", null);
  insAgent.run("agt_doc", "node_sams_mbp", "usr_sam", "prj_acme_api",
    "doc-api", "docs", "needs_input", null, "human: sam", null);
  insAgent.run("agt_rev", "node_sams_mbp", "usr_sam", "prj_acme_api",
    "rev-api", "review", "reviewing", null, null, null);
  insAgent.run("agt_idle", "node_sams_mbp", "usr_sam", "prj_acme_api",
    "idle-a", "research", "idle", null, null, null);
  insAgent.run("agt_done", "node_sams_mbp", "usr_sam", "prj_acme_api",
    "done-a", "planner", "completed", null, null, null);
}

function roomOf(view: WorkspaceViewT) {
  return view.rooms[0];
}

describe("buildView", () => {
  test("projects seeded state into contract shape with correct zones", () => {
    const db = openDb(":memory:");
    seed(db);
    const positions = new Positions();
    positions.set("usr_ayush", { roomId: "prj_acme_api", x: 10, y: 20 });

    const view = buildView(db, positions, "usr_ayush");
    expect(view.meId).toBe("usr_ayush");
    expect(view.rooms).toHaveLength(1);

    const room = roomOf(view);
    expect(room.id).toBe("prj_acme_api");
    expect(room.layout).toBe("office");

    // humans
    expect(room.humans.map((h) => h.id).sort()).toEqual(["usr_ayush"]);
    expect(room.humans[0].position).toEqual({ x: 10, y: 20 });
    expect(room.humans[0].cabin).toBe(1); // insertion order index % 4

    // machines
    expect(room.machines[0]).toMatchObject({
      id: "node_sams_mbp", name: "sams-mbp", ownerId: "usr_sam", online: true,
    });

    // zones
    const zoneOf = Object.fromEntries(room.agents.map((a) => [a.name, a.zone]));
    expect(zoneOf["qa-api"]).toBe("working");
    expect(zoneOf["dev-api"]).toBe("collaborating"); // blocked on another person's agent
    expect(zoneOf["doc-api"]).toBe("needs_human");
    expect(zoneOf["rev-api"]).toBe("reviewing");
    expect(zoneOf["idle-a"]).toBe("idle");
    expect(zoneOf["done-a"]).toBe("done");

    // slots stable and dense per zone
    for (const zone of new Set(room.agents.map((a) => a.zone))) {
      const slots = room.agents.filter((a) => a.zone === zone).map((a) => a.slot);
      expect(slots).toEqual(slots.map((_, i) => i));
    }

    // needs_human resolves to the waiting human's cabin
    // (sam inserted first → cabin 0; ayush second → cabin 1)
    const doc = room.agents.find((a) => a.name === "doc-api");
    expect(doc?.zoneAnchor).toBe(0); // sam's cabin
  });

  test("machines are scoped to rooms where they actually run an agent", () => {
    const db = openDb(":memory:");
    seed(db);
    // a second project + a second machine that has NO agent on prj_acme_api
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
      "prj_other", "acme/other", "acme/other", "office"
    );
    db.prepare(
      "INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?, ?, ?, ?, ?)"
    ).run("node_unrelated", "usr_ayush", "ayush-desktop", new Date().toISOString(), 1);
    db.prepare(
      "INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("agt_other", "node_unrelated", "usr_ayush", "prj_other", "other-agent", "developer", "idle");

    const view = buildView(db, new Positions(), "usr_ayush");
    const acmeApi = view.rooms.find((r) => r.id === "prj_acme_api")!;
    const other = view.rooms.find((r) => r.id === "prj_other")!;

    expect(acmeApi.machines.map((m) => m.id)).toEqual(["node_sams_mbp"]);
    expect(acmeApi.machines.map((m) => m.id)).not.toContain("node_unrelated");
    expect(other.machines.map((m) => m.id)).toEqual(["node_unrelated"]);
  });

  test("empty database yields a valid view with zero agents", () => {
    const db = openDb(":memory:");
    const view = buildView(db, new Positions(), "you");
    expect(view.seq).toBe(0);
    expect(view.rooms).toEqual([]);
  });

  test("every event lands in the log before anything else happens", () => {
    const db = openDb(":memory:");
    expect(appendEvent(db, "prj_x", null, "chat", { text: "hi" })).toBe(1);
    expect(appendEvent(db, "prj_x", "tsk_1", "task.status", {})).toBe(2);
  });

  // ---- the Kanban board's data (CONTRACT.md 1.8 — room.tasks) ----

  test("board tasks are scoped per room, newest first, with the agent's name joined in", () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
      "prj_other", "acme/other", "acme/other", "office"
    );

    const insTask = db.prepare(
      `INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state, cost_usd, created_at, started_at)
       VALUES (?, ?, ?, 'you', ?, ?, ?, ?, ?)`
    );
    insTask.run("tsk_old", "prj_acme_api", "older task", "agt_qa", "completed", 0.25, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");
    insTask.run("tsk_new", "prj_acme_api", "newer task", "agt_dev", "working", 0, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:01.000Z");
    insTask.run("tsk_unassigned", "prj_acme_api", "nobody's task", null, "submitted", 0, "2026-03-01T00:00:00.000Z", null);
    insTask.run("tsk_elsewhere", "prj_other", "different room", "agt_qa", "working", 0, "2026-07-01T00:00:00.000Z", null);

    const view = buildView(db, new Positions(), "usr_ayush");
    const acmeApi = view.rooms.find((r) => r.id === "prj_acme_api")!;
    const other = view.rooms.find((r) => r.id === "prj_other")!;

    // scoped to the room, never leaking another project's tasks
    expect(acmeApi.tasks.map((t) => t.id)).toEqual(["tsk_new", "tsk_unassigned", "tsk_old"]);
    expect(other.tasks.map((t) => t.id)).toEqual(["tsk_elsewhere"]);

    expect(acmeApi.tasks[0]).toMatchObject({
      id: "tsk_new", title: "newer task", state: "working",
      agentId: "agt_dev", agentName: "dev-api", costUsd: 0,
    });
    // an unassigned task is a real board row, not an error
    expect(acmeApi.tasks[1]).toMatchObject({
      id: "tsk_unassigned", agentId: null, agentName: null, startedAt: null,
    });
    expect(acmeApi.tasks[2]).toMatchObject({ id: "tsk_old", state: "completed", costUsd: 0.25 });
  });

  test("a task row predating the created_at column still yields a contract-valid view", () => {
    // db.ts's ALTER TABLE guard adds created_at to an existing db file, but
    // rows already in it have it NULL — the contract says createdAt is a
    // non-nullable string, so buildView has to fall back rather than emit null.
    const db = openDb(":memory:");
    seed(db);
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state, cost_usd, created_at, started_at)
       VALUES ('tsk_legacy', 'prj_acme_api', 'from before the column', 'you', 'agt_qa', 'completed', 0, NULL, NULL)`
    ).run();

    const view = buildView(db, new Positions(), "usr_ayush");
    const legacy = view.rooms[0].tasks.find((t) => t.id === "tsk_legacy")!;
    expect(typeof legacy.createdAt).toBe("string");
    expect(WorkspaceView.safeParse(view).success).toBe(true);
  });

  // The strongest assertion in this file: the *whole* view has to satisfy the
  // zod contract, not just the fields a given test happened to look at. This
  // is what actually catches "someone added a field to buildView and forgot
  // the schema" — gateway.ts refuses to broadcast a view that fails this.
  test("a fully populated view validates against the WorkspaceView contract", () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state, cost_usd, created_at, started_at)
       VALUES ('tsk_v', 'prj_acme_api', 'validate me', 'you', 'agt_qa', 'working', 1.5, ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString());
    const positions = new Positions();
    positions.set("usr_ayush", { roomId: "prj_acme_api", x: 3, y: 4 });

    const parsed = WorkspaceView.safeParse(buildView(db, positions, "usr_ayush"));
    if (!parsed.success) throw new Error(`view violated the contract: ${parsed.error}`);
    expect(parsed.success).toBe(true);
  });

  test("places agents in collaborating zone when hive meeting is active", () => {
    const db = openDb(":memory:");
    seed(db);

    const tmpRoot = mkdtempSync(join(tmpdir(), "view-hive-test-"));
    const hive = new HiveManager(tmpRoot);

    hive.registerAgent({ id: "agt_dev", name: "dev-api", role: "developer" });
    hive.registerAgent({ id: "agt_qa", name: "qa-api", role: "qa" });

    // Without meeting
    const viewBefore = buildView(db, new Positions(), "usr_ayush", hive);
    const qaBefore = viewBefore.rooms[0].agents.find((a) => a.id === "agt_qa");
    expect(qaBefore?.zone).toBe("working");

    // Call meeting
    hive.setMeeting("agt_dev", "agt_qa", 60000, "API Alignment");
    const viewAfter = buildView(db, new Positions(), "usr_ayush", hive);
    const devAfter = viewAfter.rooms[0].agents.find((a) => a.id === "agt_dev");
    const qaAfter = viewAfter.rooms[0].agents.find((a) => a.id === "agt_qa");

    expect(devAfter?.zone).toBe("collaborating");
    expect(devAfter?.waitingOn).toBe("qa-api");
    expect(qaAfter?.zone).toBe("collaborating");
    expect(qaAfter?.waitingOn).toBe("dev-api");
    expect(viewAfter.rooms[0].collaborationAvailable).toBe(true);

    hive.stopRouter();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });
});
