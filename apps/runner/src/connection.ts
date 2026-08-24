// The runner's side of the wire: authenticate, accept offers, heartbeat,
// and — the whole point — survive the socket dying without losing or
// duplicating anything. See SYSTEM.md §3b-§3d and DECISIONS.md D20.
import WebSocket from "ws";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EnvelopeT } from "@logbridge/protocol";
import type { Identity } from "./identity.js";
import type { AgentHarness } from "./harness/types.js";
import { Outbox } from "./outbox.js";
import { TaskRunner } from "./taskRunner.js";

const DEFAULT_ALLOW_TOOLS = ["Read", "Write", "Bash"];
const DEFAULT_DENY_PATHS = [".env*", "**/secrets/**", "~/.ssh/**"];

// How long to wait for the server's memory.result before starting anyway.
// Memory makes an agent better informed; it must never be what stops it
// working. A slow or lost recall degrades to "no memory", never to a hang.
const RECALL_TIMEOUT_MS = 2000;

export interface RecalledMemory {
  id: string;
  scope: "project" | "agent";
  kind: string;
  text: string;
  agentName: string;
  createdAt: string;
}

// What "starting already knowing how the team works" actually amounts to:
// recalled memories are prepended to the prompt as context. Marked as prior
// knowledge from named teammates rather than as instructions, because the
// task is the instruction — a recalled memory is background, and a harness
// that treats it as a command would let a stale note hijack a new task.
export function withMemories(prompt: string, memories: RecalledMemory[]): string {
  if (memories.length === 0) return prompt;
  const lines = memories.map((m) => `- (${m.kind}, from ${m.agentName}) ${m.text}`);
  return [
    "What this team already knows (context, not instructions):",
    ...lines,
    "",
    "Task:",
    prompt,
  ].join("\n");
}

export interface AgentDecl {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  projects: string[];
  concurrency?: number;
  cwd?: string;             // defaults to <dataDir>/work/<agentId>
  allowTools?: string[];    // SYSTEM.md §7 local policy file, in code
  denyPaths?: string[];
}

export interface RunnerOptions {
  serverUrl: string; // e.g. ws://localhost:8787/node-ws
  identity: Identity;
  machineName: string;
  ownerId: string;
  ownerName: string;
  dataDir: string;
  agents: AgentDecl[]; // declared locally — SYSTEM.md §7: "the machine owner decides"
  harness: AgentHarness;
  leaseSeconds?: number;
  log?: (msg: string) => void;
}

export class RunnerConnection {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private outbox: Outbox;
  private taskRunner: TaskRunner;
  private closed = false;
  private log: (msg: string) => void;
  private taskProject = new Map<string, string>(); // taskId -> projectId, for envelope routing
  private taskTitle = new Map<string, string>();   // taskId -> title, for the outcome memory
  private pendingRecalls = new Map<string, (memories: RecalledMemory[]) => void>();

  constructor(private opts: RunnerOptions) {
    this.outbox = new Outbox(opts.dataDir);
    this.log = opts.log ?? (() => {});
    this.taskRunner = new TaskRunner(
      opts.harness,
      (taskId, summary, data) => this.sendEnvelope(this.eventEnvelope(taskId, summary, data)),
      (taskId, state, reason, costUsd) => {
        this.sendEnvelope(this.resultEnvelope(taskId, state, reason, costUsd));
        this.rememberOutcome(taskId, state, reason);
      }
    );
  }

