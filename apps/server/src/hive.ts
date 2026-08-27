/**
 * The Hive — On-Disk Multi-Agent Coordination Layer for LogBridge.
 *
 * Implements the autonomous multi-agent architecture from munder-difflin:
 *   - Per-agent workspaces (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - Live roster (registry.json), shared blackboard (board.md), task ledger (tasks.json),
 *     and append-only event log (log.jsonl)
 *   - FIPA-lite mailbox router that periodically drains outbox directories into inboxes
 *   - Human-in-the-loop & orchestrator escalation routing
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type MessageAct = "request" | "inform" | "propose" | "query" | "agree" | "refuse" | "done";

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string; // agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done";

export interface HiveTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  priority?: "low" | "medium" | "high" | "urgent";
}

export interface HiveAgentMeta {
  id: string;
  name: string;
  role?: string;
  provider?: string;
  model?: string;
  capabilities?: string[];
  folder?: string;
  isGod?: boolean;
}

export interface HiveRegistry {
  godId: string | null;
  agents: Record<string, HiveAgentMeta>;
}

export interface HiveEvent {
  ts: string;
  kind: "spawn" | "message" | "routed" | "task" | "board" | "memory";
  agentId?: string;
  from?: string;
  to?: string;
  data?: any;
}

const PROTOCOL_MD = `# Hive Protocol

You are one of several agents collaborating in this workspace. Coordination is file-based and autonomous.

## Your Workspace — \`agents/<your-id>/\`
- \`identity.md\`  — Who you are, your role, and capabilities.
- \`memory.md\`    — Your persistent long-term memory. Read it at task start; append to it as you learn.
- \`inbox/\`       — Messages addressed to you from other agents or the orchestrator.
- \`inbox/.done/\` — Handled messages are moved here.
- \`outbox/\`      — Drop outgoing JSON messages here. The router delivers them to recipients' inboxes.

## Communication (FIPA-Lite Speech Acts)
To request help or report progress, write a JSON file to \`outbox/<timestamp>-<id>.json\`:
\`\`\`json
{
  "to": "agent-coder",
  "act": "request",
  "subject": "Review PR #42",
  "body": "Can you review the authentication changes?",
  "requires_reply": true
}
\`\`\`

Supported acts:
- \`request\`  — Asking another agent to perform a task.
- \`inform\`   — Sharing status, results, or data.
- \`query\`    — Asking a question.
- \`agree\`    — Agreeing to a request.
- \`refuse\`   — Declining a request with reason.
- \`done\`     — Reporting task completion.

## Shared Blackboard — \`board.md\`
Shared project plans, specifications, and architecture decisions live in \`board.md\`.
Read it to understand the global plan and update it when specs change.

## Tasks Ledger — \`tasks.json\`
The live Kanban tasks live in \`tasks.json\`. Update your assigned tasks as you make progress.
`;

function shortRand(): string {
  return randomBytes(3).toString("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class HiveManager {
  private _root: string;
  private routerTimer: NodeJS.Timeout | null = null;
  private onEventCallback?: (event: HiveEvent) => void;

  constructor(rootDir: string, onEvent?: (event: HiveEvent) => void) {
    this._root = rootDir;
    this.onEventCallback = onEvent;
    this.initHive();
  }

  root(): string {
    return this._root;
  }

  agentDir(agentId: string): string {
    return join(this._root, "agents", agentId);
  }

  initHive(): void {
    if (!existsSync(this._root)) {
      mkdirSync(this._root, { recursive: true });
    }
    mkdirSync(join(this._root, "agents"), { recursive: true });

    const protocolPath = join(this._root, "PROTOCOL.md");
    if (!existsSync(protocolPath)) {
      writeFileSync(protocolPath, PROTOCOL_MD, "utf8");
    }

    const registryPath = join(this._root, "registry.json");
    if (!existsSync(registryPath)) {
      this.writeJson(registryPath, { godId: null, agents: {} } as HiveRegistry);
    }

    const boardPath = join(this._root, "board.md");
    if (!existsSync(boardPath)) {
      writeFileSync(
        boardPath,
        "# Project Blackboard\n\n_Shared architectural plans, current objectives, and specifications._\n\n## Objectives\n- [ ] Initialize multi-agent workspace\n",
        "utf8"
      );
    }

    const tasksPath = join(this._root, "tasks.json");
    if (!existsSync(tasksPath)) {
      this.writeJson(tasksPath, {
        tasks: [
          {
            id: "tsk-001",
            title: "Setup Hive Workspace",
            description: "Verify agent communication mailboxes and protocol.",
            status: "done",
            assigned_to: "orchestrator",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            priority: "high",
          },
          {
            id: "tsk-002",
            title: "Implement Agent Tasks",
            description: "Coordinate development work across specialized agents.",
            status: "in_progress",
            assigned_to: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            priority: "medium",
          },
        ] as HiveTask[],
      });
    }

    const logPath = join(this._root, "log.jsonl");
    if (!existsSync(logPath)) {
      writeFileSync(logPath, "", "utf8");
    }
  }

  registerAgent(meta: HiveAgentMeta): void {
    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, "inbox", ".done"), { recursive: true });
    mkdirSync(join(dir, "outbox"), { recursive: true });

    // identity.md
    const identityPath = join(dir, "identity.md");
    const roleDesc = meta.isGod
      ? "Floor Orchestrator (God Agent). You run the floor, coordinate tasks, clarify requirements, and direct agents."
      : `Specialized Agent: ${meta.name} (${meta.role || "Developer"}).`;

    writeFileSync(
      identityPath,
      `# Agent Identity: ${meta.name}\n\n- **ID**: \`${meta.id}\`\n- **Role**: ${meta.role || "Developer"}\n- **Provider**: ${meta.provider || "cli"}\n- **Model**: ${meta.model || "default"}\n\n${roleDesc}\n\nRead \`PROTOCOL.md\` in the hive root to communicate with other agents via \`inbox/\` and \`outbox/\`.\n`,
      "utf8"
    );

    // memory.md
    const memoryPath = join(dir, "memory.md");
    if (!existsSync(memoryPath)) {
      writeFileSync(
        memoryPath,
        `# Long-Term Memory: ${meta.name}\n\n_Durable facts, architectural findings, and learned project context._\n\n- [${new Date().toISOString()}] Initialized agent workspace.\n`,
        "utf8"
      );
    }

    // cursor.json
    const cursorPath = join(dir, "cursor.json");
    if (!existsSync(cursorPath)) {
      this.writeJson(cursorPath, { lastProcessedId: null });
    }

    // Update registry.json
    const registry = this.getRegistry();
    registry.agents[meta.id] = meta;
    if (meta.isGod && !registry.godId) {
      registry.godId = meta.id;
    }
    this.saveRegistry(registry);

    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "spawn",
      agentId: meta.id,
      data: { name: meta.name, role: meta.role, isGod: meta.isGod },
    });
  }

  getRegistry(): HiveRegistry {
    const p = join(this._root, "registry.json");
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    } catch {}
    return { godId: null, agents: {} };
  }

  saveRegistry(reg: HiveRegistry): void {
    this.writeJson(join(this._root, "registry.json"), reg);
  }

  getBoard(): string {
    const p = join(this._root, "board.md");
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {}
    return "";
  }

  setBoard(content: string, authorId?: string): void {
    const p = join(this._root, "board.md");
    writeFileSync(p, content, "utf8");
    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "board",
      agentId: authorId,
      data: { length: content.length },
    });
  }

  getTasks(): HiveTask[] {
    const p = join(this._root, "tasks.json");
    try {
      if (existsSync(p)) {
        const d = JSON.parse(readFileSync(p, "utf8"));
        return Array.isArray(d.tasks) ? d.tasks : [];
      }
    } catch {}
    return [];
  }

  setTasks(tasks: HiveTask[]): void {
    this.writeJson(join(this._root, "tasks.json"), { tasks });
    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "task",
      data: { count: tasks.length },
    });
  }

  upsertTask(task: Partial<HiveTask> & { title: string }): HiveTask {
    const tasks = this.getTasks();
    const now = new Date().toISOString();
    let fullTask: HiveTask;
    const existingIndex = task.id ? tasks.findIndex((t) => t.id === task.id) : -1;

    if (existingIndex >= 0) {
      fullTask = {
        ...tasks[existingIndex],
        ...task,
        updated_at: now,
      };
      tasks[existingIndex] = fullTask;
    } else {
      fullTask = {
        id: task.id || `tsk-${Date.now()}-${shortRand()}`,
        title: task.title,
        description: task.description || "",
        status: task.status || "todo",
        assigned_to: task.assigned_to || null,
        created_at: now,
        updated_at: now,
        priority: task.priority || "medium",
      };
      tasks.push(fullTask);
    }
    this.setTasks(tasks);
    return fullTask;
  }

  getAgentMemory(agentId: string): string {
    const p = join(this.agentDir(agentId), "memory.md");
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {}
    return "";
  }

  setAgentMemory(agentId: string, content: string): void {
    const p = join(this.agentDir(agentId), "memory.md");
    writeFileSync(p, content, "utf8");
    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "memory",
      agentId,
      data: { length: content.length },
    });
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  postMessage(msgPartial: Partial<HiveMessage> & { to: string; body: string }, from = "user"): HiveMessage {
    const act = msgPartial.act || "inform";
    const msg: HiveMessage = {
      id: msgPartial.id || `${stamp()}-${shortRand()}`,
      conversation: msgPartial.conversation || `conv-${shortRand()}`,
      in_reply_to: msgPartial.in_reply_to || null,
      from: msgPartial.from || from,
      to: msgPartial.to,
      act,
      subject: msgPartial.subject || msgPartial.body.slice(0, 48),
      body: msgPartial.body,
      hops: typeof msgPartial.hops === "number" ? msgPartial.hops : 0,
      requires_reply: msgPartial.requires_reply ?? ["request", "query", "propose"].includes(act),
      needs_human: msgPartial.needs_human ?? false,
      created_at: msgPartial.created_at || new Date().toISOString(),
    };

    // If sender is an agent, drop into that agent's outbox
    const senderDir = this.agentDir(from);
    if (existsSync(join(senderDir, "outbox"))) {
      const outPath = join(senderDir, "outbox", `${msg.id}.json`);
      this.writeJson(outPath, msg);
    } else {
      // Direct delivery to recipient inbox
      this.deliver(msg);
    }

    return msg;
  }

  deliver(msg: HiveMessage): void {
    const reg = this.getRegistry();
    let targetIds: string[] = [];

    if (msg.to === "broadcast") {
      targetIds = Object.keys(reg.agents).filter((id) => id !== msg.from);
    } else if (msg.to === "god" || msg.to === "orchestrator") {
      if (reg.godId) targetIds = [reg.godId];
      else {
        const first = Object.keys(reg.agents)[0];
        if (first) targetIds = [first];
      }
    } else {
      targetIds = [msg.to];
    }

    for (const targetId of targetIds) {
      const inboxDir = join(this.agentDir(targetId), "inbox");
      if (existsSync(inboxDir)) {
        const targetPath = join(inboxDir, `${msg.id}.json`);
        this.writeJson(targetPath, msg);
      }
    }

    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "message",
      from: msg.from,
      to: msg.to,
      data: msg,
    });
  }

  routeOnce(): number {
    const reg = this.getRegistry();
    let routedCount = 0;

    for (const agentId of Object.keys(reg.agents)) {
      const outboxDir = join(this.agentDir(agentId), "outbox");
      if (!existsSync(outboxDir)) continue;

      let files: string[] = [];
      try {
        files = readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(outboxDir, file);
        try {
          const raw = readFileSync(filePath, "utf8");
          const msg: HiveMessage = JSON.parse(raw);
          if (msg && msg.to) {
            this.deliver(msg);
            routedCount++;
          }
          unlinkSync(filePath);
        } catch (e) {
          console.warn(`[HiveRouter] Failed routing outbox message ${filePath}:`, e);
          try { unlinkSync(filePath); } catch {}
        }
      }
    }

    return routedCount;
  }

  startRouter(intervalMs = 1500): void {
    if (this.routerTimer) return;
    this.routerTimer = setInterval(() => {
      this.routeOnce();
    }, intervalMs);
  }

  stopRouter(): void {
    if (this.routerTimer) {
      clearInterval(this.routerTimer);
      this.routerTimer = null;
    }
  }

  getAgentMessages(agentId: string): { inbox: HiveMessage[]; outbox: HiveMessage[] } {
    const dir = this.agentDir(agentId);
    const inbox: HiveMessage[] = [];
    const outbox: HiveMessage[] = [];

    // Read active inbox
    const inboxDir = join(dir, "inbox");
    if (existsSync(inboxDir)) {
      try {
        const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
        for (const f of files) {
          try {
            inbox.push(JSON.parse(readFileSync(join(inboxDir, f), "utf8")));
          } catch {}
        }
      } catch {}
    }

    // Read processed inbox (.done)
    const doneDir = join(inboxDir, ".done");
    if (existsSync(doneDir)) {
      try {
        const files = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
        for (const f of files) {
          try {
            inbox.push(JSON.parse(readFileSync(join(doneDir, f), "utf8")));
          } catch {}
        }
      } catch {}
    }

    // Read outbox
    const outboxDir = join(dir, "outbox");
    if (existsSync(outboxDir)) {
      try {
        const files = readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
        for (const f of files) {
          try {
            outbox.push(JSON.parse(readFileSync(join(outboxDir, f), "utf8")));
          } catch {}
        }
      } catch {}
    }

    // Sort by timestamp
    inbox.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    outbox.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

    return { inbox, outbox };
  }

  private writeJson(filePath: string, obj: any): void {
    const tmp = `${filePath}.tmp.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    renameSync(tmp, filePath);
  }

  private emitEvent(event: HiveEvent): void {
    // Append to log.jsonl
    try {
      const logPath = join(this._root, "log.jsonl");
      writeFileSync(logPath, JSON.stringify(event) + "\n", { flag: "a", encoding: "utf8" });
    } catch {}

    if (this.onEventCallback) {
      try {
        this.onEventCallback(event);
      } catch {}
    }
  }
}
