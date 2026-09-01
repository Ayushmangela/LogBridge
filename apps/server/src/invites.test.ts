// Invites, and the view scoping they exist to make possible.
//
// The bug: `/api/auth/signup` joined every new account to EVERY project by
// running `SELECT id FROM projects`, and `buildView` selected all projects
// regardless of who asked. So anyone reaching the sign-up form got every
// floor, every agent and every live terminal. Harmless on localhost, an open
// door the moment the server is reachable by the friend it is meant for.
import { describe, expect, test } from "vitest";
import { openDb, setProjectMember, type Db } from "./db.js";
import { buildView, Positions } from "./view.js";
import {
  createInvite, redeemInvite, revokeInvite, inviteProblem,
  generateInviteCode, normalizeCode, listInvites,
} from "./invites.js";

function seed(db: Db) {
  for (const [id, name] of [["prj_a", "Alpha"], ["prj_b", "Beta"]] as const) {
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `x/${id}`, name, "office");
  }
  for (const [id, name] of [["usr_owner", "Owner"], ["usr_friend", "Friend"], ["usr_stranger", "Stranger"]] as const) {
    db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(id, name, name, 0);
  }
  setProjectMember(db, "prj_a", "usr_owner", "owner");
  setProjectMember(db, "prj_b", "usr_owner", "owner");
  return db;
}

const roomsFor = (db: Db, userId: string) =>
  buildView(db, new Positions(), userId).rooms.map((r) => r.id).sort();

describe("the workspace view is scoped to your memberships", () => {
  test("a member sees only the projects they belong to", () => {
    const db = seed(openDb(":memory:"));
    setProjectMember(db, "prj_a", "usr_friend", "member");
    expect(roomsFor(db, "usr_friend")).toEqual(["prj_a"]);
    expect(roomsFor(db, "usr_owner")).toEqual(["prj_a", "prj_b"]);
    db.close();
  });

  test("a signed-in stranger with no membership sees NOTHING", () => {
    // The whole point. Before scoping this returned every project.
    const db = seed(openDb(":memory:"));
    expect(roomsFor(db, "usr_stranger")).toEqual([]);
    db.close();
  });

  test("a database with no memberships at all still shows its projects", () => {
    // An install predating memberships must not lock its owner out. Once ANY
    // membership row exists the filter is live — this is only the empty case.
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_old", "x/old", "Old", "office");
    db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_old", "o", "O", 0);
    expect(roomsFor(db, "usr_old")).toEqual(["prj_old"]);
    db.close();
  });
});

describe("invite codes", () => {
  test("a code is transcribable — no vowels, no 0/O/1/I/l", () => {
    for (let i = 0; i < 40; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code).not.toMatch(/[AEIOU01IL]/);
    }
  });

  test("two codes are never the same", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateInviteCode()));
    expect(seen.size).toBe(200);
  });

  test("redeeming grants membership, and only to that project", () => {
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a", createdBy: "usr_owner" });
    expect(redeemInvite(db, inv.code, "usr_friend")).toMatchObject({ ok: true, projectId: "prj_a" });
    expect(roomsFor(db, "usr_friend")).toEqual(["prj_a"]);
    db.close();
  });

  test("the person's typing is forgiven — case and dashes do not matter", () => {
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a" });
    const mangled = inv.code.toLowerCase().replace(/-/g, " ");
    expect(redeemInvite(db, mangled, "usr_friend").ok).toBe(true);
    expect(normalizeCode(" k7qf-3mtb ")).toBe("K7QF3MTB");
    db.close();
  });

  test("single use by default — a second person cannot reuse it", () => {
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a" });
    expect(redeemInvite(db, inv.code, "usr_friend").ok).toBe(true);
    const second = redeemInvite(db, inv.code, "usr_stranger");
    expect(second).toMatchObject({ ok: false, reason: "exhausted" });
    expect(roomsFor(db, "usr_stranger")).toEqual([]);
    db.close();
  });

  test("redeeming twice yourself is not an error and does not burn the use", () => {
    // A double-clicked button must not lock someone out of the floor they
    // were just invited to.
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a", maxUses: 2 });
    expect(redeemInvite(db, inv.code, "usr_friend").ok).toBe(true);
    expect(redeemInvite(db, inv.code, "usr_friend").ok).toBe(true);
    expect(listInvites(db, "prj_a")[0].uses).toBe(1);
    db.close();
  });

  test("maxUses lets one code seed a group, then stops", () => {
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a", maxUses: 2 });
    expect(redeemInvite(db, inv.code, "usr_friend").ok).toBe(true);
    expect(redeemInvite(db, inv.code, "usr_stranger").ok).toBe(true);
    db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_d", "d", "D", 0);
    expect(redeemInvite(db, inv.code, "usr_d")).toMatchObject({ ok: false, reason: "exhausted" });
    db.close();
  });

  test("maxUses cannot be made unlimited", () => {
    const db = seed(openDb(":memory:"));
    expect(createInvite(db, { projectId: "prj_a", maxUses: 1e9 }).maxUses).toBe(50);
    expect(createInvite(db, { projectId: "prj_a", maxUses: -3 }).maxUses).toBe(1);
    db.close();
  });

  test("revoked and expired codes are refused, with the right reason", () => {
    const db = seed(openDb(":memory:"));
    const revoked = createInvite(db, { projectId: "prj_a" });
    revokeInvite(db, revoked.code);
    expect(redeemInvite(db, revoked.code, "usr_friend")).toMatchObject({ ok: false, reason: "revoked" });

    const expired = createInvite(db, { projectId: "prj_a", ttlHours: -1 });
    expect(inviteProblem(db, expired.code)).toBe("expired");

    expect(redeemInvite(db, "ZZZZ-ZZZZ-ZZZZ", "usr_friend")).toMatchObject({ ok: false, reason: "not_found" });
    expect(roomsFor(db, "usr_friend")).toEqual([]);
    db.close();
  });

  test("a revoked code that also expired reports revoked", () => {
    // The fact the person who revoked it wants to see.
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a", ttlHours: -1 });
    revokeInvite(db, inv.code);
    expect(inviteProblem(db, inv.code)).toBe("revoked");
    db.close();
  });

  test("an invite for a deleted project cannot resurrect access", () => {
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a" });
    db.prepare("DELETE FROM projects WHERE id = ?").run("prj_a");
    expect(redeemInvite(db, inv.code, "usr_friend")).toMatchObject({ ok: false, reason: "no_such_project" });
    db.close();
  });

  test("an admin invite grants admin, so a friend can invite onward", () => {
    const db = seed(openDb(":memory:"));
    const inv = createInvite(db, { projectId: "prj_a", role: "admin" });
    expect(redeemInvite(db, inv.code, "usr_friend")).toMatchObject({ ok: true, role: "admin" });
    db.close();
  });
});
