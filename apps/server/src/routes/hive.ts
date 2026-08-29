import type { FastifyInstance } from "fastify";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteDeps } from "./types.js";

export function registerHiveRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, broadcastView, hive } = deps;
  if (!hive) return;

  app.get("/api/hive/roster", async () => {
    return hive.getRegistry();
  });

  app.get("/api/hive/board", async () => {
    return { content: hive.getBoard() };
  });

  app.post("/api/hive/board", async (req, reply) => {
    const body = req.body as any;
    if (typeof body?.content !== "string") return reply.code(400).send({ error: "content required" });
    hive.setBoard(body.content, body.authorId);
    return { ok: true, content: body.content };
  });

  app.get("/api/hive/tasks", async (req) => {
    const q = req.query as any;
    const projectId = q?.projectId;
    const agentId = q?.agentId;
    if (projectId) {
      const proj = db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(projectId) as any;
      if (proj?.gh_repo) {
        const pTasksPath = join(proj.gh_repo, "hive", "tasks.json");
        if (existsSync(pTasksPath)) {
          try {
            const data = JSON.parse(readFileSync(pTasksPath, "utf8"));
            return { tasks: data.tasks || [] };
          } catch {}
        }
      }
    }
    if (agentId) {
      const agt = db.prepare("SELECT folder, project_id FROM agents WHERE id = ?").get(agentId) as any;
      const targetFolder = agt?.folder || (agt?.project_id ? (db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(agt.project_id) as any)?.gh_repo : null);
      if (targetFolder) {
        const pTasksPath = join(targetFolder, "hive", "tasks.json");
        if (existsSync(pTasksPath)) {
          try {
            const data = JSON.parse(readFileSync(pTasksPath, "utf8"));
            return { tasks: data.tasks || [] };
          } catch {}
        }
      }
    }
    return { tasks: hive.getTasks() };
  });

  app.post("/api/hive/tasks", async (req, reply) => {
    const body = req.body as any;
    if (!body?.title) return reply.code(400).send({ error: "title required" });
    const task = hive.upsertTask(body);

    const projectId = body?.projectId;
    if (projectId) {
      const proj = db.prepare("SELECT gh_repo FROM projects WHERE id = ?").get(projectId) as any;
      if (proj?.gh_repo) {
        const pTasksPath = join(proj.gh_repo, "hive", "tasks.json");
        try {
          let tasksObj: { tasks: any[] } = { tasks: [] };
          if (existsSync(pTasksPath)) {
            tasksObj = JSON.parse(readFileSync(pTasksPath, "utf8"));
          }
          if (!Array.isArray(tasksObj.tasks)) tasksObj.tasks = [];
          const idx = tasksObj.tasks.findIndex((t: any) => t.id === task.id);
          if (idx >= 0) tasksObj.tasks[idx] = task;
          else tasksObj.tasks.push(task);
          writeFileSync(pTasksPath, JSON.stringify(tasksObj, null, 2), "utf8");
        } catch {}
      }
    }

    return { ok: true, task };
  });

  app.get("/api/hive/messages", async (req, reply) => {
    const q = req.query as any;
    const agentId = q.agentId;
    if (!agentId) return reply.code(400).send({ error: "agentId required" });
    return hive.getAgentMessages(agentId);
  });

  app.post("/api/hive/messages", async (req, reply) => {
    const body = req.body as any;
    if (!body?.to || !body?.body) return reply.code(400).send({ error: "to and body required" });
    const msg = hive.postMessage(body, body.from || "user");
    return { ok: true, message: msg };
  });

  app.get("/api/hive/memory/:agentId", async (req, reply) => {
    const { agentId } = req.params as any;
    return { content: hive.getAgentMemory(agentId) };
  });

  app.post("/api/hive/memory/:agentId", async (req, reply) => {
    const { agentId } = req.params as any;
    const body = req.body as any;
    if (typeof body?.content !== "string") return reply.code(400).send({ error: "content required" });
    hive.setAgentMemory(agentId, body.content);
    return { ok: true, content: body.content };
  });

  app.get("/api/hive/meetings", async () => {
    return { meetings: hive.getActiveMeetings() };
  });

  app.post("/api/hive/meeting", async (req, reply) => {
    const body = req.body as any;
    if (!body?.agentA || !body?.agentB) {
      return reply.code(400).send({ error: "agentA and agentB required" });
    }
    const action = body.action || "start";
    if (action === "end") {
      hive.endMeeting(body.agentA, body.agentB);
    } else {
      const durationMs = body.durationSeconds ? Number(body.durationSeconds) * 1000 : 45000;
      hive.setMeeting(body.agentA, body.agentB, durationMs, body.reason || "Inter-Agent Collaboration");
    }
    broadcastView();
    return { ok: true, meetings: hive.getActiveMeetings() };
  });
}
