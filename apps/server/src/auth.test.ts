import { describe, expect, test } from "vitest";
import { buildServer } from "./index.js";

describe("Authentication Suite (Signup, Login, Sessions)", () => {
  test("POST /api/auth/signup creates account with hashed password and returns session token", async () => {
    const server = await buildServer({ dbPath: ":memory:" });

    // 1. Sign up with new user
    const res1 = await server.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ayush Mangela",
        email: "ayush@example.com",
        password: "supersecretpass",
      }),
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.ok).toBe(true);
    expect(body1.user.name).toBe("Ayush Mangela");
    expect(body1.user.email).toBe("ayush@example.com");
    expect(typeof body1.token).toBe("string");

    // Verify password is NOT stored as plaintext in DB
    const dbUser = server.db.prepare("SELECT * FROM users WHERE id = ?").get(body1.user.id) as any;
    expect(dbUser.password_hash).not.toBe("supersecretpass");
    expect(dbUser.password_hash).toContain(":");

    // 2. Reject duplicate email/username
    const res2 = await server.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Another User",
        email: "ayush@example.com",
        password: "anotherpass123",
      }),
    });
    expect(res2.statusCode).toBe(400);

    // 3. Successful login
    const res3 = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "ayush@example.com",
        password: "supersecretpass",
      }),
    });
    expect(res3.statusCode).toBe(200);
    const body3 = JSON.parse(res3.body);
    expect(body3.ok).toBe(true);
    expect(body3.user.email).toBe("ayush@example.com");
    expect(typeof body3.token).toBe("string");

    // 4. Reject invalid password
    const res4 = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "ayush@example.com",
        password: "wrongpassword",
      }),
    });
    expect(res4.statusCode).toBe(401);
  });
});