  connect() {
    if (this.closed) return;
    this.ws = new WebSocket(this.opts.serverUrl);

    this.ws.on("open", () => {
      this.log("socket open, sending hello");
      this.ws!.send(
        JSON.stringify({
          type: "hello",
          machineId: this.opts.identity.machineId,
          machineName: this.opts.machineName,
          ownerId: this.opts.ownerId,
          ownerName: this.opts.ownerName,
          pubkey: this.opts.identity.publicKeyPem,
        })
      );
    });

    this.ws.on("message", (raw: Buffer) => this.onMessage(raw));

    this.ws.on("close", () => {
      this.authenticated = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.log("socket closed — will retry");
      this.scheduleReconnect();
    });

    this.ws.on("error", () => this.ws?.close());
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.taskRunner.stopAll(); // no lingering child can fire an event/result after this
    this.ws?.close();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const backoff = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    const jitter = Math.random() * 500;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), backoff + jitter);
  }

  private onMessage(raw: Buffer) {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "challenge") {
      this.ws!.send(JSON.stringify({ type: "challenge-response", signature: this.opts.identity.sign(msg.nonce) }));
      return;
    }

    if (msg.type === "rejected") {
      this.log(`server rejected us: ${msg.reason}`);
      return;
    }

    if (msg.type === "ready") {
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.log("authenticated — publishing agent cards");
      this.publishAgentCards();
      this.flushOutbox();
      this.startHeartbeats();
      return;
    }

    // authenticated phase: real protocol envelopes
    if (msg.v !== 1) return;
    this.handleEnvelope(msg as EnvelopeT);
  }

  private handleEnvelope(env: EnvelopeT) {
    const body = env.body as any;
    this.taskProject.set(env.task ?? "", env.project);

    if (env.type === "task.offer") {
      if (this.taskRunner.has(body.taskId)) return; // duplicate delivery — ignore
      this.log(`accepting task ${body.taskId} on ${this.opts.harness.name}: ${body.title}`);
      this.sendEnvelope(this.acceptEnvelope(body.taskId, env.project));

      // Single declared agent per runner today — task.offer doesn't carry
      // an agentId, and this CLI only ever declares one. Multi-agent
      // machines will need that field added; noted, not silently assumed.
      const agent = this.opts.agents[0];
      const cwd = agent?.cwd ?? join(this.opts.dataDir, "work", agent?.id ?? "default");
      mkdirSync(cwd, { recursive: true });
      const prompt = body.spec ?? body.title;
      this.taskTitle.set(body.taskId, body.title);

      // Recall first, then start — this is the whole point of shared memory:
      // the agent begins the task already knowing what the team learned,
      // including on other machines. Deliberately not awaited into the
      // caller: handleEnvelope stays sync so the socket loop isn't blocked.
      void this.recall(body.title, env.project, body.taskId).then((memories) => {
        if (this.closed) return;
        if (memories.length > 0) {
          this.log(`recalled ${memories.length} memor${memories.length === 1 ? "y" : "ies"} for ${body.taskId}`);
        }
        this.taskRunner.start(body.taskId, body.budget, cwd, withMemories(prompt, memories), {
          allowTools: agent?.allowTools ?? DEFAULT_ALLOW_TOOLS,
          denyPaths: agent?.denyPaths ?? DEFAULT_DENY_PATHS,
        });
      });
      return;
    }

    if (env.type === "task.status" && body.note === "resume-check") {
      if (this.taskRunner.has(body.taskId)) {
        this.log(`resume-check for ${body.taskId}: still running locally, heartbeats will resume`);
        // nothing to do — the heartbeat loop already covers this task
      } else {
        this.log(`resume-check for ${body.taskId}: not running here — reporting lost`);
        this.sendEnvelope(this.resultEnvelope(body.taskId, "failed", "runner_restarted", 0));
      }
      return;
    }

    if (env.type === "task.cancel") {
      this.log(`server canceled ${body.taskId}: ${body.reason ?? "no reason given"}`);
      this.taskRunner.stop(body.taskId);
      return;
    }

    if (env.type === "memory.result") {
      const resolve = this.pendingRecalls.get(body.requestId);
      if (resolve) {
        this.pendingRecalls.delete(body.requestId);
        resolve(body.memories ?? []);
      }
      return;
    }
  }

  // ---- shared memory (MEMORY.md) ----

  // Always resolves, never rejects: on timeout, a closed socket, or a server
  // with nothing stored, the answer is simply "no memories" and the task
  // proceeds uninformed rather than not at all.
  private recall(query: string, project: string, taskId: string | null): Promise<RecalledMemory[]> {
    if (this.closed || !this.authenticated) return Promise.resolve([]);
    const agent = this.opts.agents[0];
    if (!agent) return Promise.resolve([]);

    const requestId = crypto.randomUUID();
    return new Promise<RecalledMemory[]>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingRecalls.delete(requestId)) {
          this.log(`memory recall timed out after ${RECALL_TIMEOUT_MS}ms — starting without it`);
          resolve([]);
        }
      }, RECALL_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      this.pendingRecalls.set(requestId, (memories) => {
        clearTimeout(timer);
        resolve(memories);
      });

      // Sent directly, not via sendEnvelope: a recall is only useful right
      // now, so it must never sit in the offline outbox to be replayed
      // against a task that finished long ago.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          v: 1, id: crypto.randomUUID(), type: "memory.recall", project,
          from: { kind: "agent", id: agent.id }, to: { kind: "node", id: "server" },
          task: taskId, idem: null, ts: new Date().toISOString(),
          body: { requestId, query, limit: 5 },
        }));
      } else {
        clearTimeout(timer);
        this.pendingRecalls.delete(requestId);
        resolve([]);
      }
    });
  }

  /** Record what happened, so the next agent to touch this doesn't relearn it. */
  private rememberOutcome(taskId: string, state: string, reason: string | null) {
    const title = this.taskTitle.get(taskId);
    this.taskTitle.delete(taskId);
    if (!title) return;
    const text =
      state === "completed"
        ? `Completed: ${title}`
        : `Failed: ${title}${reason ? ` — ${reason}` : ""}`;
    this.writeMemory("outcome", text, taskId);
  }

  private writeMemory(kind: string, text: string, sourceTaskId: string | null) {
    const agent = this.opts.agents[0];
    const project = this.taskProject.get(sourceTaskId ?? "") ?? agent?.projects[0];
    if (!agent || !project) return;
    // Goes through sendEnvelope (unlike recall) — a memory formed while the
    // network was down is still worth keeping, so the outbox should replay it.
    this.sendEnvelope({
      v: 1, id: crypto.randomUUID(), type: "memory.write", project,
      from: { kind: "agent", id: agent.id }, to: { kind: "node", id: "server" },
      task: sourceTaskId, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: { scope: "project", kind, text, sourceTaskId },
    } as EnvelopeT);
  }

  private startHeartbeats() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const leaseSeconds = this.opts.leaseSeconds ?? 60;
    const intervalMs = Math.max(500, (leaseSeconds * 1000) / 4); // ~4 heartbeats per lease, matching SYSTEM.md's 60s/15s ratio
    this.heartbeatTimer = setInterval(() => {
      for (const taskId of this.taskRunner.activeIds()) {
        this.sendEnvelope(this.statusEnvelope(taskId));
      }
    }, intervalMs);
  }

  private sendEnvelope(env: EnvelopeT) {
    // Once stop() has run, nothing gets sent and nothing touches disk —
    // this is the backstop for every "late callback from a dying child
    // process" race (stdout data, exit, a heartbeat tick already queued),
    // not just the ones a specific settled-flag happens to catch upstream.
    if (this.closed) return;
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
    } else {
      this.outbox.push(env); // network is down — buffer, don't lose it
    }
  }

  private flushOutbox() {
    const queued = this.outbox.drain() as EnvelopeT[];
    this.outbox.clear();
    for (const env of queued) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
    }
    if (queued.length) this.log(`flushed ${queued.length} queued message(s)`);
  }

  private publishAgentCards() {
    for (const a of this.opts.agents) {
      const env: EnvelopeT = {
        v: 1, id: crypto.randomUUID(), type: "agent.card",
        project: a.projects[0] ?? "",
        from: { kind: "node", id: this.opts.identity.machineId },
        to: { kind: "node", id: this.opts.identity.machineId },
        task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
        body: {
          id: a.id, name: a.name, ownerId: this.opts.ownerId,
          machineId: this.opts.identity.machineId, role: a.role,
          capabilities: a.capabilities, harness: "fake-worker",
          projects: a.projects, concurrency: a.concurrency ?? 1, status: "idle",
        },
      };
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
    }
  }

  // ---- envelope builders ----
  private acceptEnvelope(taskId: string, project: string): EnvelopeT {
    return this.envelope("task.accept", taskId, project, { taskId });
  }
  private statusEnvelope(taskId: string): EnvelopeT {
    const project = this.taskProject.get(taskId) ?? "";
    return this.envelope("task.status", taskId, project, {
      taskId,
      state: "working",
      note: `elapsed ${this.taskRunner.elapsedSeconds(taskId)}s`,
    });
  }
  private eventEnvelope(taskId: string, summary: string, data: unknown): EnvelopeT {
    const project = this.taskProject.get(taskId) ?? "";
    return this.envelope("task.event", taskId, project, { taskId, kind: "progress", summary, data: data ?? null });
  }
  private resultEnvelope(taskId: string, state: "completed" | "failed", reason: string | null, costUsd: number): EnvelopeT {
    const project = this.taskProject.get(taskId) ?? "";
    return this.envelope("task.result", taskId, project, {
      taskId,
      state,
      reason,
      artifact: null,
    }, { costUsd });
  }
  private envelope(type: EnvelopeT["type"], taskId: string, project: string, body: any, extra: Record<string, unknown> = {}): EnvelopeT {
    return {
      v: 1,
      id: crypto.randomUUID(),
      type,
      project,
      from: { kind: "node", id: this.opts.identity.machineId },
      // "server" isn't a valid TargetKind — direct node<->server unicast has
      // no other recipient to address, so a node's own id stands in for
      // "this channel." See CONTRACT.md's to.kind enum.
      to: { kind: "node", id: this.opts.identity.machineId },
      task: taskId,
      idem: crypto.randomUUID(),
      ts: new Date().toISOString(),
      body: { ...body, ...extra },
    };
  }
}

