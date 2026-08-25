// The runner's side of the wire: authenticate, accept offers, heartbeat,
// and — the whole point — survive the socket dying without losing or
// duplicating anything. See SYSTEM.md §3b-§3d and DECISIONS.md D20.
import WebSocket from "ws";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { open as openSealed, seal, sealAad, type EnvelopeT } from "@logbridge/protocol";
import type { Identity } from "./identity.js";
import type { AgentHarness } from "./harness/types.js";
import { makePtyHarness } from "./harness/ptyHarness.js";
import { detectInstalled, providerById, rememberInstruction } from "./harness/providers.js";
import { resolveWorkspace, type Isolation } from "./workspace.js";
import { Outbox } from "./outbox.js";
import { loadCreatedAgents, saveCreatedAgents } from "./createdAgents.js";
import { TaskRunner } from "./taskRunner.js";

const DEFAULT_ALLOW_TOOLS = ["Read", "Write", "Bash"];
const DEFAULT_DENY_PATHS = [".env*", "**/secrets/**", "~/.ssh/**"];

/** Installed providers, in the shape the contract's MachineView.providers
 *  expects — computed from this machine's own registry, so the browser never
 *  guesses what a machine can run. */
function installedProviderSpecs() {
  return detectInstalled()
    .filter((p) => p.installed)
    .map((p) => ({ id: p.id, label: p.label, policy: p.policy, verified: p.verified, models: p.models }));
}

// How long to wait for the server's memory.result before starting anyway.
// Memory makes an agent better informed; it must never be what stops it
// working. A slow or lost recall degrades to "no memory", never to a hang.
const RECALL_TIMEOUT_MS = 2000;

