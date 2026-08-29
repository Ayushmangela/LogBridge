import type { FastifyInstance } from "fastify";
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, join } from "node:path";
import {
  setAgentPaused, setAgentRetired, deleteAgent,
  setAgentSteer, getAgentHistory, moveAgent, cloneAgent,
  getAgentTraces, getAgentOutput, appendEvent, getAgentMetrics
} from "../db.js";
import { requestAgentGit, requestAgentCreate } from "../nodeGateway.js";
import { spawnOrGetPtySession } from "../ptyGateway.js";
import { registerAgentInProjectHive } from "../hive.js";
import type { RouteDeps } from "./types.js";

export function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, nodeSockets, broadcastView, hive } = deps;

  const handleAgentEdit = async (agentId: string, body: any, reply: any) => {
    if (!agentId) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const updates: string[] = [];
    const vals: any[] = [];
    if (body.name !== undefined) {
      updates.push("name = ?");
      vals.push(String(body.name).trim().slice(0, 200));
    }
    if (body.description !== undefined) {
      updates.push("description = ?");
      vals.push(body.description ? String(body.description).trim().slice(0, 120) : null);
    }
    if (body.goal !== undefined) {
      updates.push("goal = ?");
      vals.push(body.goal ? String(body.goal).trim().slice(0, 2000) : null);
    }
    if (body.character !== undefined) {
      updates.push("character = ?");
      vals.push(body.character ?? null);
    }
    if (body.color !== undefined) {
      updates.push("color = ?");
      vals.push(body.color ?? null);
    }
    if (body.role !== undefined) {
      updates.push("role = ?");
      vals.push(body.role ?? "developer");
    }
    if (body.note !== undefined) {
      updates.push("note = ?");
      vals.push(body.note ? String(body.note).trim().slice(0, 120) : null);
    }
    if (body.capabilities !== undefined) {
      updates.push("capabilities = ?");
      vals.push(JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities : []));
    }
    if (updates.length === 0) return reply.code(400).send({ ok: false, error: "no fields to update" });
    vals.push(agentId);
    db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
    broadcastView();
    return { ok: true };
  };

  app.patch<{ Params: { id: string }; Body: any }>("/api/agents/:id", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentEdit(id, req.body ?? {}, reply);
  });

  app.post<{ Params: { id: string }; Body: any }>("/api/agents/:id/edit", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentEdit(id, req.body ?? {}, reply);
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/api/agents/:id/note", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 120) : null;
    db.prepare("UPDATE agents SET note = ? WHERE id = ?").run(note, id);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentPaused(db, id, true);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentPaused(db, id, false);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/retire", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentRetired(db, id, true);
    broadcastView();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/unretire", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    if (!id) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    setAgentRetired(db, id, false);
    broadcastView();
    return { ok: true };
  });

  const handleAgentDelete = async (agentId: string, reply: any) => {
    if (!agentId) return reply.code(400).send({ ok: false, error: "agentId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    deleteAgent(db, agentId);
    broadcastView();
    return { ok: true };
  };

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentDelete(id, reply);
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/delete", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    return handleAgentDelete(id, reply);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/agents/:id/history",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
      const limit = Number(req.query.limit ?? 20);
      const offset = Number(req.query.offset ?? 0);
      const history = getAgentHistory(db, id, limit, offset);
      return { ok: true, ...history };
    }
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/agents/:id/steer", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const { text } = req.body ?? {};
    if (!text || typeof text !== "string") return reply.code(400).send({ ok: false, error: "text required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });

    setAgentSteer(db, id, text);

    const activeTask = db.prepare("SELECT * FROM tasks WHERE agent_id = ? AND state IN ('in_progress', 'accepted', 'working')").get(id) as any;
    if (activeTask) {
      appendEvent(db, agent.project_id, activeTask.id, "task_steer", {
        agentId: id,
        taskId: activeTask.id,
        text,
        at: new Date().toISOString(),
      });
      if (agent.machine_id) {
        const sock = nodeSockets.get(agent.machine_id);
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({ type: "steer", agentId: id, taskId: activeTask.id, text }));
        }
      }
    }

    broadcastView();
    return { ok: true, steered: true, mode: activeTask ? "live" : "next_task", taskId: activeTask?.id ?? null };
  });

  app.post<{ Params: { id: string }; Body: { projectId: string } }>("/api/agents/:id/move", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const { projectId } = req.body ?? {};
    if (!projectId) return reply.code(400).send({ ok: false, error: "projectId required" });
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const moved = moveAgent(db, id, projectId);
    if (!moved) return reply.code(404).send({ ok: false, error: `project "${projectId}" does not exist` });
    broadcastView();
    return { ok: true, agentId: id, projectId };
  });

  app.post<{ Params: { id: string }; Body: { projectId: string; name?: string } }>("/api/agents/:id/clone", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const { projectId, name } = req.body ?? {};
    if (!projectId) return reply.code(400).send({ ok: false, error: "projectId required" });
    const cloned = cloneAgent(db, id, projectId, name);
    if (!cloned) return reply.code(404).send({ ok: false, error: "could not clone agent — check agent and project exist" });
    broadcastView();
    return { ok: true, agent: cloned };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/agents/:id/traces", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
    const limit = Number(req.query.limit ?? 50);
    const traces = getAgentTraces(db, id, limit);
    return { ok: true, agentId: id, traces, events: traces };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; since?: string } }>(
    "/api/agents/:id/output",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
      const limit = Number(req.query.limit ?? 200);
      const since = req.query.since ? Number(req.query.since) : undefined;
      const res = getAgentOutput(db, id, limit, since);
      return { ok: true, ...res, lines: res.output };
    }
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id/git", async (req, reply) => {
    const id = req.params.id || (req.params as any).agentId;
    const gitState = await requestAgentGit(db, nodeSockets, id);
    return gitState;
  });

  const resolveAgentCwd = (agentId: string): string => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    let cwd = agent?.folder || agent?.cwd || process.cwd();
    if (typeof cwd === "string" && cwd.startsWith("~/")) {
      cwd = (process.env.HOME || "") + cwd.slice(1);
    }
    if (!existsSync(cwd)) {
      try { mkdir(cwd, { recursive: true }); } catch {}
      if (!existsSync(cwd)) cwd = process.cwd();
    }
    return resolve(cwd);
  };

  const safeJoin = (root: string, rel: string): string | null => {
    const absRoot = resolve(root);
    const absPath = isAbsolute(rel) ? normalize(rel) : resolve(absRoot, rel);
    const rel2 = relative(absRoot, absPath);
    if (rel2.startsWith("..") || isAbsolute(rel2)) return null;
    return absPath;
  };

  app.get<{ Params: { id: string }; Querystring: { dir?: string } }>(
    "/api/agents/:id/files",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const root = resolveAgentCwd(id);
      const relDir = req.query.dir || "";
      const absDir = safeJoin(root, relDir);
      if (!absDir) return reply.code(400).send({ ok: false, error: "path escapes root" });
      try {
        const names = await readdir(absDir);
        const entries = await Promise.all(
          names
            .filter((n) => !n.startsWith(".git") && n !== "node_modules")
            .map(async (name) => {
              try {
                const s = await stat(join(absDir, name));
                return {
                  name,
                  isDir: s.isDirectory(),
                  size: s.size,
                  mtime: s.mtimeMs,
                  relPath: relDir ? `${relDir}/${name}` : name,
                };
              } catch {
                return { name, isDir: false, size: 0, mtime: 0, relPath: relDir ? `${relDir}/${name}` : name };
              }
            })
        );
        entries.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { ok: true, root, rel: relDir, entries };
      } catch (err: any) {
        return reply.code(500).send({ ok: false, error: err?.message || String(err) });
      }
    }
  );

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/agents/:id/file",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const rel = req.query.path;
      if (!rel) return reply.code(400).send({ ok: false, error: "path parameter required" });
      const root = resolveAgentCwd(id);
      const absPath = safeJoin(root, rel);
      if (!absPath) return reply.code(400).send({ ok: false, error: "path escapes root" });
      try {
        const content = await readFile(absPath, "utf-8");
        return { ok: true, path: rel, content, size: content.length };
      } catch (err: any) {
        return reply.code(404).send({ ok: false, error: err?.message || "file not found" });
      }
    }
  );

  app.post<{ Params: { id: string }; Body: { path: string; content: string } }>(
    "/api/agents/:id/file",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const { path: rel, content } = req.body ?? {};
      if (!rel || content === undefined) {
        return reply.code(400).send({ ok: false, error: "path and content required" });
      }
      const root = resolveAgentCwd(id);
      const absPath = safeJoin(root, rel);
      if (!absPath) return reply.code(400).send({ ok: false, error: "path escapes root" });
      try {
        await writeFile(absPath, content, "utf-8");
        return { ok: true, path: rel, size: content.length };
      } catch (err: any) {
        return reply.code(500).send({ ok: false, error: err?.message || "failed to write file" });
      }
    }
  );

  app.post<{ Params: { id: string }; Body: { provider: string; model?: string | null } }>(
    "/api/agents/:id/engine",
    async (req, reply) => {
      const id = req.params.id || (req.params as any).agentId;
      const { provider, model } = req.body ?? {};
      if (!provider) return reply.code(400).send({ ok: false, error: "provider required" });
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!agent) return reply.code(404).send({ ok: false, error: "no such agent" });
      db.prepare("UPDATE agents SET provider = ?, model = ? WHERE id = ?").run(provider, model ?? null, id);
      broadcastView();
      return { ok: true, restarting: true, message: "Restarting — engine will change on next heartbeat." };
    }
  );

  app.get<{ Params: { id: string } }>("/api/agents/:id/profile", async (req, reply) => {
    const agentId = req.params.id;
    const profile = getAgentMetrics(db, agentId);
    if (!profile) return reply.code(404).send({ ok: false, error: "agent not found" });
    return { ok: true, profile };
  });

  app.post<{
    Body: {
      machineId: string; projectId: string; name: string; role?: string;
      provider?: string | null; model?: string | null; capabilities?: string[];
      cwd?: string | null; allowTools?: string[]; denyPaths?: string[];
      character?: string | null; color?: string | null; folder?: string | null;
      isolation?: "shared" | "worktree" | "copy" | null;
      description?: string | null; goal?: string | null;
      bypassPermissions?: boolean;
    };
  }>("/api/agents", async (req, reply) => {
    const b = req.body;
    if (!b?.machineId || !b?.projectId || !b?.name) {
      return reply.code(400).send({ error: "machineId, projectId and name are required" });
    }
    if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(b.projectId)) {
      return reply.code(404).send({ ok: false, agentId: null, error: `no such project "${b.projectId}"` });
    }
    const proj = db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(b.projectId) as any;
    const commanderAgent = db.prepare("SELECT folder FROM agents WHERE project_id = ? AND (role = 'planner' OR role = 'orchestrator' OR name LIKE '%commander%') LIMIT 1").get(b.projectId) as any;
    let targetFolder = b.folder || commanderAgent?.folder;
    if (!targetFolder && proj?.gh_repo) {
      if (existsSync(proj.gh_repo)) {
        targetFolder = proj.gh_repo;
      } else {
        const candidate = join(process.env.HOME || "", "project_test", proj.gh_repo);
        if (existsSync(candidate)) targetFolder = candidate;
      }
    }
    const validFolder = targetFolder && existsSync(targetFolder) ? targetFolder : null;

    const result = await requestAgentCreate(db, nodeSockets, {
      machineId: b.machineId,
      projectId: b.projectId,
      name: String(b.name).slice(0, 64),
      role: b.role ?? "developer",
      provider: b.provider ?? null,
      model: b.model ?? null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities : [],
      cwd: b.cwd || validFolder || null,
      character: b.character ?? null,
      color: b.color ?? null,
      folder: b.folder || validFolder || null,
      isolation: b.isolation ?? null,
      bypassPermissions: Boolean(b.bypassPermissions),
      description: b.description ? String(b.description).trim().slice(0, 120) : null,
      goal: b.goal ? String(b.goal).trim().slice(0, 2000) : null,
      allowTools: Array.isArray(b.allowTools) ? b.allowTools : [],
      denyPaths: Array.isArray(b.denyPaths) ? b.denyPaths : [],
    });
    broadcastView();
    if (result.ok && result.agentId) {
      if (targetFolder && existsSync(targetFolder)) {
        try {
          registerAgentInProjectHive(targetFolder, {
            id: result.agentId,
            name: String(b.name).slice(0, 64),
            role: b.role ?? "developer",
            provider: b.provider ?? "cli",
            model: b.model ?? "default",
          });
        } catch {}
      }

      if (hive) {
        hive.registerAgent({
          id: result.agentId,
          name: String(b.name).slice(0, 64),
          role: b.role ?? "developer",
          provider: b.provider ?? "cli",
          model: b.model ?? "default",
          folder: targetFolder,
        });
      }

      const ptyName = 'pty-' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + result.agentId.slice(-8);
      try {
        spawnOrGetPtySession(db, ptyName, result.agentId, 100, 30, hive);
      } catch {}
    }
    return reply.code(result.ok ? 200 : 409).send(result);
  });
}
