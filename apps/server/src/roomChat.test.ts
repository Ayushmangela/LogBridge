import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";
import { Positions, buildView } from "./view.js";

describe("Room Chat & Auto-Project Membership Suite", () => {
  test("signup automatically adds user to existing projects in project_members", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    // Seed a project
    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_test", "Test Workspace", "org/test"
    );

    // Register user 1
    const res1 = await server.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ayush",
        email: "ayush@test.com",
        password: "password123",
      }),
    });
    expect(res1.statusCode).toBe(200);
    const u1 = JSON.parse(res1.body).user;

    // Check project_members has this user
    const memberRow = server.db.prepare(
      "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?"
    ).get("prj_test", u1.id) as any;
    expect(memberRow).toBeDefined();
    expect(memberRow.user_id).toBe(u1.id);
  });

  test("positions tracks multiple distinct users and surfaces them in room.humans", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES (?, ?, ?)").run(
      "prj_test", "Test Workspace", "org/test"
    );
    server.db.prepare("INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)").run(
      "usr_alice", "Alice", 1
    );
    server.db.prepare("INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)").run(
      "usr_bob", "Bob", 2
    );

    const positions = new Positions();
    // Alice is in boss cabin (x: 48, y: 6)
    positions.set("usr_alice", { roomId: "prj_test", x: 48, y: 6 });
    // Bob is in meeting room (x: 48, y: 22)
    positions.set("usr_bob", { roomId: "prj_test", x: 48, y: 22 });

    const view = buildView(server.db, positions, "usr_alice");
    const room = view.rooms.find((r) => r.id === "prj_test")!;
    expect(room).toBeDefined();

    const aliceHuman = room.humans.find((h) => h.id === "usr_alice")!;
    const bobHuman = room.humans.find((h) => h.id === "usr_bob")!;

    expect(aliceHuman).toBeDefined();
    expect(aliceHuman.presence).toBe("online");
    expect(aliceHuman.position).toEqual({ x: 48, y: 6 });

    expect(bobHuman).toBeDefined();
    expect(bobHuman.presence).toBe("online");
    expect(bobHuman.position).toEqual({ x: 48, y: 22 });
  });
});