export interface PeerEntry {
  agentId: string;
  agentName: string;
  machineId: string;
  machineName: string;
  ownerName: string;
  capabilities: string[];
  online: boolean;
  sealingPubkey: string | null;
}

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
  /** Which CLI this agent runs on (see PROVIDERS.md). Undefined = the
   *  runner's default harness, which is what a single-agent machine uses. */
  provider?: string;
  model?: string | null;

  // Identity, chosen in the browser's Add Agent wizard and persisted here so
  // it survives a restart. All optional — an agent declared in local config
  // has none of it and works exactly as before.
  /** Sprite the office draws for this agent. */
  character?: string | null;
  /** Accent colour, hex. */
  color?: string | null;
  /** The repo or folder this agent works in. Also how the roster groups. */
  folder?: string | null;
  /** How its workspace is isolated from other agents. See WORKSPACE.md. */
  isolation?: "shared" | "worktree" | "copy" | null;
  /** One line: what this agent is. */
  description?: string | null;
  /** Its standing objective. */
  goal?: string | null;
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
  /** Whether this machine will execute work delegated by other machines.
   *  Off by default — see handleDelegateRequest and SYSTEM.md §7. */
  acceptDelegations?: boolean;
  /** Whether agents may be created from the browser on this machine. Off by
   *  default — this is the message that lets a remote UI start a real CLI
   *  here, so it gets the same gate as delegations. See D1/D3. */
  allowAgentCreation?: boolean;
  /** Passed to per-agent harnesses — see PROVIDERS.md. */
  allowUnsandboxed?: boolean;
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
  private taskAgent = new Map<string, string>();   // taskId -> the agent running it — memory attribution
  private pendingRecalls = new Map<string, (memories: RecalledMemory[]) => void>();
  private peers: PeerEntry[] = [];
  /** One harness per agent, built lazily and cached — spawning is cheap but
   *  the provider lookup and config shouldn't repeat per task. */
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
    // Anything created earlier is already in opts.agents (cli.ts merges it in
    // at startup); this is the writable list we append to and persist.
    this.createdAgents = loadCreatedAgents(opts.dataDir, this.log);
    this.taskRunner = new TaskRunner(
      (agentId) => this.harnessForAgent(agentId),
      (taskId, summary, data) => this.sendEnvelope(this.eventEnvelope(taskId, summary, data)),
      (taskId, state, reason, costUsd) => {
        this.sendEnvelope(this.resultEnvelope(taskId, state, reason, costUsd));
        this.rememberOutcome(taskId, state, reason);
      },
      (taskId, _questionId, question) => {
        // Tell the server two ways: the task moved to input-required (drives
        // zones/leases), and there is a question for a human inbox.
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
        // Reported as a count. The UI shows "step 3", never "60%" — the
        // denominator does not exist.
        this.sendEnvelope(this.eventEnvelope(taskId, note ?? `step ${steps}`, { steps }));
      },
      (taskId, kind, text) => {
        // The agent declared this worth keeping. Same channel as an outcome
        // memory, but the agent chose it rather than the runner inferring it.
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
          // Published so other machines can seal payloads to this one. The
          // matching private key never leaves this process. See SEALED.md.
          sealingPubkey: this.opts.identity.sealingPublicKeyB64,
          // What this machine can and will do — the browser renders it, the
          // runner enforces it. Sent every connect because the flags are
          // CLI/runtime state that changes between restarts.
          providers: installedProviderSpecs(),
          allowAgentCreation: Boolean(this.opts.allowAgentCreation),
          allowUnsandboxed: Boolean(this.opts.allowUnsandboxed),
          // Published so the server can refuse delegations to this machine
          // BEFORE holding one for consent — approving work the machine would
          // refuse anyway is just noise.
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
      this.sendEnvelope(this.acceptEnvelope(body.taskId, env.project));

      // task.offer names its target agent (protocol 1.11). Falling back to
      // the first declared agent keeps a single-agent runner working against
      // an older server that doesn't send the field.
      // Falling back is only correct when the server didn't NAME an agent
      // (an older server, protocol < 1.11). If it named one this machine
      // doesn't have, running it on agents[0] would silently execute the work
      // under a different provider and a different tool policy — refuse.
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
      // The REMEMBER convention rides in the prompt: the parsers turn a
      // matching line into a memory.write. One line, skipped when nothing
      // was learned — memory is opt-in by the agent, never a form to fill.
      const prompt = `${body.spec ?? body.title}\n\n${rememberInstruction()}`;
      this.taskTitle.set(body.taskId, body.title);
      this.taskAgent.set(body.taskId, agent.id);

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
          allowTools: agent.allowTools ?? DEFAULT_ALLOW_TOOLS,
          denyPaths: agent.denyPaths ?? DEFAULT_DENY_PATHS,
        }, agent.id);
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

    // A human answered a mid-task question. Deliver it and restart the clock.
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

    // ---- cross-machine delegation, end-to-end sealed (SEALED.md) ----
    if (env.type === "peer.directory") {
      this.peers = body.peers ?? [];
      return;
    }

    if (env.type === "delegate.request") {
      void this.handleDelegateRequest(env, body);
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
          // A payload that won't open is a real failure, not something to
          // paper over — the server may have tampered, or keys rotated.
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

    // ---- reviews (D15): a judgement returns, sealed like any finding ----
    if (env.type === "review.result") {
      const resolve = this.pendingReviews.get(body.requestId);
      if (!resolve) return;
      this.pendingReviews.delete(body.requestId);
      if (!body.sealed) {
        // Server-generated refusal — the reason rides in plaintext `note`.
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

    // ---- incoming review request ----
    if (env.type === "review.request") {
      void this.handleReviewRequest(env, body);
      return;
    }

    // ---- incoming shared context ----
    if (env.type === "context.share") {
      void this.handleContextShare(env, body);
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

    // ---- runtime agent creation ----
    if (env.type === "agent.create") {
      this.handleAgentCreate(env, body);
      return;
    }
  }

  private agentById(id: string | null | undefined): AgentDecl | undefined {
    return id ? this.opts.agents.find((a) => a.id === id) : undefined;
  }

  /**
   * The harness an agent runs on. An agent that names a provider gets its own;
   * everything else falls back to the runner-wide default, so a single-agent
   * machine and every existing test behave exactly as before.
   */
  private harnessForAgent(agentId: string | null): AgentHarness {
    const agent = this.agentById(agentId);
    if (!agent?.provider) return this.opts.harness;
    const key = `${agent.provider}:${agent.model ?? ""}`;
    let h = this.harnessCache.get(key);
    if (!h) {
      h = makePtyHarness({
        provider: agent.provider,
        model: agent.model ?? null,
        allowUnsandboxed: this.opts.allowUnsandboxed,
      });
      this.harnessCache.set(key, h);
    }
    return h;
  }

  // ---- cross-machine delegation (SEALED.md) ----

  /** Who this machine can currently seal a message to. */
  peerList(): PeerEntry[] {
    return this.peers;
  }

  /**
   * Ask another machine's agent to do something, with the payload sealed so
   * only that machine can read it. Resolves when the result comes back.
   */
  delegate(opts: {
    capability: string;
    targetAgentId: string;
    inputs: Record<string, unknown>;
    acceptance?: string | null;
    budget?: { seconds: number; usd: number };
    /** Requester-authored plaintext describing the intent, shown to the
     *  target machine's owner when consent is asked. NOT the payload —
     *  inputs/acceptance stay sealed. See SEALED.md's trade-off note. */
    summary?: string | null;
  }): Promise<{ state: string; findings: string | null }> {
    const agent = this.opts.agents[0];
    const peer = this.peers.find((p) => p.agentId === opts.targetAgentId);
    if (!agent) return Promise.reject(new Error("no local agent to delegate from"));
    if (!peer) return Promise.reject(new Error(`unknown peer ${opts.targetAgentId}`));
    // Refusing is the right move: falling back to plaintext because the
    // recipient has no key would silently downgrade the security property
    // the caller asked for.
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

  private async handleDelegateRequest(env: EnvelopeT, body: any) {
    const agent = this.opts.agents[0];
    if (!agent) return;

    // The machine owner decides whether this machine executes other people's
    // work at all (SYSTEM.md §7). Default is off: silently running a
    // stranger's payload because it arrived would defeat D1/D3 entirely.
    if (!this.opts.acceptDelegations) {
      this.log(`refused delegation ${body.requestId}: this machine does not accept delegated work`);
      this.sendDelegateResult(env, body.requestId, "failed", "delegation not accepted on this machine");
      return;
    }

    let payload: { inputs?: Record<string, unknown>; acceptance?: string | null };
    try {
      payload = JSON.parse(openSealed(this.opts.identity.sealingPrivateKey, body.sealed, sealAad(env)));
    } catch (err) {
      this.log(`delegation ${body.requestId} failed to decrypt: ${(err as Error).message}`);
      this.sendDelegateResult(env, body.requestId, "failed", "sealed payload failed to open");
      return;
    }

    this.log(`accepted delegation ${body.requestId}: ${body.capability}`);
    const workspace = resolveWorkspace({
      agentId: agent.id,
      folder: (agent as any).folder ?? null,
      isolation: ((agent as any).isolation ?? "shared") as Isolation,
      fallbackDir: join(this.opts.dataDir, "work", agent.id),
    });
    if (workspace.degradedReason) {
      this.log(`workspace degraded for ${agent.name}: ${workspace.degradedReason}`);
    }
    const cwd = workspace.cwd;
    mkdirSync(cwd, { recursive: true });
    const prompt = String(payload.inputs?.prompt ?? body.capability);

    const handle = this.opts.harness.spawn({
      cwd, prompt,
      allowTools: agent.allowTools ?? DEFAULT_ALLOW_TOOLS,
      denyPaths: agent.denyPaths ?? DEFAULT_DENY_PATHS,
      maxSeconds: body.budget?.seconds ?? 120,
      maxUsd: body.budget?.usd ?? 1,
    });

    const output: string[] = [];
    let ok = true;
    for await (const ev of handle.events) {
      if (ev.kind === "output") output.push(ev.text);
      else if (ev.kind === "error") { ok = false; output.push(ev.message); }
      else if (ev.kind === "done") ok = ev.ok;
    }
    this.sendDelegateResult(env, body.requestId, ok ? "completed" : "failed", output.join("\n").slice(0, 4000));
  }

  // ---- runtime agent creation ----

  /**
   * The browser asked to add an agent on THIS machine. Three gates, all
   * enforced here rather than in the UI — the dialog greying something out
   * is a courtesy; this method is the enforcement (D3):
   *   1. the machine opted into creation at all (--allow-agent-creation)
   *   2. the provider exists and is actually installed on this machine
   *   3. a provider with no enforceable tool policy is refused unless the
   *      owner accepted unsandboxed runs — same rule ptyHarness applies at
   *      spawn time, so an agent that would refuse every task is never born
   */
  private handleAgentCreate(env: EnvelopeT, body: any) {
    const requestId = body.requestId;
    const refuse = (error: string) => {
      this.log(`refused agent.create "${body.name}": ${error}`);
      this.sendEnvelope({
        v: 1, id: crypto.randomUUID(), type: "agent.create.result", project: env.project,
        from: { kind: "node", id: this.opts.identity.machineId },
        to: { kind: "node", id: this.opts.identity.machineId },
        task: null, idem: null, ts: new Date().toISOString(),
        body: { requestId, ok: false, agentId: null, error },
      } as EnvelopeT);
    };

    if (!this.opts.allowAgentCreation) {
      refuse("this machine does not accept agent creation (owner has not enabled it)");
      return;
    }

    if (body.provider) {
      const spec = providerById(body.provider);
      if (!spec) {
        refuse(`unknown provider "${body.provider}"`);
        return;
      }
      if (!detectInstalled().some((p) => p.id === spec.id && p.installed)) {
        refuse(`provider "${spec.label}" is not installed on this machine`);
        return;
      }
      if (spec.policy === "none" && !this.opts.allowUnsandboxed) {
        refuse(
          `provider "${spec.label}" cannot enforce allowTools/denyPaths on this machine — ` +
          "every task would be refused. Enable --allow-unsandboxed if you accept that."
        );
        return;
      }
    }

    // A stable, collision-free id even if two agents share a name.
    const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    let id = `agt_${this.opts.identity.machineId}_${slug}`;
    while (this.agentById(id)) id = `${id}_${crypto.randomUUID().slice(0, 4)}`;

    const cwd = body.cwd ?? join(this.opts.dataDir, "work", id);
    mkdirSync(cwd, { recursive: true });

    const decl: AgentDecl = {
      id,
      name: body.name,
      role: body.role ?? "developer",
      capabilities: body.capabilities ?? [],
      projects: [body.projectId],
      cwd,
      allowTools: body.allowTools?.length ? body.allowTools : undefined,
      denyPaths: body.denyPaths?.length ? body.denyPaths : undefined,
      provider: body.provider ?? undefined,
      model: body.model ?? null,
      character: body.character ?? null,
      color: body.color ?? null,
      // `folder` is what the agent works in; `cwd` above is where the harness
      // is told to run. They differ once workspace isolation resolves a
      // worktree from the folder — see WORKSPACE.md.
      folder: body.folder ?? null,
      isolation: body.isolation ?? null,
      description: body.description ?? null,
      goal: body.goal ?? null,
    };
    this.opts.agents.push(decl);
    // Survive a restart. Without this the server keeps the agent row while
    // the runner forgets it — see createdAgents.ts.
    this.createdAgents.push(decl);
    saveCreatedAgents(this.opts.dataDir, this.createdAgents, this.log);

    // Announce it now — no restart, no waiting for a reconnect. The card is
    // what makes it appear in the office and what makes the orchestrator
    // consider it capacity (the server's agent.card handler runs both).
    this.publishCard(decl);
    this.log(`created agent ${decl.name} (${decl.provider ?? "default harness"}) from browser request`);

    this.sendEnvelope({
      v: 1, id: crypto.randomUUID(), type: "agent.create.result", project: env.project,
      from: { kind: "node", id: this.opts.identity.machineId },
      to: { kind: "node", id: this.opts.identity.machineId },
      task: null, idem: null, ts: new Date().toISOString(),
      body: { requestId, ok: true, agentId: id, error: null },
    } as EnvelopeT);
  }

  /** Seal the findings back to whoever asked. */
  private sendDelegateResult(reqEnv: EnvelopeT, requestId: string, state: string, findings: string) {
    const agent = this.opts.agents[0];
    if (!agent) return;
    const requesterId = reqEnv.from.id;
    const peer = this.peers.find((p) => p.agentId === requesterId);
    const envId = crypto.randomUUID();
    const to = { kind: "agent" as const, id: requesterId };
    const from = { kind: "agent" as const, id: agent.id };

    const sealed = peer?.sealingPubkey
      ? seal(peer.sealingPubkey, findings, sealAad({ id: envId, type: "delegate.result", project: reqEnv.project, from, to }))
      : null;

    this.sendEnvelope({
      v: 1, id: envId, type: "delegate.result", project: reqEnv.project, from, to,
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: { requestId, taskId: reqEnv.task ?? requestId, state, verified: false, sealed },
    } as EnvelopeT);
  }

  // ---- reviews and shared context (prompt 6, D15) ----

  /**
   * Ask another machine's agent to REVIEW something — a judgement comes
   * back, not work. Subject + criteria travel sealed; the verdict returns
   * sealed to us. Deliberately a separate method from delegate(): a review
   * is not a delegation with extra steps (D15).
   */
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

  private async handleReviewRequest(env: EnvelopeT, body: any) {
    const agent = this.opts.agents[0];
    // Same outer gate as delegations: reviews make this machine spend its
    // own resources on someone else's question.
    if (!this.opts.acceptDelegations) {
      this.log(`refused review ${body.requestId}: this machine does not accept outside requests`);
      this.sendReviewResult(env, body.requestId, { verdict: "rejected", summary: "machine does not accept review requests" });
      return;
    }

    let payload: { subject?: any; criteria?: string[]; depth?: string };
    try {
      payload = JSON.parse(openSealed(this.opts.identity.sealingPrivateKey, body.sealed, sealAad(env)));
    } catch (err) {
      this.log(`review.request ${body.requestId} failed to decrypt: ${(err as Error).message}`);
      this.sendReviewResult(env, body.requestId, { verdict: "rejected", summary: "sealed payload failed to open" });
      return;
    }

    this.log(`reviewing for ${env.from.id}: ${payload.subject?.ref}`);
    const cwd = join(this.opts.dataDir, "work", "reviews");
    mkdirSync(cwd, { recursive: true });
    const prompt = [
      `REVIEW REQUEST (${payload.depth ?? "quick"}):`,
      `Subject: ${JSON.stringify(payload.subject ?? {})}`,
      `Judge against these criteria:`,
      ...(payload.criteria ?? []).map((c) => `- ${c}`),
    ].join("\n");

    const handle = this.harnessForAgent(null).spawn({
      cwd, prompt,
      allowTools: ["Read"],
      denyPaths: DEFAULT_DENY_PATHS,
      maxSeconds: body.budget?.seconds ?? 600,
      maxUsd: body.budget?.usd ?? 1.5,
    });

    const output: string[] = [];
    let ok = true;
    for await (const ev of handle.events) {
      if (ev.kind === "output") output.push(ev.text);
      else if (ev.kind === "error") { ok = false; output.push(ev.message); }
      else if (ev.kind === "done") ok = ev.ok;
    }
    // Honest mapping of free-text CLI output onto the three-verdict shape:
    // a run that finished is "approved with notes"; one that errored is a
    // rejection carrying why. Real structured verdicts need a harness that
    // emits them — no pretending today's CLIs do.
    const summary = output.join("\n").slice(0, 2000);
    this.sendReviewResult(env, body.requestId, ok
      ? { verdict: "approved", summary }
      : { verdict: "changes_requested", summary });
  }

  /** Seal the judgement back to WHOEVER ASKED — that's env.from, not env.to
   *  (the request was addressed *to* us; the reply goes the other way). */
  private sendReviewResult(reqEnv: EnvelopeT, requestId: string, judgement: { verdict: string; summary: string }) {
    const agent = this.opts.agents[0];
    if (!agent) return;
    const peer = this.peers.find((p) => p.agentId === reqEnv.from.id);
    const envId = crypto.randomUUID();
    const from = { kind: "agent" as const, id: agent.id };
    const to = { kind: "agent" as const, id: reqEnv.from.id };

    const sealed = peer?.sealingPubkey
      ? seal(peer.sealingPubkey, JSON.stringify({
          verdict: judgement.verdict,
          findings: [],
          summary: judgement.summary,
          confidence: "low",
        }), sealAad({ id: envId, type: "review.result", project: reqEnv.project, from, to }))
      : null;

    this.sendEnvelope({
      v: 1, id: envId, type: "review.result", project: reqEnv.project, from, to,
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: { requestId, taskId: null, state: sealed ? "completed" : "failed", verified: false, sealed },
    } as EnvelopeT);
  }

  /**
   * Share context with another machine's agent. The body is content and is
   * sealed; the receiving side stores it LOCALLY and never re-uploads it —
   * putting it in server-side team memory would hand the server what the
   * sealing just kept from it.
   */
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

  private async handleContextShare(env: EnvelopeT, body: any) {
    const agent = this.opts.agents[0];
    if (!this.opts.acceptDelegations) {
      this.log(`refused shared context "${body.title}": machine does not accept outside requests`);
      this.sendContextAck(env, body.shareId, false);
      return;
    }

    let payload: { body?: string };
    try {
      payload = JSON.parse(openSealed(this.opts.identity.sealingPrivateKey, body.sealed, sealAad(env)));
    } catch (err) {
      this.log(`context.share "${body.title}" failed to decrypt: ${(err as Error).message}`);
      this.sendContextAck(env, body.shareId, false);
      return;
    }

    // Stored locally only. The server saw the title, never the body.
    mkdirSync(this.opts.dataDir, { recursive: true });
    const line = JSON.stringify({
      receivedAt: new Date().toISOString(),
      from: env.from.id,
      kind: body.kind,
      title: body.title,
      text: payload.body ?? "",
      expiresAt: new Date(Date.now() + (body.ttlDays ?? 7) * 86_400_000).toISOString(),
    }) + "\n";
    appendFileSync(join(this.opts.dataDir, "shared-context.jsonl"), line);

    this.log(`received context "${body.title}" from ${env.from.id} — stored locally`);
    this.sendContextAck(env, body.shareId, true);
  }

  /** Recall locally-stored shared context whose text matches the query.
   *  Merged into the pre-task prompt by the caller alongside server memories. */
  recallSharedContext(query: string): Array<{ title: string; text: string; from: string }> {
    const file = join(this.opts.dataDir, "shared-context.jsonl");
    if (!existsSync(file)) return [];
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const now = Date.now();
    const out: Array<{ title: string; text: string; from: string }> = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (Date.parse(item.expiresAt) < now) continue;
        const hay = `${item.title} ${item.text}`.toLowerCase();
        if (words.some((w) => hay.includes(w))) {
          out.push({ title: item.title, text: item.text, from: item.from });
        }
      } catch { /* skip malformed lines */ }
    }
    return out;
  }

  private sendContextAck(env: EnvelopeT, shareId: string, accepted: boolean) {
    const envId = crypto.randomUUID();
    this.sendEnvelope({
      v: 1, id: envId, type: "context.ack", project: env.project,
      from: { kind: "agent", id: this.opts.agents[0]?.id ?? "unknown" },
      // Replies go back to whoever sent the request — same rule as results.
      to: { kind: "agent", id: env.from.id },
      task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
      body: { shareId, accepted },
    } as EnvelopeT);
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
    this.taskAgent.delete(taskId);
    if (!title) return;
    const text =
      state === "completed"
        ? `Completed: ${title}`
        : `Failed: ${title}${reason ? ` — ${reason}` : ""}`;
    this.writeMemory("outcome", text, taskId);
  }

  private writeMemory(kind: string, text: string, sourceTaskId: string | null) {
    // Attributed to the agent that actually ran the task. Using agents[0]
    // here — as this did — credited every memory on a multi-agent machine to
    // whichever agent happened to be declared first, so shared memory showed
    // the wrong teammate's name against a fact they never learned.
    const named = sourceTaskId ? this.agentById(this.taskAgent.get(sourceTaskId) ?? "") : undefined;
    const agent = named ?? this.opts.agents[0];
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
        // A task paused on a human question must keep reporting input-required —
        // heartbeating "working" here would silently unblock it server-side.
        const state = this.taskRunner.isAwaitingAnswer(taskId) ? "input-required" : "working";
        this.sendEnvelope(this.statusEnvelope(taskId, state));
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
        // The machine owner declares identity, so the card carries it and the
        // server overwrites. `note` is not here — a human types that in the
        // browser and a reconnect must not wipe it.
        character: a.character ?? null, color: a.color ?? null,
        folder: a.folder ?? null, isolation: a.isolation ?? null,
        description: a.description ?? null, goal: a.goal ?? null,
      },
    };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
  }

  // ---- envelope builders ----
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

