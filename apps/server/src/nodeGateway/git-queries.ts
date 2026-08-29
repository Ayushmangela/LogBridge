import type { EnvelopeT } from "@logbridge/protocol";
import type { Db } from "../db.js";
import { getMachine } from "../db.js";
import type { NodeSockets } from "./types.js";

const GIT_REQUEST_TIMEOUT_MS = 3000;

export const pendingGitRequests = new Map<
  string,
  (r: any) => void
>();

export async function requestAgentGit(
  db: Db,
  nodeSockets: NodeSockets,
  agentId: string
): Promise<{
  ok: boolean;
  branch: string | null;
  clean: boolean;
  ahead: number;
  behind: number;
  changedFiles: string[];
  commits: Array<{ sha: string; message: string; author?: string; ts?: string }>;
  error: string | null;
}> {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    return { ok: false, branch: null, clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "agent not found" };
  }
  const machine = getMachine(db, agent.machine_id) as any;
  if (!machine || !machine.online) {
    return { ok: true, branch: "unknown", clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "machine offline" };
  }
  if (agent.isolation === "shared") {
    return { ok: true, branch: null, clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: null };
  }

  const socket = nodeSockets.get(agent.machine_id);
  if (!socket || socket.readyState !== socket.OPEN) {
    return { ok: true, branch: "unknown", clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "runner disconnected" };
  }

  const requestId = crypto.randomUUID();
  const env: EnvelopeT = {
    v: 1,
    id: crypto.randomUUID(),
    type: "agent.git",
    project: agent.project_id ?? "",
    from: { kind: "server", id: "server" },
    to: { kind: "node", id: agent.machine_id },
    task: null,
    idem: crypto.randomUUID(),
    ts: new Date().toISOString(),
    body: { requestId, agentId: agent.id },
  };

  const result = new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingGitRequests.delete(requestId)) {
        resolve({ ok: true, branch: "unknown", clean: true, ahead: 0, behind: 0, changedFiles: [], commits: [], error: "timeout" });
      }
    }, GIT_REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingGitRequests.set(requestId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });

  socket.send(JSON.stringify(env));
  return result;
}
