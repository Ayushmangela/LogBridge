import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { ensureProjectHive } from "../hive.js";
import { buildCommanderHivePrompt } from "../hivePrompt.js";
import { spawnOrGetPtySession } from "../ptyGateway.js";
import type { RouteDeps } from "./types.js";

const execAsync = promisify(exec);

export function registerProjectRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, broadcastView, hive } = deps;

  app.get("/api/projects", async () => {
    const projects = db.prepare("SELECT * FROM projects ORDER BY name").all() as any[];
    const result = projects.map((p) => {
      const agents = db.prepare("SELECT id, name, role, is_god FROM agents WHERE project_id = ? AND retired = 0").all(p.id) as any[];
      const taskCount = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE project_id = ?").get(p.id) as any)?.count || 0;
      // is_god is authoritative; role/name are a fallback for rows created
      // before that column existed. Without the fallback, a subordinate
      // that also happens to have role "planner" (a legitimate role choice,
      // not reserved for commanders) can tie with or precede the real
      // commander in `find` — which is exactly how one got its identity
      // overwritten by another agent's terminal in production.
      const commander =
        agents.find((a) => a.is_god) ??
        agents.find((a) => a.role === "planner" || a.name?.toLowerCase().includes("commander"));
      return {
        id: p.id,
        name: p.name || p.gh_repo || p.id,
        gh_repo: p.gh_repo,
        layout: p.layout || "office",
        agentCount: agents.length,
        taskCount,
        commanderName: commander ? commander.name : null,
        commanderId: commander ? commander.id : null,
      };
    });
    return { projects: result };
  });

  app.get("/api/fs/directories", async (req, reply) => {
    const query = req.query as any;
    let target = query?.path ? String(query.path).trim() : (process.env.HOME || "/");
    if (target.startsWith("~/")) {
      target = join(process.env.HOME || "", target.slice(2));
    } else if (target === "~") {
      target = process.env.HOME || "/";
    }
    try {
      if (!existsSync(target)) {
        return reply.code(404).send({ error: "Directory not found: " + target });
      }
      const entries = readdirSync(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: join(target, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 100);

      const parent = dirname(target) !== target ? dirname(target) : null;
      return { current: target, parent, directories: dirs };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post("/api/fs/mkdir", async (req, reply) => {
    const body = req.body as any;
    let target = String(body?.path || "").trim();
    if (!target) return reply.code(400).send({ error: "Path is required" });
    if (target.startsWith("~/")) {
      target = join(process.env.HOME || "", target.slice(2));
    }
    try {
      if (!existsSync(target)) {
        mkdirSync(target, { recursive: true });
      }
      return { success: true, path: target };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post("/api/fs/choose-folder", async (req, reply) => {
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execAsync(
          `osascript -e 'POSIX path of (choose folder with prompt "Select Project Working Directory:")'`
        );
        const folderPath = stdout.trim().replace(/\/+$/, "");
        return { path: folderPath };
      } else if (process.platform === "win32") {
        const { stdout } = await execAsync(
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`
        );
        const folderPath = stdout.trim();
        return { path: folderPath };
      } else {
        return reply.code(400).send({ error: "Native folder picker not supported on this OS" });
      }
    } catch (err: any) {
      if (err.message && (err.message.includes("User canceled") || err.message.includes("-128"))) {
        return { canceled: true };
      }
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post("/api/projects", async (req, reply) => {
    const body = req.body as any;
    const name = String(body?.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Project name is required" });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const projectId = "prj_" + slug + "_" + randomBytes(3).toString("hex");

    let folder = body.folder ? String(body.folder).trim() : "";
    if (!folder) {
      folder = join(process.env.HOME || "", "project_test", slug);
    }
    if (folder.startsWith("~/")) {
      folder = join(process.env.HOME || "", folder.slice(2));
    }
    try {
      if (!existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
      }
    } catch {}

    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, 'office')").run(
      projectId,
      folder,
      name
    );

    const commanderId = "agt_" + randomBytes(4).toString("hex");
    const commanderName = String(body?.commanderName || "").trim() || `${slug}-commander`;
    const provider = String(body?.provider || "opencode").toLowerCase();
    const model = body.model || (provider === "claude" ? "claude-3-7-sonnet-20250219" : "Nemotron 3.5 Lightning Free");

    const machineId = (db.prepare("SELECT id FROM machines WHERE online = 1 LIMIT 1").get() as any)?.id
                   || (db.prepare("SELECT id FROM machines LIMIT 1").get() as any)?.id
                   || "node_primary";
    const ownerId = (db.prepare("SELECT id FROM users LIMIT 1").get() as any)?.id || "usr_ayush";

    // NOT stored on the agent row. `goal` is the human's standing objective —
    // the textarea in the Edit dialog — and this is a ~3,600-character
    // generated prompt. Putting it there overloaded one column with two
    // incompatible things, and cost data both ways:
    //
    //   * the Edit dialog showed a wall of machine text where the human's own
    //     objective belongs, and
    //   * saving that dialog ran it through `slice(0, 2000)`, silently
    //     deleting ~45% of it — so renaming a commander corrupted its brief.
    //
    // Nothing ever read the stored copy: ptyGateway rebuilds the prompt from
    // buildCommanderHivePrompt() on every spawn, which is also what keeps it
    // from going stale when hivePrompt.ts changes. Storing it was redundant
    // before it was harmful.
    const commanderPrompt = buildCommanderHivePrompt({
      commanderName,
      folder,
      projectName: name,
    });

    db.prepare(`
      INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, provider, model, folder, description, goal, character, status, is_god)
      VALUES (?, ?, ?, ?, ?, 'planner', ?, ?, ?, ?, ?, 'adam', 'idle', 1)
    `).run(
      commanderId,
      machineId,
      ownerId,
      projectId,
      commanderName,
      provider,
      model,
      folder,
      `Central Operations Commander for ${name}`,
      // goal: the human's objective, left empty for them to fill in — NOT
      // commanderPrompt. See the note above the builder call.
      null
    );

    try {
      ensureProjectHive(folder, name, commanderId, commanderName);
    } catch {}

    if (hive) {
      hive.registerProjectRoot(folder);
      hive.registerAgent({
        id: commanderId,
        name: commanderName,
        role: "planner",
        provider,
        model,
        folder,
        isGod: true,
      });
    }

    try {
      const agentsMdPath = join(folder, "AGENTS.md");
      writeFileSync(agentsMdPath, commanderPrompt, "utf8");
    } catch {}

    try {
      const memoryContent = `# Central Operations Commander Memory: ${name}\n\n` +
        `- [${new Date().toISOString()}] Commissioned as Central Operations Commander for "${name}".\n` +
        `- Project Directory: ${folder}\n` +
        `- Standing Protocol: Analyze objectives, draft architecture on board.md, log tasks on tasks.json, recruit/delegate to subordinates.\n`;
      if (hive) {
        hive.setAgentMemory(commanderId, memoryContent);

        hive.postMessage({
          from: "operator",
          to: commanderId,
          act: "inform",
          subject: `Welcome, Commander: Project "${name}" initialized`,
          body: `Welcome, Commander. You have been appointed Central Operations Commander for project "${name}". Your workspace is at ${folder}.\n\n` +
            `HIVE PROTOCOL:\n` +
            `1. Maintain situational awareness of the project.\n` +
            `2. Formulate master architecture on ${folder}/hive/board.md.\n` +
            `3. Track deliverables on ${folder}/hive/tasks.json.\n` +
            `4. Delegate missions to specialized subordinate agents.\n` +
            `Stand ready for operator directives.`
        }, "operator");
      }
    } catch {}

    const ptyName = 'pty-' + commanderName.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + commanderId.slice(-8);
    try {
      spawnOrGetPtySession(db, ptyName, commanderId, 100, 30, hive);
    } catch {}

    try {
      const allUsers = db.prepare("SELECT id FROM users").all() as any[];
      for (const u of allUsers) {
        db.prepare(`
          INSERT OR IGNORE INTO project_members (project_id, user_id, role, joined_at)
          VALUES (?, ?, 'member', ?)
        `).run(projectId, u.id, new Date().toISOString());
      }
    } catch {}

    broadcastView();

    return {
      ok: true,
      project: {
        id: projectId,
        name,
        slug,
        folder,
      },
      commander: {
        id: commanderId,
        name: commanderName,
        role: "planner",
        folder,
      },
    };
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as any;
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    if (!project) return reply.code(404).send({ error: "Project not found" });

    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM agents WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM events WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);

    broadcastView();
    return { ok: true, deletedId: id };
  });
}
