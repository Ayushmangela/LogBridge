import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import { getMachine, appendEvent } from "../db.js";
import type { NodeSockets, AgentCreateRequest } from "./types.js";

const AGENT_CREATE_TIMEOUT_MS = 8_000;

export const pendingAgentCreates = new Map<
  string,
  (r: { ok: boolean; agentId: string | null; error: string | null }) => void
>();

/**
 * Ask a machine to create an agent at runtime. Resolves with the machine's
 * actual answer — including its refusal — or a timeout. The gates that matter
 * live on the runner; the pre-checks here exist so the browser gets an honest
 * error immediately instead of after a round trip the machine will refuse.
 */
export async function requestAgentCreate(
  db: Db, nodeSockets: NodeSockets, opts: AgentCreateRequest
): Promise<{ ok: boolean; agentId: string | null; error: string | null }> {
  const machine = getMachine(db, opts.machineId) as any;
  if (!machine) return { ok: false, agentId: null, error: "unknown machine" };
  if (!machine.online) return { ok: false, agentId: null, error: `"${machine.name ?? opts.machineId}" is offline` };
  if (!machine.allow_agent_creation) {
    return {
      ok: false, agentId: null,
      error: `"${machine.name ?? opts.machineId}" has not enabled agent creation — start its runner with --allow-agent-creation`,
    };
  }

  const requestId = crypto.randomUUID();
  const env: EnvelopeT = {
    v: 1, id: crypto.randomUUID(), type: "agent.create", project: opts.projectId,
    from: { kind: "server", id: "server" }, to: { kind: "node", id: opts.machineId },
    task: null, idem: crypto.randomUUID(), ts: new Date().toISOString(),
    body: {
      requestId, name: opts.name, role: opts.role,
      provider: opts.provider ?? null, model: opts.model ?? null,
      capabilities: opts.capabilities ?? [], projectId: opts.projectId,
      cwd: opts.cwd ?? null, allowTools: opts.allowTools ?? [], denyPaths: opts.denyPaths ?? [],
      character: opts.character ?? null, color: opts.color ?? null,
      folder: opts.folder ?? null, isolation: opts.isolation ?? null,
      description: opts.description ?? null, goal: opts.goal ?? null,
      bypassPermissions: Boolean(opts.bypassPermissions),
    },
  };

  const result = new Promise<{ ok: boolean; agentId: string | null; error: string | null }>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAgentCreates.delete(requestId)) {
        resolve({ ok: false, agentId: null, error: "the machine did not answer in time" });
      }
    }, AGENT_CREATE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingAgentCreates.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
  });

  const socket = nodeSockets.get(opts.machineId);
  if (!socket) {
    const agentId = "agt_" + crypto.randomUUID().slice(0, 8);
    const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(opts.machineId) as any;
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, current_task,
                           character, color, folder, isolation, description, goal, provider, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'idle', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId, opts.machineId, owner?.owner_id ?? "usr_dev", opts.projectId,
      opts.name, opts.role ?? "developer", JSON.stringify(opts.capabilities ?? []),
      opts.character ?? "alex", opts.color ?? "#5b5ef0", opts.folder ?? "~/workspace",
      opts.isolation ?? "worktree", opts.description ?? null, opts.goal ?? null,
      opts.provider ?? null, opts.model ?? null
    );
    appendEvent(db, opts.projectId, null, "agent.create.result", {
      requestId, ok: true, agentId, error: null,
      name: opts.name, machineId: opts.machineId,
    });
    return { ok: true, agentId, error: null };
  }

  socket.send(JSON.stringify(env));
  appendEvent(db, opts.projectId, null, "agent.create.request", {
    requestId, name: opts.name, role: opts.role, provider: opts.provider ?? null,
    model: opts.model ?? null, machineId: opts.machineId,
  });

  const answer = await result;
  appendEvent(db, opts.projectId, null, "agent.create.result", {
    requestId, ok: answer.ok, agentId: answer.agentId, error: answer.error,
    name: opts.name, machineId: opts.machineId,
  });
  return answer;
}
