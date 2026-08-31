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

  const insertLocalAgentRow = (agentId: string) => {
    const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(opts.machineId) as any;
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, role_id, capabilities, concurrency, status, current_task,
                           character, color, folder, isolation, description, goal, provider, model, is_god)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'idle', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      agentId, opts.machineId, owner?.owner_id ?? "usr_dev", opts.projectId,
      opts.name, opts.role ?? "developer", opts.roleId ?? null,
      JSON.stringify(opts.capabilities ?? []),
      opts.character ?? "alex", opts.color ?? "#5b5ef0", opts.folder ?? "~/workspace",
      opts.isolation ?? "worktree", opts.description ?? null, opts.goal ?? null,
      opts.provider ?? null, opts.model ?? null
    );
  };

  const socket = nodeSockets.get(opts.machineId);
  if (!socket) {
    const agentId = "agt_" + crypto.randomUUID().slice(0, 8);
    insertLocalAgentRow(agentId);
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
  // The runner's "ok" is an acknowledgment, not proof a row exists here.
  // It used to be trusted at face value while the actual INSERT was left to
  // a separate, later "agent.card" broadcast from the runner — so an agent
  // could be added, appear in the hive (registry.json, identity.md, a
  // spawned terminal), and never show up in the sidebar or task offers
  // because that follow-up message never arrived. Inserting here as soon as
  // the runner confirms makes the row's existence not depend on a second
  // message. `INSERT OR IGNORE` means a later `agent.card` for the same id
  // still lands as the update it already was.
  if (answer.ok && answer.agentId) {
    insertLocalAgentRow(answer.agentId);
  }
  appendEvent(db, opts.projectId, null, "agent.create.result", {
    requestId, ok: answer.ok, agentId: answer.agentId, error: answer.error,
    name: opts.name, machineId: opts.machineId,
  });
  return answer;
}
