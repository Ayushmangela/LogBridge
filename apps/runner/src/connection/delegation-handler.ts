import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { open as openSealed, seal, sealAad, type EnvelopeT } from "@logbridge/protocol";
import { resolveWorkspace, type Isolation } from "../workspace.js";
import type { AgentHarness } from "../harness/types.js";
import { DEFAULT_ALLOW_TOOLS, DEFAULT_DENY_PATHS, type PeerEntry, type RunnerOptions } from "./types.js";

export async function handleDelegateRequest(
  opts: RunnerOptions,
  peers: PeerEntry[],
  env: EnvelopeT,
  body: any,
  helpers: {
    log: (msg: string) => void;
    sendEnvelope: (env: EnvelopeT) => void;
  }
) {
  const agent = opts.agents[0];
  if (!agent) return;

  if (!opts.acceptDelegations) {
    helpers.log(`refused delegation ${body.requestId}: this machine does not accept delegated work`);
    sendDelegateResult(opts, peers, helpers.sendEnvelope, env, body.requestId, "failed", "delegation not accepted on this machine");
    return;
  }

  let payload: { inputs?: Record<string, unknown>; acceptance?: string | null };
  try {
    payload = JSON.parse(openSealed(opts.identity.sealingPrivateKey, body.sealed, sealAad(env)));
  } catch (err) {
    helpers.log(`delegation ${body.requestId} failed to decrypt: ${(err as Error).message}`);
    sendDelegateResult(opts, peers, helpers.sendEnvelope, env, body.requestId, "failed", "sealed payload failed to open");
    return;
  }

  helpers.log(`accepted delegation ${body.requestId}: ${body.capability}`);
  const workspace = resolveWorkspace({
    agentId: agent.id,
    folder: (agent as any).folder ?? null,
    isolation: ((agent as any).isolation ?? "shared") as Isolation,
    fallbackDir: join(opts.dataDir, "work", agent.id),
  });
  if (workspace.degradedReason) {
    helpers.log(`workspace degraded for ${agent.name}: ${workspace.degradedReason}`);
  }
  const cwd = workspace.cwd;
  mkdirSync(cwd, { recursive: true });
  const prompt = String(payload.inputs?.prompt ?? body.capability);

  const handle = opts.harness.spawn({
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
  sendDelegateResult(opts, peers, helpers.sendEnvelope, env, body.requestId, ok ? "completed" : "failed", output.join("\n").slice(0, 4000));
}

export function sendDelegateResult(
  opts: RunnerOptions,
  peers: PeerEntry[],
  sendEnvelope: (env: EnvelopeT) => void,
  reqEnv: EnvelopeT,
  requestId: string,
  state: string,
  findings: string
) {
  const agent = opts.agents[0];
  if (!agent) return;
  const requesterId = reqEnv.from.id;
  const peer = peers.find((p) => p.agentId === requesterId);
  const envId = crypto.randomUUID();
  const to = { kind: "agent" as const, id: requesterId };
  const from = { kind: "agent" as const, id: agent.id };

  const sealed = peer?.sealingPubkey
    ? seal(peer.sealingPubkey, findings, sealAad({ id: envId, type: "delegate.result", project: reqEnv.project, from, to }))
    : null;

  sendEnvelope({
    v: 1, id: envId, type: "delegate.result", project: reqEnv.project, from, to,
    task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: { requestId, taskId: reqEnv.task ?? requestId, state, verified: false, sealed },
  } as EnvelopeT);
}

export async function handleReviewRequest(
  opts: RunnerOptions,
  peers: PeerEntry[],
  harness: AgentHarness,
  env: EnvelopeT,
  body: any,
  helpers: {
    log: (msg: string) => void;
    sendEnvelope: (env: EnvelopeT) => void;
  }
) {
  const agent = opts.agents[0];
  if (!opts.acceptDelegations) {
    helpers.log(`refused review ${body.requestId}: this machine does not accept outside requests`);
    sendReviewResult(opts, peers, helpers.sendEnvelope, env, body.requestId, { verdict: "rejected", summary: "machine does not accept review requests" });
    return;
  }

  let payload: { subject?: any; criteria?: string[]; depth?: string };
  try {
    payload = JSON.parse(openSealed(opts.identity.sealingPrivateKey, body.sealed, sealAad(env)));
  } catch (err) {
    helpers.log(`review.request ${body.requestId} failed to decrypt: ${(err as Error).message}`);
    sendReviewResult(opts, peers, helpers.sendEnvelope, env, body.requestId, { verdict: "rejected", summary: "sealed payload failed to open" });
    return;
  }

  helpers.log(`reviewing for ${env.from.id}: ${payload.subject?.ref}`);
  const cwd = join(opts.dataDir, "work", "reviews");
  mkdirSync(cwd, { recursive: true });
  const prompt = [
    `REVIEW REQUEST (${payload.depth ?? "quick"}):`,
    `Subject: ${JSON.stringify(payload.subject ?? {})}`,
    `Judge against these criteria:`,
    ...(payload.criteria ?? []).map((c) => `- ${c}`),
  ].join("\n");

  const handle = harness.spawn({
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
  const summary = output.join("\n").slice(0, 2000);
  sendReviewResult(opts, peers, helpers.sendEnvelope, env, body.requestId, ok
    ? { verdict: "approved", summary }
    : { verdict: "changes_requested", summary });
}

export function sendReviewResult(
  opts: RunnerOptions,
  peers: PeerEntry[],
  sendEnvelope: (env: EnvelopeT) => void,
  reqEnv: EnvelopeT,
  requestId: string,
  judgement: { verdict: string; summary: string }
) {
  const agent = opts.agents[0];
  if (!agent) return;
  const peer = peers.find((p) => p.agentId === reqEnv.from.id);
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

  sendEnvelope({
    v: 1, id: envId, type: "review.result", project: reqEnv.project, from, to,
    task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: { requestId, taskId: null, state: sealed ? "completed" : "failed", verified: false, sealed },
  } as EnvelopeT);
}

export async function handleContextShare(
  opts: RunnerOptions,
  env: EnvelopeT,
  body: any,
  helpers: {
    log: (msg: string) => void;
    sendEnvelope: (env: EnvelopeT) => void;
  }
) {
  if (!opts.acceptDelegations) {
    helpers.log(`refused shared context "${body.title}": machine does not accept outside requests`);
    sendContextAck(opts, helpers.sendEnvelope, env, body.shareId, false);
    return;
  }

  let payload: { body?: string };
  try {
    payload = JSON.parse(openSealed(opts.identity.sealingPrivateKey, body.sealed, sealAad(env)));
  } catch (err) {
    helpers.log(`context.share "${body.title}" failed to decrypt: ${(err as Error).message}`);
    sendContextAck(opts, helpers.sendEnvelope, env, body.shareId, false);
    return;
  }

  mkdirSync(opts.dataDir, { recursive: true });
  const line = JSON.stringify({
    receivedAt: new Date().toISOString(),
    from: env.from.id,
    kind: body.kind,
    title: body.title,
    text: payload.body ?? "",
    expiresAt: new Date(Date.now() + (body.ttlDays ?? 7) * 86_400_000).toISOString(),
  }) + "\n";
  appendFileSync(join(opts.dataDir, "shared-context.jsonl"), line);

  helpers.log(`received context "${body.title}" from ${env.from.id} — stored locally`);
  sendContextAck(opts, helpers.sendEnvelope, env, body.shareId, true);
}

export function sendContextAck(
  opts: RunnerOptions,
  sendEnvelope: (env: EnvelopeT) => void,
  env: EnvelopeT,
  shareId: string,
  accepted: boolean
) {
  const envId = crypto.randomUUID();
  sendEnvelope({
    v: 1, id: envId, type: "context.ack", project: env.project,
    from: { kind: "agent", id: opts.agents[0]?.id ?? "unknown" },
    to: { kind: "agent", id: env.from.id },
    task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: { shareId, accepted },
  } as EnvelopeT);
}

export function recallSharedContext(dataDir: string, query: string): Array<{ title: string; text: string; from: string }> {
  const file = join(dataDir, "shared-context.jsonl");
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
    } catch {}
  }
  return out;
}
