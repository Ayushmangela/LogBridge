import WebSocket from "ws";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { open as openSealed, seal, sealAad, type EnvelopeT } from "@logbridge/protocol";
import type { AgentHarness } from "../harness/types.js";
import { makePtyHarness } from "../harness/ptyHarness.js";
import { rememberInstruction } from "../harness/providers.js";
import { resolveWorkspace, type Isolation } from "../workspace.js";
import { Outbox } from "../outbox.js";
import { loadCreatedAgents } from "../createdAgents.js";
import { TaskRunner } from "../taskRunner.js";
import {
  DEFAULT_ALLOW_TOOLS,
  DEFAULT_DENY_PATHS,
  RECALL_TIMEOUT_MS,
  installedProviderSpecs,
  withMemories,
  type AgentDecl,
  type PeerEntry,
  type RecalledMemory,
  type RunnerOptions,
} from "./types.js";
import { handleAgentCreate, handleAgentGit } from "./agent-creation-handler.js";
import { handleAgentPatch } from "./agent-patch-handler.js";
import {
  handleDelegateRequest,
  handleReviewRequest,
  handleContextShare,
  recallSharedContext,
} from "./delegation-handler.js";

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
  private taskAgent = new Map<string, string>();   // taskId -> the agent running it — memory attribution
  private pendingRecalls = new Map<string, (memories: RecalledMemory[]) => void>();
  private peers: PeerEntry[] = [];
  /** One harness per agent, built lazily and cached */
  private harnessCache = new Map<string, AgentHarness>();
  /** Runtime-created agents, mirrored to disk so a restart keeps them. */
  private createdAgents: AgentDecl[];
  private pendingDelegations = new Map<
    string,
    { resolve: (r: { state: string; findings: string | null }) => void; reject: (e: Error) => void }
  >();
  private pendingReviews = new Map<
    string,
    (r: { verdict: string; findings: unknown; summary: string }) => void
  >();
  private pendingShares = new Map<string, () => void>();

  constructor(private opts: RunnerOptions) {
    this.outbox = new Outbox(opts.dataDir);
    this.log = opts.log ?? (() => {});
    this.createdAgents = loadCreatedAgents(opts.dataDir, this.log);
    this.taskRunner = new TaskRunner(
      (agentId) => this.harnessForAgent(agentId),
      (taskId, summary, data) => this.sendEnvelope(this.eventEnvelope(taskId, summary, data)),
      (taskId, state, reason, costUsd) => {
        this.sendEnvelope(this.resultEnvelope(taskId, state, reason, costUsd));
        this.rememberOutcome(taskId, state, reason);
      },
      (taskId, _questionId, question) => {
        const project = this.taskProject.get(taskId) ?? "";
        this.sendEnvelope(this.statusEnvelope(taskId, "input-required"));
        this.sendEnvelope({
          v: 1, id: crypto.randomUUID(), type: "human.ask", project,
          from: { kind: "node", id: this.opts.identity.machineId },
          to: { kind: "node", id: this.opts.identity.machineId },
          task: taskId, idem: crypto.randomUUID(), ts: new Date().toISOString(),
          body: { taskId, question, options: ["answer"] },
        } as EnvelopeT);
        this.log(`agent asked (task ${taskId}): ${question}`);
      },
      (taskId, steps, note) => {
        this.sendEnvelope(this.eventEnvelope(taskId, note ?? `step ${steps}`, { steps }));
      },
      (taskId, kind, text) => {
        this.log(`agent wants to remember: ${text.slice(0, 60)}`);
        this.writeMemory(kind, text, taskId);
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
          sealingPubkey: this.opts.identity.sealingPublicKeyB64,
          providers: installedProviderSpecs(),
          allowAgentCreation: Boolean(this.opts.allowAgentCreation),
          allowUnsandboxed: Boolean(this.opts.allowUnsandboxed),
          acceptDelegations: Boolean(this.opts.acceptDelegations),
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
    this.taskRunner.stopAll();
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

    if (msg.v !== 1) return;
    this.handleEnvelope(msg as EnvelopeT);
  }

  private handleEnvelope(env: EnvelopeT) {
    const body = env.body as any;
    this.taskProject.set(env.task ?? "", env.project);

    if (env.type === "task.offer") {
      if (this.taskRunner.has(body.taskId)) return;
      this.sendEnvelope(this.acceptEnvelope(body.taskId, env.project));

      const named = this.agentById(body.agentId);
      const agent = named ?? (body.agentId ? undefined : this.opts.agents[0]);
      if (!agent) {
        const why = body.agentId
          ? `no such agent "${body.agentId}" on this machine`
          : "this machine declares no agents";
        this.log(`cannot run ${body.taskId}: ${why}`);
        this.sendEnvelope(this.resultEnvelope(body.taskId, "failed", why, 0));
        return;
      }
      this.log(`accepting task ${body.taskId} for ${agent.name} on ${this.harnessForAgent(agent.id).name}: ${body.title}`);
      const workspace = resolveWorkspace({
        agentId: agent.id,
        folder: agent.folder ?? null,
        isolation: (agent.isolation ?? "shared") as Isolation,
        fallbackDir: join(this.opts.dataDir, "work", agent.id),
      });
      if (workspace.degradedReason) {
        this.log(`workspace degraded for ${agent.name}: ${workspace.degradedReason}`);
      }
      const cwd = workspace.cwd;
      mkdirSync(cwd, { recursive: true });
      const prompt = `${body.spec ?? body.title}\n\n${rememberInstruction()}`;
      this.taskTitle.set(body.taskId, body.title);
      this.taskAgent.set(body.taskId, agent.id);

      void this.recall(body.title, env.project, body.taskId).then((memories) => {
        if (this.closed) return;
        if (memories.length > 0) {
          this.log(`recalled ${memories.length} memor${memories.length === 1 ? "y" : "ies"} for ${body.taskId}`);
        }
        this.taskRunner.start(body.taskId, body.budget, cwd, withMemories(prompt, memories), {
          allowTools: agent.allowTools ?? DEFAULT_ALLOW_TOOLS,
          denyPaths: agent.denyPaths ?? DEFAULT_DENY_PATHS,
        }, agent.id);
      });
      return;
    }

    if (env.type === "task.status" && body.note === "resume-check") {
      if (this.taskRunner.has(body.taskId)) {
        this.log(`resume-check for ${body.taskId}: still running locally, heartbeats will resume`);
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

    if (env.type === "human.answer") {
      const taskId = body.askId ?? body.taskId;
      if (this.taskRunner.isAwaitingAnswer(taskId)) {
        this.log(`answer for ${taskId}: ${body.text}`);
        this.taskRunner.answer(taskId, String(body.text ?? ""));
        this.sendEnvelope(this.statusEnvelope(taskId, "working"));
      } else {
        this.log(`answer for ${taskId} arrived but nothing is waiting — ignoring`);
      }
      return;
    }

    if (env.type === "peer.directory") {
      this.peers = body.peers ?? [];
      return;
    }

    if (env.type === "delegate.request") {
      void handleDelegateRequest(this.opts, this.peers, env, body, {
        log: (m) => this.log(m),
        sendEnvelope: (e) => this.sendEnvelope(e),
      });
      return;
    }

    if (env.type === "delegate.result") {
      const pending = this.pendingDelegations.get(body.requestId);
      if (!pending) return;
      this.pendingDelegations.delete(body.requestId);
      let findings: string | null = null;
      if (body.sealed) {
        try {
          findings = openSealed(this.opts.identity.sealingPrivateKey, body.sealed, sealAad(env));
        } catch (err) {
          this.log(`delegate.result for ${body.requestId} failed to decrypt: ${(err as Error).message}`);
          pending.reject(new Error("sealed result failed to open"));
          return;
        }
      }
      if (!findings && !body.sealed && body.note) findings = String(body.note);
      this.log(`delegation ${body.requestId} came back ${body.state}`);
      pending.resolve({ state: body.state, findings });
      return;
    }

    if (env.type === "review.result") {
      const resolve = this.pendingReviews.get(body.requestId);
      if (!resolve) return;
      this.pendingReviews.delete(body.requestId);
      if (!body.sealed) {
        this.log(`review ${body.requestId} refused: ${body.note}`);
        resolve({ verdict: "rejected", findings: null, summary: String(body.note ?? "refused") });
        return;
      }
      try {
        const judgement = JSON.parse(
          openSealed(this.opts.identity.sealingPrivateKey, body.sealed, sealAad(env))
        );
        this.log(`review ${body.requestId}: ${judgement.verdict}`);
        resolve(judgement);
      } catch (err) {
        this.log(`review.result for ${body.requestId} failed to decrypt: ${(err as Error).message}`);
        resolve({ verdict: "changes_requested", findings: null, summary: "the review result failed to open" });
      }
      return;
    }

    if (env.type === "review.request") {
      void handleReviewRequest(this.opts, this.peers, this.harnessForAgent(null), env, body, {
        log: (m) => this.log(m),
        sendEnvelope: (e) => this.sendEnvelope(e),
      });
      return;
    }

    if (env.type === "context.share") {
      void handleContextShare(this.opts, env, body, {
        log: (m) => this.log(m),
        sendEnvelope: (e) => this.sendEnvelope(e),
      });
      return;
    }

    if (env.type === "context.ack") {
      const resolve = this.pendingShares.get(body.shareId);
      if (resolve) {
        this.pendingShares.delete(body.shareId);
        resolve();
      }
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

    if (env.type === "agent.create") {
      handleAgentCreate(this.opts, this.createdAgents, env, body, {
        log: (m) => this.log(m),
        agentById: (id) => this.agentById(id),
        publishCard: (a) => this.publishCard(a),
        sendEnvelope: (e) => this.sendEnvelope(e),
      });
      return;
    }

    if (env.type === "agent.patch") {
      handleAgentPatch(this.opts, this.createdAgents, env, body, {
        log: (m) => this.log(m),
        agentById: (id) => this.agentById(id),
        publishCard: (a) => this.publishCard(a),
      });
      return;
    }

    if (env.type === "agent.git") {
      handleAgentGit(this.opts, env, body, {
        agentById: (id) => this.agentById(id),
        sendEnvelope: (e) => this.sendEnvelope(e),
      });
      return;
    }
  }

  private agentById(id: string | null | undefined): AgentDecl | undefined {
    return id ? this.opts.agents.find((a) => a.id === id) : undefined;
  }

  private harnessForAgent(agentId: string | null): AgentHarness {
    const agent = this.agentById(agentId);
    if (!agent?.provider) return this.opts.harness;
    const key = `${agent.provider}:${agent.model ?? ""}:${agent.bypassPermissions ? "bypass" : "policy"}`;
    let h = this.harnessCache.get(key);
    if (!h) {
      h = makePtyHarness({
        provider: agent.provider,
        model: agent.model ?? null,
        allowUnsandboxed: this.opts.allowUnsandboxed,
        bypassPermissions: agent.bypassPermissions,
      });
      this.harnessCache.set(key, h);
    }
    return h;
  }

  peerList(): PeerEntry[] {
    return this.peers;
  }

  delegate(opts: {
    capability: string;
    targetAgentId: string;
    inputs: Record<string, unknown>;
    acceptance?: string | null;
    budget?: { seconds: number; usd: number };
    summary?: string | null;
  }): Promise<{ state: string; findings: string | null }> {
    const agent = this.opts.agents[0];
    const peer = this.peers.find((p) => p.agentId === opts.targetAgentId);
    if (!agent) return Promise.reject(new Error("no local agent to delegate from"));
    if (!peer) return Promise.reject(new Error(`unknown peer ${opts.targetAgentId}`));
    if (!peer.sealingPubkey) return Promise.reject(new Error(`peer ${peer.agentName} has published no sealing key`));

    const requestId = crypto.randomUUID();
    const project = agent.projects[0];
    const envId = crypto.randomUUID();
    const to = { kind: "agent" as const, id: opts.targetAgentId };
    const from = { kind: "agent" as const, id: agent.id };

    const sealed = seal(
      peer.sealingPubkey,
      JSON.stringify({ inputs: opts.inputs, acceptance: opts.acceptance ?? null }),
      sealAad({ id: envId, type: "delegate.request", project, from, to })
    );

    const promise = new Promise<{ state: string; findings: string | null }>((resolve, reject) => {
      this.pendingDelegations.set(requestId, { resolve, reject });
    });

    this.sendEnvelope({
      v: 1, id: envId, type: "delegate.request", project, from, to,
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: {
        requestId, capability: opts.capability,
        targetAgentId: opts.targetAgentId, targetNodeId: peer.machineId,
        projectId: project, budget: opts.budget ?? { seconds: 120, usd: 1 },
        sealed,
        summary: opts.summary ?? null,
      },
    } as EnvelopeT);

    this.log(`delegated ${opts.capability} to ${peer.agentName}@${peer.machineName} (sealed)`);
    return promise;
  }

  requestReview(opts: {
    targetAgentId: string;
    subject: { kind: "pr" | "issue" | "diff" | "artifact"; ref: string };
    criteria: string[];
    depth?: "quick" | "thorough";
    budget?: { seconds: number; usd: number };
    summary?: string | null;
  }): Promise<{ verdict: string; findings: unknown; summary: string }> {
    const agent = this.opts.agents[0];
    const peer = this.peers.find((p) => p.agentId === opts.targetAgentId);
    if (!agent) return Promise.reject(new Error("no local agent to ask from"));
    if (!peer) return Promise.reject(new Error(`unknown peer ${opts.targetAgentId}`));
    if (!peer.sealingPubkey) return Promise.reject(new Error(`peer ${peer.agentName} has published no sealing key`));

    const requestId = crypto.randomUUID();
    const project = agent.projects[0];
    const envId = crypto.randomUUID();
    const to = { kind: "agent" as const, id: opts.targetAgentId };
    const from = { kind: "agent" as const, id: agent.id };

    const sealed = seal(
      peer.sealingPubkey,
      JSON.stringify({ subject: opts.subject, criteria: opts.criteria, depth: opts.depth ?? "quick" }),
      sealAad({ id: envId, type: "review.request", project, from, to })
    );

    const promise = new Promise<{ verdict: string; findings: unknown; summary: string }>((resolve) => {
      this.pendingReviews.set(requestId, resolve);
    });

    this.sendEnvelope({
      v: 1, id: envId, type: "review.request", project, from, to,
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: {
        requestId, toAgentId: opts.targetAgentId,
        budget: opts.budget ?? { seconds: 600, usd: 1.5 },
        sealed, summary: opts.summary ?? null,
      },
    } as EnvelopeT);

    this.log(`asked ${peer.agentName} for a ${opts.depth ?? "quick"} review (${requestId.slice(0, 8)})`);
    return promise;
  }

  async shareContext(opts: {
    targetAgentId: string;
    kind: "decision" | "file_excerpt" | "repo_state" | "finding" | "constraint";
    title: string;
    body: string;
    refs?: string[];
    ttlDays?: number;
    summary?: string | null;
  }): Promise<void> {
    const agent = this.opts.agents[0];
    const peer = this.peers.find((p) => p.agentId === opts.targetAgentId);
    if (!agent) throw new Error("no local agent to share from");
    if (!peer) throw new Error(`unknown peer ${opts.targetAgentId}`);
    if (!peer.sealingPubkey) throw new Error(`peer ${peer.agentName} has published no sealing key`);

    const shareId = crypto.randomUUID();
    const project = agent.projects[0];
    const envId = crypto.randomUUID();
    const to = { kind: "agent" as const, id: opts.targetAgentId };
    const from = { kind: "agent" as const, id: agent.id };

    const sealed = seal(
      peer.sealingPubkey,
      JSON.stringify({ body: opts.body }),
      sealAad({ id: envId, type: "context.share", project, from, to })
    );

    const done = new Promise<void>((resolve) => this.pendingShares.set(shareId, resolve));

    this.sendEnvelope({
      v: 1, id: envId, type: "context.share", project, from, to,
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: {
        shareId, toAgentId: opts.targetAgentId, kind: opts.kind,
        title: opts.title, refs: opts.refs ?? [], ttlDays: opts.ttlDays ?? 7,
        sealed, summary: opts.summary ?? null,
      },
    } as EnvelopeT);

    this.log(`shared "${opts.title}" with ${peer.agentName} (sealed)`);
    return done;
  }

  recallSharedContext(query: string): Array<{ title: string; text: string; from: string }> {
    return recallSharedContext(this.opts.dataDir, query);
  }

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

  private rememberOutcome(taskId: string, state: string, reason: string | null) {
    const title = this.taskTitle.get(taskId);
    this.taskTitle.delete(taskId);
    this.taskAgent.delete(taskId);
    if (!title) return;
    const text =
      state === "completed"
        ? `Completed: ${title}`
        : `Failed: ${title}${reason ? ` — ${reason}` : ""}`;
    this.writeMemory("outcome", text, taskId);
  }

  private writeMemory(kind: string, text: string, sourceTaskId: string | null) {
    const named = sourceTaskId ? this.agentById(this.taskAgent.get(sourceTaskId) ?? "") : undefined;
    const agent = named ?? this.opts.agents[0];
    const project = this.taskProject.get(sourceTaskId ?? "") ?? agent?.projects[0];
    if (!agent || !project) return;
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
    const intervalMs = Math.max(500, (leaseSeconds * 1000) / 4);
    this.heartbeatTimer = setInterval(() => {
      for (const taskId of this.taskRunner.activeIds()) {
        const state = this.taskRunner.isAwaitingAnswer(taskId) ? "input-required" : "working";
        this.sendEnvelope(this.statusEnvelope(taskId, state));
      }
    }, intervalMs);
  }

  private sendEnvelope(env: EnvelopeT) {
    if (this.closed) return;
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
    } else {
      this.outbox.push(env);
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
    for (const a of this.opts.agents) this.publishCard(a);
  }

  private publishCard(a: AgentDecl) {
    const env: EnvelopeT = {
      v: 1, id: crypto.randomUUID(), type: "agent.card",
      project: a.projects[0] ?? "",
      from: { kind: "node", id: this.opts.identity.machineId },
      to: { kind: "node", id: this.opts.identity.machineId },
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: {
        id: a.id, name: a.name, ownerId: this.opts.ownerId,
        machineId: this.opts.identity.machineId, role: a.role,
        capabilities: a.capabilities, harness: a.provider ?? "fake-worker",
        projects: a.projects, concurrency: a.concurrency ?? 1, status: "idle",
        character: a.character ?? null, color: a.color ?? null,
        folder: a.folder ?? null, isolation: a.isolation ?? null,
        description: a.description ?? null, goal: a.goal ?? null,
      },
    };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
  }

  private acceptEnvelope(taskId: string, project: string): EnvelopeT {
    return this.envelope("task.accept", taskId, project, { taskId });
  }
  private statusEnvelope(taskId: string, state: "working" | "input-required" = "working"): EnvelopeT {
    const project = this.taskProject.get(taskId) ?? "";
    return this.envelope("task.status", taskId, project, {
      taskId,
      state,
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
      to: { kind: "node", id: this.opts.identity.machineId },
      task: taskId,
      idem: crypto.randomUUID(),
      ts: new Date().toISOString(),
      body: { ...body, ...extra },
    };
  }
}
