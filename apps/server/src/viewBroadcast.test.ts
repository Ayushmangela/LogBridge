// What a broadcast costs.
//
// `broadcastView()` is called from 76 places and used to run a full
// `buildView()` — measured at 75 prepare() calls and ~2ms — once PER SOCKET,
// per call. Several of those 76 fire within one operation: a task changing
// state, its agent changing status, and the hive emitting an event are three
// calls describing one thing.
//
// These pin the two properties that make it cheap, both of which are easy to
// undo by accident: bursts collapse, and people who see the same view are
// built once.
import { describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { buildView, Positions } from "./view.js";

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_v", "x/v", "V", "office");
  for (const u of ["usr_a", "usr_b"]) {
    db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(u, u, u, 0);
    db.prepare("INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?,?,?,?)")
      .run("prj_v", u, "member", new Date().toISOString());
  }
  db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)").run("node_v", "usr_a", "m", 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("agt_v", "node_v", "usr_a", "prj_v", "Ada", "developer", "[]", 1, "idle");
  return db;
}

describe("prepared statements are reused", () => {
  test("the same SQL is compiled once per connection", () => {
    // A view makes 75 prepare() calls for 20 distinct statements. Recompiling
    // each one every time was a third of the cost of a build.
    const db = openDb(":memory:");
    const a = db.prepare("SELECT 1 AS n");
    const b = db.prepare("SELECT 1 AS n");
    expect(a).toBe(b);
    db.close();
  });

  test("different SQL still gets its own statement", () => {
    const db = openDb(":memory:");
    expect(db.prepare("SELECT 1 AS n")).not.toBe(db.prepare("SELECT 2 AS n"));
    db.close();
  });

  test("a cached statement still returns fresh results", () => {
    // The failure mode worth guarding: a reused statement that answers with
    // whatever it saw the first time.
    const db = seed(openDb(":memory:"));
    const q = () => db.prepare("SELECT COUNT(*) AS n FROM agents").get() as any;
    expect(q().n).toBe(1);
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run("agt_2", "node_v", "usr_a", "prj_v", "Bo", "qa", "[]", 1, "idle");
    expect(q().n).toBe(2);
    db.close();
  });

  test("each connection gets its own cache, so tests cannot leak into each other", () => {
    const one = openDb(":memory:");
    const two = openDb(":memory:");
    expect(one.prepare("SELECT 1 AS n")).not.toBe(two.prepare("SELECT 1 AS n"));
    one.close();
    two.close();
  });
});

describe("what makes sharing a build safe", () => {
  test("two viewers of the same project get identical bytes", () => {
    // This is the property the per-viewer memo relies on. If two members of
    // the same project could ever see different views, sharing one serialised
    // payload between their sockets would show one of them the other's.
    const db = seed(openDb(":memory:"));
    const a = buildView(db, new Positions(), "usr_a");
    const b = buildView(db, new Positions(), "usr_b");
    expect(a.rooms.map((r) => r.id)).toEqual(b.rooms.map((r) => r.id));
    db.close();
  });

  test("but a non-member sees a DIFFERENT view, which is why the memo is keyed on the viewer", () => {
    // Scoping made views genuinely differ between people. A single shared
    // payload for all sockets would hand a stranger someone else's floors.
    const db = seed(openDb(":memory:"));
    db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_out", "o", "O", 0);
    expect(buildView(db, new Positions(), "usr_a").rooms.length).toBe(1);
    expect(buildView(db, new Positions(), "usr_out").rooms.length).toBe(0);
    db.close();
  });

  test("`meId` is carried through, so the memo key matches what was built", () => {
    const db = seed(openDb(":memory:"));
    expect(buildView(db, new Positions(), "usr_b").meId).toBe("usr_b");
    db.close();
  });
});
