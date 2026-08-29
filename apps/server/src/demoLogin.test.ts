import { afterEach, describe, expect, test } from "vitest";
import { buildServer, type BuiltServer } from "./index.js";

let server: BuiltServer | null = null;
afterEach(async () => {
  await server?.app.close();
  server = null;
});

/**
 * Reproduces a live 500: an install that predates the login rewrite has a
 * "usr_demo" row left by the old fake-login code, with no email set.
 * `/api/auth/demo` looked the user up by email only, found nothing,
 * `INSERT OR IGNORE` silently no-op'd on the id collision, and `user.id`
 * crashed on undefined — a 500 on every click of the demo-login button,
 * fixable previously only by hand-editing the database.
 */
describe("demo login survives a pre-existing usr_demo row", () => {
  test("a stale usr_demo row with no email is backfilled, not fatal", async () => {
    server = await buildServer({ dbPath: ":memory:" });
    server.db.prepare(
      "INSERT INTO users (id, gh_login, name, avatar, email, created_at) VALUES ('usr_demo','demo','Ayush',0,NULL,?)"
    ).run(new Date().toISOString());

    const res = await server.app.inject({ method: "POST", url: "/api/auth/demo" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.id).toBe("usr_demo");
    expect(body.user.email).toBe("demo@logbridge.local");
    expect(typeof body.token).toBe("string");

    const row = server.db.prepare("SELECT email FROM users WHERE id = 'usr_demo'").get() as any;
    expect(row.email).toBe("demo@logbridge.local");
  });

  test("a fresh install with no usr_demo row still works", async () => {
    server = await buildServer({ dbPath: ":memory:" });
    const res = await server.app.inject({ method: "POST", url: "/api/auth/demo" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe("usr_demo");
  });

  test("calling it twice returns the same user and joins new projects added since", async () => {
    server = await buildServer({ dbPath: ":memory:" });
    await server.app.inject({ method: "POST", url: "/api/auth/demo" });

    server.db.prepare("INSERT INTO projects (id, name, gh_repo) VALUES ('prj_late', 'Late', 'o/late')").run();

    const res2 = await server.app.inject({ method: "POST", url: "/api/auth/demo" });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().user.id).toBe("usr_demo");

    const member = server.db
      .prepare("SELECT 1 FROM project_members WHERE project_id = 'prj_late' AND user_id = 'usr_demo'")
      .get();
    expect(member).toBeTruthy();
  });
});
