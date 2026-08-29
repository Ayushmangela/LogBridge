// Session storage and the gate that uses it.
//
// Before this, `/api/auth/login` generated a token with randomBytes and
// returned it — but nothing persisted it, nothing validated it, the browser
// never sent it, and `/api/auth/me` answered with whichever user happened to
// be first in the table. The login screen was decoration: every one of the
// ~125 API routes answered anyone who could reach the port.
//
// This is still not enrolment (D23). It authenticates a *browser session*
// against a password, which is what the login screen already implied it did.
// Machine identity remains trust-on-first-sight.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export interface SessionUser {
  id: string;
  name: string | null;
  email: string | null;
}

export function createSession(db: Db, userId: string): string {
  const token = randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)"
  ).run(token, userId, new Date().toISOString(), new Date().toISOString());
  return token;
}

/** The user behind a token, or null. Touches last_seen so an idle-session
 *  policy has something to work from later. */
export function userForToken(db: Db, token: string | null | undefined): SessionUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.gh_login FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token) as any;
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen = ? WHERE token = ?").run(new Date().toISOString(), token);
  return { id: row.id, name: row.name ?? null, email: row.email ?? row.gh_login ?? null };
}

export function destroySession(db: Db, token: string | null | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** `Authorization: Bearer <token>`, falling back to `?token=` so a WebSocket
 *  — which cannot set headers from the browser — can authenticate too. */
export function tokenFromRequest(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  const q = (req.query as any)?.token;
  return typeof q === "string" && q ? q : null;
}

/** Paths that must answer before anyone can possibly have a session. */
const PUBLIC_PREFIXES = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/demo",
  "/healthz",
];

// Sockets a browser opens. `/ws` carries the entire workspace view — every
// project, agent, task and memory — so leaving it open made the API gate
// mostly decorative. `/pty-ws` spawns a shell.
//
// `/node-ws` is deliberately NOT here: that is the runner's connection and it
// authenticates with its own Ed25519 signed challenge (D23 TOFU). Putting a
// user session in front of it would lock every runner out.
const PROTECTED_SOCKETS = ["/ws", "/pty-ws"];

function isPublic(url: string): boolean {
  const path = url.split("?")[0];
  if (PROTECTED_SOCKETS.includes(path)) return false;
  if (!path.startsWith("/api/")) return true;   // static files, the office itself
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

/**
 * Require a session for every /api/ route except the handful above.
 *
 * Registered from `main()` only. Under vitest it is off, because 21 existing
 * test files call these routes directly and rewriting them all would be a far
 * larger change than the hole is worth — see sessions.test.ts, which turns it
 * ON explicitly and tests the gate itself.
 */
export function registerAuthGate(app: FastifyInstance, db: Db): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (isPublic(req.url)) return;
    const user = userForToken(db, tokenFromRequest(req));
    if (!user) {
      return reply.code(401).send({ ok: false, error: "authentication required" });
    }
    (req as any).user = user;
  });
}
