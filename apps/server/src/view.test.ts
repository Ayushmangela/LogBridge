import { describe, expect, test } from "vitest";
import type { WorkspaceViewT } from "@logbridge/protocol";
import { appendEvent, openDb, type Db } from "./db.js";
import { Positions, buildView } from "./view.js";

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
});
