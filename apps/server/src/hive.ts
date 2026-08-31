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
import { loadRole } from "./roles/loader.js";

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
  /** Role definition name (roles/loader.ts). When it resolves, identity.md is
   *  written from the definition instead of the one-line stub below. */
  roleId?: string | null;
}

export interface HiveRegistry {
  godId: string | null;
  agents: Record<string, HiveAgentMeta>;
}

export interface HiveEvent {
  ts: string;
  kind: "spawn" | "message" | "routed" | "task" | "board" | "memory" | "meeting";
  agentId?: string;
  from?: string;
  to?: string;
  data?: any;
}

export interface ActiveMeeting {
  partnerId: string;
  partnerName: string;
  expiresAt: number;
  reason: string;
}

export const GOD_OWNED_FILES = ["board.md", "tasks.json", "registry.json", "fleet.json"] as const;

/**
 * Normalizes file path/name and checks if it matches any god-owned file.
 * Normalizes `./board.md`, `hive/board.md`, `/abs/path/to/board.md` -> `board.md`.
 */
export function isGodOwnedFile(fileNameOrPath: string): boolean {
  if (!fileNameOrPath) return false;
  const norm = fileNameOrPath.trim().replace(/^[.\\/]+/, "");
  const base = norm.split(/[/\\\\]/).pop() || norm;
  return GOD_OWNED_FILES.some((f) => base === f || norm === f || norm === `hive/${f}`);
}

/**
 * Derives fleet.json as a direct projection of registry.json and live inbox metrics.
 * Eliminates state drift between registry.json and fleet.json.
 */
