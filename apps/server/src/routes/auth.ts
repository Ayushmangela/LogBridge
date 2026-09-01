import type { FastifyInstance } from "fastify";
import { randomBytes, scryptSync } from "node:crypto";
import type { RouteDeps } from "./types.js";
import { createSession, destroySession, tokenFromRequest, userForToken } from "../sessions.js";
import { redeemInvite, REDEEM_MESSAGES } from "../invites.js";
import { setProjectMember } from "../db.js";

/** ::1, 127.0.0.0/8, and the IPv4-mapped form Node reports on a dual-stack
 *  socket (::ffff:127.0.0.1). Anything else is another machine. */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const a = ip.replace(/^::ffff:/, "");
  return a === "::1" || a === "localhost" || /^127\./.test(a);
}

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db } = deps;

  app.post("/api/auth/signup", async (req, reply) => {
    const body = req.body as any;
    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    const inviteCode = String(body?.inviteCode || "").trim();

    if (!name) return reply.code(400).send({ error: "Name is required" });
    if (!email) return reply.code(400).send({ error: "Email or username is required" });
    if (password.length < 6) return reply.code(400).send({ error: "Password must be at least 6 characters" });

    const existing = db.prepare("SELECT id FROM users WHERE email = ? OR gh_login = ? OR name = ?").get(email, email, name);
    if (existing) {
      return reply.code(400).send({ error: "An account with that email or name already exists" });
    }

    // Read BEFORE the insert below, or the account being created counts
    // itself and no one is ever the first user.
    const isFirstUser = !db.prepare("SELECT 1 FROM users LIMIT 1").get();

    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    const password_hash = `${salt}:${hash}`;
    const userId = "usr_" + randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, gh_login, name, avatar, email, password_hash, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(userId, email, name, email, password_hash, createdAt);

    // Membership, deliberately narrow.
    //
    // This used to be `SELECT id FROM projects` followed by a membership row
    // for every one of them — so signing up granted the whole workspace. That
    // was the ONLY onboarding path, which is why it existed, and it is exactly
    // what makes exposing the server unsafe. A new account now gets in through
    // an invite and reaches nothing else.
    let joinedProject: string | null = null;
    let joinNote: string | null = null;
    try {
      if (isFirstUser) {
        // Bootstrap: whoever creates the first account owns what is already
        // here. Without this the person who ran the server has no membership,
        // cannot see their own floors, and cannot issue the first invite —
        // locked out of their own machine by a security fix.
        for (const p of db.prepare("SELECT id FROM projects").all() as any[]) {
          setProjectMember(db, p.id, userId, "owner");
          joinedProject = joinedProject ?? p.id;
        }
      } else if (inviteCode) {
        const result = redeemInvite(db, inviteCode, userId);
        if (result.ok) joinedProject = result.projectId;
        else joinNote = REDEEM_MESSAGES[result.reason];
      } else {
        joinNote = "Your account is ready. Ask a teammate for an invite code to join their workspace.";
      }
    } catch {}

    // Persisted, so the token actually means something on the next request.
    const token = createSession(db, userId);
    return {
      ok: true,
      user: {
        id: userId,
        name,
        email,
      },
      // So the browser can say what happened rather than showing an empty
      // workspace with no explanation.
      joinedProject,
      note: joinNote,
      token,
    };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = req.body as any;
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!email || !password) {
      return reply.code(400).send({ error: "Email/Username and password are required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ? OR gh_login = ? OR name = ?").get(email, email, email) as any;
    if (!user || !user.password_hash) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const [salt, storedHash] = String(user.password_hash).split(":");
    if (!salt || !storedHash) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const hash = scryptSync(password, salt, 64).toString("hex");
    if (hash !== storedHash) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = createSession(db, user.id);
    return {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email || user.gh_login || user.name,
      },
      token,
    };
  });

  // Was: "SELECT ... FROM users ORDER BY rowid LIMIT 1" — it answered with
  // whichever user was created first, whoever asked. That is not identity.
  // The "one-click demo access" button used to fake a user in localStorage
  // with no server call at all. That was harmless while nothing checked, but
  // once sessions were enforced it left the UI believing it was signed in
  // while every API call returned 401 — a blank, broken office.
  //
  // Exposure note: this mints a real session for anyone who can reach it. That
  // is no wider than `/api/auth/signup`, which is also public and grants the
  // whole workspace (D29) — but both must go before this server is reachable
  // by anyone outside the trusted group. See SECURITY-REVIEW.md.
  app.post("/api/auth/demo", async (req, reply) => {
    // Loopback only. This mints a real session for anyone who asks and joins
    // it to every project — which is precisely the hole the invite flow was
    // built to close, so leaving it reachable off-machine would undo that fix
    // with one button. On the developer's own laptop it stays a single click.
    if (!isLoopback(req.ip)) {
      return reply.code(403).send({
        error: "Demo access only works on the machine running the server. Sign in, or ask for an invite code.",
      });
    }
    const email = "demo@logbridge.local";
    const id = "usr_demo";
    // Look up by id, not just email: an install that predates the login
    // rewrite can have a "usr_demo" row left over from the old fake-login
    // code, with no email set. INSERT OR IGNORE then silently no-ops on the
    // id collision, the email lookup finds nothing, and `user` stays
    // undefined all the way to `user.id` — a 500 on every demo-login click
    // until someone edits the database by hand.
    let user = db.prepare("SELECT id, name, email FROM users WHERE id = ? OR email = ?").get(id, email) as any;
    if (!user) {
      db.prepare(
        "INSERT INTO users (id, gh_login, name, avatar, email, created_at) VALUES (?,?,?,?,?,?)"
      ).run(id, "demo", "Demo User", 0, email, new Date().toISOString());
      user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id);
    } else if (user.email !== email) {
      db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, user.id);
      user.email = email;
    }
    // Joins every project, every call — a project added since the demo user
    // was created should still be visible. Safe only because the route is
    // loopback-gated above; that gate is what this line depends on.
    // setProjectMember, not INSERT OR IGNORE: the demo account may already
    // hold a stale 'member' row from before this granted owner, and IGNORE
    // would leave it there — leaving the developer unable to issue an invite
    // on their own machine.
    for (const p of db.prepare("SELECT id FROM projects").all() as any[]) {
      setProjectMember(db, p.id, user.id, "owner");
    }
    return { ok: true, user, token: createSession(db, user.id) };
  });

  app.get("/api/auth/me", async (req) => {
    const user = userForToken(db, tokenFromRequest(req));
    return { user: user ?? null };
  });

  app.post("/api/auth/logout", async (req) => {
    destroySession(db, tokenFromRequest(req));
    return { ok: true };
  });
}
