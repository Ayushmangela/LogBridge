// The gate that makes the login screen mean something.
//
// Before this, `/api/auth/login` minted a token with randomBytes and returned
// it; nothing persisted it, nothing checked it, and the browser never sent it.
// A sign-in page sat in front of ~125 routes that answered anyone who could
// reach the port — worse than no login, because it looked like protection.
//
// The gate is off under vitest so the 21 existing route test files keep
// working. These tests turn it ON explicitly, which is the only place the
// enforcement path is exercised — so they carry the whole weight of it.
import { afterEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "./index.js";
import { registerAuthGate, createSession, userForToken, destroySession } from "./sessions.js";
import WebSocket from "ws";

let server: BuiltServer | null = null;
// Sockets opened by tryOpen keep the server alive during close(), so they are
// terminated rather than politely closed, and teardown gets room to finish.
const openSockets: WebSocket[] = [];
afterEach(async () => {
  for (const w of openSockets.splice(0)) { try { w.terminate(); } catch {} }
  await server?.app.close();
  server = null;
}, 20_000);

/** A server with the gate registered, as `main()` does in production. */
async function gatedServer() {
  const s = await buildServer({ dbPath: ":memory:" });
  registerAuthGate(s.app, s.db);
  await s.app.listen({ port: 0, host: "127.0.0.1" });
  server = s;
  const base = `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`;
  return { s, base };
}

describe("session storage", () => {
  test("a token round-trips to its user, and only its user", async () => {
    const { s } = await gatedServer();
    s.db.prepare("INSERT INTO users (id, name, email) VALUES ('usr_a','A','a@x')").run();
    s.db.prepare("INSERT INTO users (id, name, email) VALUES ('usr_b','B','b@x')").run();

    const tokenA = createSession(s.db, "usr_a");
    const tokenB = createSession(s.db, "usr_b");
    expect(userForToken(s.db, tokenA)?.id).toBe("usr_a");
    expect(userForToken(s.db, tokenB)?.id).toBe("usr_b");
    // This is the bug /api/auth/me had: it answered with the first user in
    // the table no matter who asked.
    expect(userForToken(s.db, tokenA)?.id).not.toBe("usr_b");
  });

  test("an unknown or missing token is nobody", async () => {
    const { s } = await gatedServer();
    expect(userForToken(s.db, "not-a-real-token")).toBeNull();
    expect(userForToken(s.db, null)).toBeNull();
    expect(userForToken(s.db, "")).toBeNull();
  });

  test("logging out actually invalidates the token", async () => {
    const { s } = await gatedServer();
    s.db.prepare("INSERT INTO users (id, name, email) VALUES ('usr_a','A','a@x')").run();
    const token = createSession(s.db, "usr_a");
    expect(userForToken(s.db, token)).not.toBeNull();
    destroySession(s.db, token);
    expect(userForToken(s.db, token)).toBeNull();
  });
});

describe("the gate", () => {
  test("an unauthenticated API call is refused", async () => {
    const { base } = await gatedServer();
    const r = await fetch(`${base}/api/projects`);
    expect(r.status, "/api/projects answered 200 to anyone before this").toBe(401);
  });

  test("a valid token gets through", async () => {
    const { s, base } = await gatedServer();
    s.db.prepare("INSERT INTO users (id, name, email) VALUES ('usr_a','A','a@x')").run();
    const token = createSession(s.db, "usr_a");
    const r = await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
  });

  test("a token in the query string works too — websockets cannot set headers", async () => {
    const { s, base } = await gatedServer();
    s.db.prepare("INSERT INTO users (id, name, email) VALUES ('usr_a','A','a@x')").run();
    const token = createSession(s.db, "usr_a");
    const r = await fetch(`${base}/api/projects?token=${token}`);
    expect(r.status).toBe(200);
  });

  test("a forged token is refused", async () => {
    const { base } = await gatedServer();
    const r = await fetch(`${base}/api/projects`, { headers: { Authorization: "Bearer deadbeef" } });
    expect(r.status).toBe(401);
  });

  test("login and signup stay reachable, or nobody could ever authenticate", async () => {
    const { base } = await gatedServer();
    // 400 for a bad body is fine — the point is it is not 401.
    const r = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(r.status).not.toBe(401);
  });

  test("the office itself still loads unauthenticated, so the login screen can render", async () => {
    const { base } = await gatedServer();
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/js/app.js`)).status).toBe(200);
  });
});

describe("signing in end to end", () => {
  test("signup returns a token that then opens a protected route", async () => {
    const { base } = await gatedServer();
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ayush", email: "a@example.com", password: "hunter22" }),
    });
    expect(signup.status).toBe(200);
    const { token } = (await signup.json()) as any;
    expect(typeof token).toBe("string");

    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await me.json()) as any;
    expect(body.user?.email).toBe("a@example.com");

    const guarded = await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
    expect(guarded.status).toBe(200);
  });
});

describe("browser sockets are gated too", () => {
  /** Resolve to "open" or "refused" — a real upgrade, since Node's fetch
   *  refuses to send Upgrade headers itself. */
  function tryOpen(url: string): Promise<"open" | "refused"> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      openSockets.push(ws);
      const done = (r: "open" | "refused") => { try { ws.terminate(); } catch {} resolve(r); };
      ws.on("open", () => done("open"));
      ws.on("error", () => done("refused"));
      ws.on("unexpected-response", () => done("refused"));
      setTimeout(() => done("refused"), 3000);
    });
  }

  test("/ws refuses a forged token — it carries the whole workspace", async () => {
    const { base } = await gatedServer();
    const url = base.replace("http://", "ws://");
    expect(await tryOpen(`${url}/ws?token=forged`),
      "/ws streamed every project, agent and task to anyone").toBe("refused");
  });

  test("/ws opens with a real session", async () => {
    const { s, base } = await gatedServer();
    s.db.prepare("INSERT INTO users (id, name, email) VALUES ('usr_a','A','a@x')").run();
    const token = createSession(s.db, "usr_a");
    const url = base.replace("http://", "ws://");
    expect(await tryOpen(`${url}/ws?token=${token}`)).toBe("open");
  });

  test("/pty-ws refuses a forged token — it spawns a shell", async () => {
    const { base } = await gatedServer();
    const url = base.replace("http://", "ws://");
    expect(await tryOpen(`${url}/pty-ws?token=forged`)).toBe("refused");
  });

  test("/node-ws is NOT session-gated — runners use Ed25519, not a login", async () => {
    // Gating this would lock every machine out of the office.
    const { base } = await gatedServer();
    const url = base.replace("http://", "ws://");
    expect(await tryOpen(`${url}/node-ws`)).toBe("open");
  });
});
