// Cross-machine delegation, review and context sharing are inert unless a
// SECOND PERSON has a machine online. The office shouldn't advertise a
// meeting room nobody can enter, so the view says whether collaboration is
// actually possible and the UI follows it.
//
// The subtlety worth pinning: two machines owned by one person is not
// collaboration. A soak rig or a laptop plus a desktop must not flip this on.
import { describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { Positions, buildView } from "./view.js";

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_a", "a/a", "a/a", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES ('usr_ayush','ayush','ayush',0)").run();
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES ('usr_sam','sam','sam',1)").run();
}

function addMachine(db: Db, id: string, owner: string, online: number) {
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)")
    .run(id, owner, id, new Date().toISOString(), online);
  // A machine only appears in a room if it runs an agent there.
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
     VALUES (?,?,?,'prj_a',?,'developer','[]',1,'idle')`
  ).run(`agt_${id}`, id, owner, `dev-${id}`);
}

const available = (db: Db) => buildView(db, new Positions(), "usr_ayush").rooms[0].collaborationAvailable;

describe("collaboration availability", () => {
  test("alone with one machine: off", () => {
    const db = openDb(":memory:");
    seed(db);
    addMachine(db, "laptop", "usr_ayush", 1);
    expect(available(db)).toBe(false);
  });

  test("TWO machines, SAME owner: still off", () => {
    // The case that would otherwise produce a false positive — a soak rig, or
    // one person's laptop and desktop. You cannot collaborate with yourself.
    const db = openDb(":memory:");
    seed(db);
    addMachine(db, "laptop", "usr_ayush", 1);
    addMachine(db, "desktop", "usr_ayush", 1);
    expect(available(db)).toBe(false);
  });

  test("two machines, DIFFERENT owners, both online: on", () => {
    const db = openDb(":memory:");
    seed(db);
    addMachine(db, "laptop", "usr_ayush", 1);
    addMachine(db, "sams-mbp", "usr_sam", 1);
    expect(available(db)).toBe(true);
  });

  test("the second person going offline turns it back off", () => {
    const db = openDb(":memory:");
    seed(db);
    addMachine(db, "laptop", "usr_ayush", 1);
    addMachine(db, "sams-mbp", "usr_sam", 1);
    expect(available(db)).toBe(true);

    db.prepare("UPDATE machines SET online = 0 WHERE id = 'sams-mbp'").run();
    expect(available(db), "an offline machine cannot take delegated work").toBe(false);
  });

  test("an offline second owner never counts", () => {
    const db = openDb(":memory:");
    seed(db);
    addMachine(db, "laptop", "usr_ayush", 1);
    addMachine(db, "sams-mbp", "usr_sam", 0);
    expect(available(db)).toBe(false);
  });

  test("it is per-room: another project's people don't unlock this one", () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES ('prj_b','b/b','b/b','office')").run();
    addMachine(db, "laptop", "usr_ayush", 1);
    // Sam is online, but only in the other room.
    db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES ('sams','usr_sam','sams',?,1)")
      .run(new Date().toISOString());
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
       VALUES ('agt_sams','sams','usr_sam','prj_b','dev-sam','developer','[]',1,'idle')`
    ).run();

    const view = buildView(db, new Positions(), "usr_ayush");
    expect(view.rooms.find((r) => r.id === "prj_a")!.collaborationAvailable).toBe(false);
  });
});