export function deriveFleet(root: string, registry?: HiveRegistry): { version: number; generatedAt: string; agents: any[] } {
  let reg = registry;
  if (!reg) {
    const regPath = join(root, "registry.json");
    try {
      if (existsSync(regPath)) reg = JSON.parse(readFileSync(regPath, "utf8"));
    } catch {}
  }
  if (!reg) reg = { godId: null, agents: {} };

  const agentsList: any[] = [];
  for (const [id, a] of Object.entries(reg.agents || {})) {
    const inboxDir = join(root, "agents", id, "inbox");
    let inboxBacklog = 0;
    if (existsSync(inboxDir)) {
      try {
        inboxBacklog = readdirSync(inboxDir).filter((f) => f.endsWith(".json")).length;
      } catch {}
    }

    agentsList.push({
      id: a.id || id,
      name: a.name || id,
      role: a.role || "Developer",
      status: "active",
      provider: a.provider || "default",
      model: a.model || "default",
      tokens: 0,
      cost: 0,
      lastTool: "idle",
      breaker: "none",
      inboxBacklog,
    });
  }

  const fleet = {
    version: 1,
    generatedAt: new Date().toISOString(),
    agents: agentsList,
  };

  const fleetPath = join(root, "fleet.json");
  const tmp = `${fleetPath}.tmp.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(fleet, null, 2) + "\n", "utf8");
    renameSync(tmp, fleetPath);
  } catch {}

  return fleet;
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

## Artifacts by Reference
**NEVER paste raw diffs, file listings, or walls of code into message bodies or \`say\`**.
Save the artifact to disk or pass its reference ID/path (e.g. \`"artifacts": { "diff": "path/to/patch" }\`). The office chat displays \`say\` directly to humans — keeping messages concise preserves office readability.

## Shared Blackboard — \`board.md\`
Shared project plans, specifications, and architecture decisions live in \`board.md\`.
Read it to understand the global plan and update it when specs change.

## Tasks Ledger — \`tasks.json\`
The live Kanban tasks live in \`tasks.json\`. Update your assigned tasks as you make progress.
`;

/**
 * The `identity.md` an agent finds in its own workspace.
 *
 * ONE renderer, because there were two — HiveManager.registerAgent wrote one
 * text and registerAgentInProjectHive wrote a different one to a different
 * root, and they described the same agent. Whichever ran last was the version
 * anybody actually read.
 *
 * When a role definition resolves, the brief here is the SAME body the PTY
 * prompt is built from (hivePrompt.ts). That is the point: this file and the
 * prompt were previously unrelated texts about one agent, so they drifted the
 * moment either was edited.
 */
export function renderIdentityMd(meta: HiveAgentMeta): string {
  const roleDef = loadRole(meta.roleId, meta.folder);
  const brief = meta.isGod
    ? "Floor Orchestrator (God Agent). You run the floor, coordinate tasks, clarify requirements, and direct agents."
    : roleDef
    ? `You are the ${roleDef.noun} on this floor.\n\n${roleDef.body}`
    : `Specialized Agent: ${meta.name} (${meta.role || "Developer"}).`;

  return (
    `# Agent Identity: ${meta.name}\n\n` +
    `- **ID**: \`${meta.id}\`\n` +
    `- **Role**: ${meta.roleId || meta.role || "Developer"}\n` +
    `- **Provider**: ${meta.provider || "cli"}\n` +
    `- **Model**: ${meta.model || "default"}\n\n` +
    `${brief}\n\n` +
    `Read \`PROTOCOL.md\` in the hive root to communicate with other agents via \`inbox/\` and \`outbox/\`.\n`
  );
}

function shortRand(): string {
  return randomBytes(3).toString("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class HiveManager {
  private _root: string;
  private projectRoots = new Set<string>();
  private routerTimer: NodeJS.Timeout | null = null;
  private onEventCallback?: (event: HiveEvent) => void;
  private onMessageCallback?: (msg: HiveMessage, sourceId: string, targetId: string) => void;
  private activeMeetings = new Map<string, ActiveMeeting>();

  constructor(
    rootDir: string,
    onEvent?: (event: HiveEvent) => void,
    onMessage?: (msg: HiveMessage, sourceId: string, targetId: string) => void
  ) {
    this._root = rootDir;
    this.onEventCallback = onEvent;
    this.onMessageCallback = onMessage;
    this.initHive();
  }

  registerProjectRoot(folder: string): void {
    if (folder) {
      const hDir = folder.endsWith("/hive") ? folder.slice(0, -5) : folder;
      this.projectRoots.add(hDir);
    }
  }

  setMeeting(agentA: string, agentB: string, durationMs = 45000, reason = "Conference"): void {
    const reg = this.getRegistry();
    // A meeting is two sprites walking to a table. Pseudo-senders like
    // "operator" or "system" have no sprite, so a meeting with one strands
    // the real agent at a table facing nobody until the timer expires.
    if (!reg.agents[agentA] || !reg.agents[agentB]) return;
    const nameA = reg.agents[agentA]?.name || agentA;
    const nameB = reg.agents[agentB]?.name || agentB;
    const expiresAt = Date.now() + durationMs;

    this.activeMeetings.set(agentA, {
      partnerId: agentB,
      partnerName: nameB,
      expiresAt,
      reason,
    });
    this.activeMeetings.set(agentB, {
      partnerId: agentA,
      partnerName: nameA,
      expiresAt,
      reason,
    });

    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "meeting",
      from: agentA,
      to: agentB,
      data: { action: "start", reason, durationMs },
    });
  }

  endMeeting(agentA: string, agentB?: string): void {
    const meetingA = this.activeMeetings.get(agentA);
    const partner = agentB || meetingA?.partnerId;
    this.activeMeetings.delete(agentA);
    if (partner) {
      this.activeMeetings.delete(partner);
    }
    this.emitEvent({
      ts: new Date().toISOString(),
      kind: "meeting",
      from: agentA,
      to: partner,
      data: { action: "end" },
    });
  }

  cleanExpiredMeetings(): boolean {
    const now = Date.now();
    let changed = false;
    for (const [id, m] of this.activeMeetings.entries()) {
      if (m.expiresAt <= now) {
        this.activeMeetings.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitEvent({
        ts: new Date().toISOString(),
        kind: "meeting",
        data: { action: "expired" },
      });
    }
    return changed;
  }

  isAgentCollaborating(agentId: string): boolean {
    const m = this.activeMeetings.get(agentId);
    if (!m) return false;
    if (m.expiresAt <= Date.now()) {
      this.activeMeetings.delete(agentId);
      return false;
    }
    return true;
  }

  getCollaborationPartner(agentId: string): string | null {
    if (!this.isAgentCollaborating(agentId)) return null;
    const m = this.activeMeetings.get(agentId);
    return m ? m.partnerName : null;
  }

  getCollaborationPartnerId(agentId: string): string | null {
    if (!this.isAgentCollaborating(agentId)) return null;
    const m = this.activeMeetings.get(agentId);
    return m ? m.partnerId : null;
  }

  hasAnyCollaboration(): boolean {
    const now = Date.now();
    for (const [_, m] of this.activeMeetings.entries()) {
      if (m.expiresAt > now) return true;
    }
    return false;
  }

  getActiveMeetings(): Array<{ agentA: string; agentB: string; partnerName: string; remainingMs: number; reason: string }> {
    const now = Date.now();
    const result: Array<{ agentA: string; agentB: string; partnerName: string; remainingMs: number; reason: string }> = [];
    const seen = new Set<string>();

    for (const [id, m] of this.activeMeetings.entries()) {
      if (m.expiresAt <= now) continue;
      const pairKey = [id, m.partnerId].sort().join("<->");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      result.push({
        agentA: id,
        agentB: m.partnerId,
        partnerName: m.partnerName,
        remainingMs: m.expiresAt - now,
        reason: m.reason,
      });
    }
    return result;
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

    deriveFleet(this._root);

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
    if (meta.folder) {
      this.registerProjectRoot(meta.folder);
    }
    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, "inbox", ".done"), { recursive: true });
    mkdirSync(join(dir, "outbox"), { recursive: true });

    writeFileSync(join(dir, "identity.md"), renderIdentityMd(meta), "utf8");

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
    // Re-registration is routine: every agent is re-registered on server
    // startup. Only a genuinely new arrival changes the roster, so only that
    // is worth waking the commander for — otherwise every boot delivers a
    // wake storm of "X joined the floor" for agents that have been there
    // all along.
    const isNewArrival = !registry.agents[meta.id];
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

    // Tell the commander the floor changed.
    //
    // Observed failure: a project is created, the commander's terminal starts
    // immediately, and it reads a registry containing only itself. It
    // concludes "no subordinates are registered, so delegation isn't
    // possible" and starts implementing alone — which its own protocol
    // forbids. The user then adds sam/ram/dam seconds later, but that
    // decision is already in the commander's context and it never revisits it.
    //
    // A prompt telling it to re-read the registry does not fix this: it had
    // already read one, and nothing tells it the answer changed. So the
    // roster change becomes a message, which the wake path turns into a turn.
    if (isNewArrival && !meta.isGod && registry.godId && registry.godId !== meta.id) {
      const roster = Object.values(registry.agents)
        .filter((a: any) => a.id !== registry.godId)
        .map((a: any) => `${a.name} (${a.role || "agent"})`)
        .join(", ");
      this.deliver({
        id: `roster-${meta.id}-${Date.now()}`,
        from: "operator",
        to: registry.godId,
        act: "inform",
        subject: `${meta.name} joined the floor`,
        body:
          `${meta.name} (${meta.role || "agent"}) is now registered and available.\n\n` +
          `Current subordinates: ${roster || "(none)"}.\n\n` +
          `Re-read registry.json before your next dispatch — the roster you saw ` +
          `earlier in this session is stale. If you concluded that delegation ` +
          `was impossible, that conclusion no longer holds.`,
        say: `${meta.name} just joined the floor`,
      } as any);
    }
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
    deriveFleet(this._root, reg);
  }

  isSoleScribe(agentId?: string): boolean {
    if (!agentId || agentId === "god" || agentId === "user" || agentId.startsWith("usr_")) return true;
    const reg = this.getRegistry();
    if (reg.godId && reg.godId === agentId) return true;
    const agent = reg.agents[agentId];
    if (agent?.isGod) return true;
    return false;
  }

  getBoard(): string {
    const p = join(this._root, "board.md");
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {}
    return "";
  }

  setBoard(content: string, authorId?: string): void {
    if (authorId && !this.isSoleScribe(authorId)) {
      throw new Error(
        `Sole scribe violation: agent "${authorId}" cannot write board.md. Send a request to god to update the blackboard.`
      );
    }
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

    const isInterAgent = msg.from && msg.to && msg.from !== "user" && msg.to !== "broadcast";
    if (isInterAgent) {
      for (const targetId of targetIds) {
        if (targetId !== msg.from) {
          if (["request", "query", "propose"].includes(msg.act)) {
            this.setMeeting(msg.from, targetId, 45000, msg.subject || "Collaboration");
          } else if (["done", "agree"].includes(msg.act)) {
            this.setMeeting(msg.from, targetId, 12000, msg.subject || "Review wrap-up");
          } else if (msg.act === "inform") {
            this.setMeeting(msg.from, targetId, 25000, msg.subject || "Status sync");
          }
        }
      }
    }

    if (this.onMessageCallback) {
      for (const targetId of targetIds) {
        try {
          this.onMessageCallback(msg, msg.from, targetId);
        } catch {}
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
    this.cleanExpiredMeetings();
    const allRoots = [this._root, ...Array.from(this.projectRoots).map((f) => join(f, "hive"))];
    const uniqueRoots = Array.from(new Set(allRoots)).filter((r) => existsSync(r));
    let routedCount = 0;

    for (const root of uniqueRoots) {
      const regPath = join(root, "registry.json");
      let reg: HiveRegistry = { godId: null, agents: {} };
      if (existsSync(regPath)) {
        try {
          reg = JSON.parse(readFileSync(regPath, "utf8"));
        } catch {}
      }

      const agentsDir = join(root, "agents");
      if (!existsSync(agentsDir)) continue;

      let agentFolders: string[] = [];
      try {
        agentFolders = readdirSync(agentsDir);
      } catch {
        continue;
      }

      for (const agentId of agentFolders) {
        const outboxDir = join(agentsDir, agentId, "outbox");
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
            // Every commander's own system prompt (hivePrompt.ts) shows the
            // outbox JSON shape without an "id" field — so every message
            // written by an agent actually following its documented
            // protocol arrives here with none. wakeRecipient (hiveWake.ts)
            // treats a message with no id as unidentifiable and silently
            // suppresses it before ever attempting to wake anyone — which
            // meant a real, correctly-delegated task produced zero visible
            // effect: no PTY wake, no room line, nothing. Backfilling here,
            // once, is cheaper than making every consumer downstream handle
            // "id may be absent."
            if (msg && !msg.id) {
              msg.id = `msg-${Date.now()}-${shortRand()}`;
            }
            if (msg && msg.to) {
              // Phase 2: Sole-scribe enforcement.
              // Check if a non-god agent is asserting a write or modification to god-owned files.
              const targetFile = (msg as any).target_file || (msg as any).file || (msg as any).path;
              const isDirectGodFileWrite = targetFile && isGodOwnedFile(String(targetFile));
              const isSoleScribeSender = this.isSoleScribe(msg.from || agentId);

              if (isDirectGodFileWrite && !isSoleScribeSender) {
                // Refuse the write and send refusal message back to the sender
                const godIdentifier = reg.godId || "god";
                const refusal: HiveMessage = {
                  id: `refusal-${Date.now()}-${shortRand()}`,
                  conversation: msg.conversation || `conv-${shortRand()}`,
                  in_reply_to: msg.id,
                  from: godIdentifier,
                  to: msg.from || agentId,
                  act: "refuse",
                  subject: `Write to ${targetFile} refused`,
                  body: `Sole scribe violation: "${msg.from || agentId}" cannot write "${targetFile}" directly. Only god (${godIdentifier}) is authorized. Message god with your proposed change so god can update it.`,
                  hops: 1,
                  requires_reply: false,
                  needs_human: false,
                  created_at: new Date().toISOString(),
                };

                const senderInbox = join(agentsDir, msg.from || agentId, "inbox");
                mkdirSync(senderInbox, { recursive: true });
                writeFileSync(join(senderInbox, `${refusal.id}.json`), JSON.stringify(refusal, null, 2));

                if (this.onMessageCallback) {
                  try {
                    this.onMessageCallback(refusal, godIdentifier, msg.from || agentId);
                  } catch {}
                }

                this.emitEvent({
                  ts: new Date().toISOString(),
                  kind: "message",
                  from: godIdentifier,
                  to: msg.from || agentId,
                  data: { refusal, reason: "sole_scribe_violation", targetFile },
                });

                unlinkSync(filePath);
                routedCount++;
                continue;
              }

              if (root === this._root) {
                this.deliver(msg);
              } else {
                const targetAgent = msg.to === "god" ? (reg.godId || "god") : msg.to;
                const targetInbox = join(agentsDir, targetAgent, "inbox");
                mkdirSync(targetInbox, { recursive: true });
                writeFileSync(join(targetInbox, `${msg.id || Date.now()}.json`), JSON.stringify(msg, null, 2));

                if (msg.from && targetAgent && msg.from !== targetAgent) {
                  if (["request", "query", "propose"].includes(msg.act)) {
                    this.setMeeting(msg.from, targetAgent, 45000, msg.subject || "Collaboration");
                  }
                }

                if (this.onMessageCallback) {
                  try {
                    this.onMessageCallback(msg, msg.from || agentId, targetAgent);
                  } catch {}
                }
              }
              routedCount++;
            }
            unlinkSync(filePath);
          } catch (e) {
            console.warn(`[HiveRouter] Failed routing outbox message ${filePath}:`, e);
            try { unlinkSync(filePath); } catch {}
          }
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

export function ensureProjectHive(
  projectFolder: string,
  projectName: string,
  commanderId: string,
  commanderName: string
): void {
  const hiveDir = join(projectFolder, "hive");
  mkdirSync(join(hiveDir, "agents", commanderId, "inbox", ".done"), { recursive: true });
  mkdirSync(join(hiveDir, "agents", commanderId, "outbox"), { recursive: true });
  mkdirSync(join(hiveDir, "agents", "god", "inbox", ".done"), { recursive: true });
  mkdirSync(join(hiveDir, "agents", "god", "outbox"), { recursive: true });

  const protocolPath = join(hiveDir, "PROTOCOL.md");
  writeFileSync(protocolPath, PROTOCOL_MD, "utf8");

  const boardPath = join(hiveDir, "board.md");
  if (!existsSync(boardPath)) {
    writeFileSync(
      boardPath,
      `# ${projectName} — Project Blackboard\n\n**Commander**: \`${commanderName}\` (${commanderId})\n\n_Shared architectural plans, current objectives, and specifications._\n\n## Objectives\n- [ ] Formulate master architecture for ${projectName}\n- [ ] Delegate tasks to project agents\n- [ ] Complete deliverables\n`,
      "utf8"
    );
  }

  const tasksPath = join(hiveDir, "tasks.json");
  if (!existsSync(tasksPath)) {
    writeFileSync(tasksPath, JSON.stringify({ tasks: [] }, null, 2), "utf8");
  }

  const registryPath = join(hiveDir, "registry.json");
  const registry: HiveRegistry = {
    godId: commanderId,
    agents: {
      [commanderId]: {
        id: commanderId,
        name: commanderName,
        role: "planner",
        folder: projectFolder,
        isGod: true,
      },
    },
  };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");

  const fleetPath = join(hiveDir, "fleet.json");
  if (!existsSync(fleetPath)) {
    writeFileSync(fleetPath, JSON.stringify({ agents: [] }, null, 2), "utf8");
  }

  // Memory & Identity for Commander & God
  const memoryContent = `# Central Operations Commander Memory: ${projectName}\n\n- [${new Date().toISOString()}] Commissioned as Central Operations Commander for "${projectName}".\n- Project Directory: ${projectFolder}\n- Standing Protocol: Analyze objectives, draft architecture on board.md, log tasks on tasks.json, recruit/delegate to project subordinates.\n`;

  for (const targetId of [commanderId, "god"]) {
    const aDir = join(hiveDir, "agents", targetId);
    writeFileSync(join(aDir, "memory.md"), memoryContent, "utf8");
    writeFileSync(
      join(aDir, "identity.md"),
      `# Agent Identity: ${commanderName}\n\n- **ID**: \`${commanderId}\`\n- **Role**: Central Operations Commander\n- **Project**: ${projectName}\n\nFloor Orchestrator (God Agent). You run the floor, coordinate tasks, clarify requirements, and direct project agents.\n`,
      "utf8"
    );
    writeFileSync(join(aDir, "cursor.json"), JSON.stringify({ lastProcessedId: null }), "utf8");
  }
}

export function registerAgentInProjectHive(
  projectFolder: string,
  agent: { id: string; name: string; role?: string; roleId?: string | null; provider?: string; model?: string }
): void {
  const hiveDir = join(projectFolder, "hive");
  const aDir = join(hiveDir, "agents", agent.id);
  mkdirSync(join(aDir, "inbox", ".done"), { recursive: true });
  mkdirSync(join(aDir, "outbox"), { recursive: true });

  writeFileSync(join(aDir, "identity.md"), renderIdentityMd({ ...agent, folder: projectFolder }), "utf8");

  const memPath = join(aDir, "memory.md");
  if (!existsSync(memPath)) {
    writeFileSync(
      memPath,
      `# Long-Term Memory: ${agent.name}\n\n_Durable facts, architectural findings, and learned project context._\n\n- [${new Date().toISOString()}] Initialized agent workspace in ${projectFolder}.\n`,
      "utf8"
    );
  }

  writeFileSync(join(aDir, "cursor.json"), JSON.stringify({ lastProcessedId: null }), "utf8");

  const regPath = join(hiveDir, "registry.json");
  try {
    let reg: HiveRegistry = { godId: null, agents: {} };
    if (existsSync(regPath)) {
      reg = JSON.parse(readFileSync(regPath, "utf8"));
    }
    reg.agents[agent.id] = {
      id: agent.id,
      name: agent.name,
      role: agent.role || "developer",
      roleId: agent.roleId ?? null,
      provider: agent.provider,
      model: agent.model,
      folder: projectFolder,
    };
    writeFileSync(regPath, JSON.stringify(reg, null, 2), "utf8");
    deriveFleet(hiveDir, reg);
  } catch {}
}
