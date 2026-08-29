import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EnvelopeT } from "@logbridge/protocol";
import { detectInstalled, providerById } from "../harness/providers.js";
import { resolveWorkspace } from "../workspace.js";
import { saveCreatedAgents } from "../createdAgents.js";
import type { AgentDecl, RunnerOptions } from "./types.js";

export function handleAgentCreate(
  opts: RunnerOptions,
  createdAgents: AgentDecl[],
  env: EnvelopeT,
  body: any,
  helpers: {
    log: (msg: string) => void;
    agentById: (id: string | null | undefined) => AgentDecl | undefined;
    publishCard: (a: AgentDecl) => void;
    sendEnvelope: (env: EnvelopeT) => void;
  }
) {
  const requestId = body.requestId;
  const refuse = (error: string) => {
    helpers.log(`refused agent.create "${body.name}": ${error}`);
    helpers.sendEnvelope({
      v: 1, id: crypto.randomUUID(), type: "agent.create.result", project: env.project,
      from: { kind: "node", id: opts.identity.machineId },
      to: { kind: "node", id: opts.identity.machineId },
      task: null, idem: null, ts: new Date().toISOString(),
      body: { requestId, ok: false, agentId: null, error },
    } as EnvelopeT);
  };

  if (!opts.allowAgentCreation) {
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
    if (spec.policy === "none" && !opts.allowUnsandboxed) {
      refuse(
        `provider "${spec.label}" cannot enforce allowTools/denyPaths on this machine — ` +
        "every task would be refused. Enable --allow-unsandboxed if you accept that."
      );
      return;
    }
  }

  const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  let id = `agt_${opts.identity.machineId}_${slug}`;
  while (helpers.agentById(id)) id = `${id}_${crypto.randomUUID().slice(0, 4)}`;

  const cwd = body.cwd ?? join(opts.dataDir, "work", id);
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
    folder: body.folder ?? null,
    isolation: body.isolation ?? null,
    description: body.description ?? null,
    goal: body.goal ?? null,
    bypassPermissions: Boolean(body.bypassPermissions),
  };
  opts.agents.push(decl);
  createdAgents.push(decl);
  saveCreatedAgents(opts.dataDir, createdAgents, helpers.log);

  helpers.publishCard(decl);
  helpers.log(`created agent ${decl.name} (${decl.provider ?? "default harness"}) from browser request`);

  helpers.sendEnvelope({
    v: 1, id: crypto.randomUUID(), type: "agent.create.result", project: env.project,
    from: { kind: "node", id: opts.identity.machineId },
    to: { kind: "node", id: opts.identity.machineId },
    task: null, idem: null, ts: new Date().toISOString(),
    body: { requestId, ok: true, agentId: id, error: null },
  } as EnvelopeT);
}

export function handleAgentGit(
  opts: RunnerOptions,
  env: EnvelopeT,
  body: any,
  helpers: {
    agentById: (id: string | null | undefined) => AgentDecl | undefined;
    sendEnvelope: (env: EnvelopeT) => void;
  }
): void {
  const { requestId, agentId } = body;
  const agent = helpers.agentById(agentId);
  if (!agent) {
    sendGitResult(opts, helpers.sendEnvelope, env, requestId, {
      ok: false,
      branch: null,
      clean: true,
      ahead: 0,
      behind: 0,
      changedFiles: [],
      commits: [],
      error: "agent not found on this machine",
    });
    return;
  }

  const ws = resolveWorkspace({
    agentId: agent.id,
    folder: agent.folder ?? null,
    isolation: agent.isolation ?? "worktree",
    fallbackDir: join(opts.dataDir, "work", agent.id),
  });

  if (ws.degradedReason && ws.degradedReason.toLowerCase().includes("not a git repository")) {
    sendGitResult(opts, helpers.sendEnvelope, env, requestId, {
      ok: true,
      branch: null,
      clean: true,
      ahead: 0,
      behind: 0,
      changedFiles: [],
      commits: [],
      error: null,
    });
    return;
  }

  try {
    const branchRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ws.cwd, encoding: "utf8" });
    const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null;

    const statusRes = spawnSync("git", ["status", "--porcelain"], { cwd: ws.cwd, encoding: "utf8" });
    const statusLines = statusRes.status === 0 ? statusRes.stdout.trim().split("\n").filter(Boolean) : [];
    const clean = statusLines.length === 0;
    const changedFiles = statusLines.map((l) => l.trim().slice(3));

    let ahead = 0;
    let behind = 0;
    const abRes = spawnSync("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd: ws.cwd, encoding: "utf8" });
    if (abRes.status === 0) {
      const parts = abRes.stdout.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = Number(parts[0]) || 0;
        ahead = Number(parts[1]) || 0;
      }
    }

    const logRes = spawnSync("git", ["log", "-n", "5", "--pretty=format:%h|%s|%an|%cI"], { cwd: ws.cwd, encoding: "utf8" });
    const commits = logRes.status === 0 && logRes.stdout.trim()
      ? logRes.stdout.trim().split("\n").map((line) => {
          const [sha, message, author, ts] = line.split("|");
          return { sha: sha ?? "", message: message ?? "", author, ts };
        })
      : [];

    sendGitResult(opts, helpers.sendEnvelope, env, requestId, {
      ok: true,
      branch,
      clean,
      ahead,
      behind,
      changedFiles,
      commits,
      error: null,
    });
  } catch (err: any) {
    sendGitResult(opts, helpers.sendEnvelope, env, requestId, {
      ok: false,
      branch: null,
      clean: true,
      ahead: 0,
      behind: 0,
      changedFiles: [],
      commits: [],
      error: err?.message ?? "git inspection failed",
    });
  }
}

export function sendGitResult(
  opts: RunnerOptions,
  sendEnvelope: (env: EnvelopeT) => void,
  env: EnvelopeT,
  requestId: string,
  result: any
): void {
  sendEnvelope({
    v: 1,
    id: crypto.randomUUID(),
    type: "agent.git.result",
    project: env.project,
    from: { kind: "node", id: opts.identity.machineId },
    to: { kind: "node", id: opts.identity.machineId },
    task: null,
    idem: null,
    ts: new Date().toISOString(),
    body: {
      requestId,
      ...result,
    },
  } as EnvelopeT);
}
