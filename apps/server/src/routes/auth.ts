import type { FastifyInstance } from "fastify";
import { randomBytes, scryptSync } from "node:crypto";
import type { RouteDeps } from "./types.js";

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db } = deps;

  app.post("/api/auth/signup", async (req, reply) => {
    const body = req.body as any;
    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!name) return reply.code(400).send({ error: "Name is required" });
    if (!email) return reply.code(400).send({ error: "Email or username is required" });
    if (password.length < 6) return reply.code(400).send({ error: "Password must be at least 6 characters" });

    const existing = db.prepare("SELECT id FROM users WHERE email = ? OR gh_login = ? OR name = ?").get(email, email, name);
    if (existing) {
      return reply.code(400).send({ error: "An account with that email or name already exists" });
    }

    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    const password_hash = `${salt}:${hash}`;
    const userId = "usr_" + randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, gh_login, name, avatar, email, password_hash, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(userId, email, name, email, password_hash, createdAt);

    try {
      const allProjects = db.prepare("SELECT id FROM projects").all() as any[];
      for (const p of allProjects) {
        db.prepare(`
          INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
          VALUES (?, ?, 'member', ?)
        `).run(p.id, userId, createdAt);
      }
    } catch {}

    const token = randomBytes(24).toString("hex");
    return {
      ok: true,
      user: {
        id: userId,
        name,
        email,
      },
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

    const token = randomBytes(24).toString("hex");
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

  app.get("/api/auth/me", async () => {
    const user = db.prepare("SELECT id, name, email, gh_login FROM users ORDER BY rowid LIMIT 1").get() as any;
    if (!user) return { user: null };
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email || user.gh_login,
      }
    };
  });
}
