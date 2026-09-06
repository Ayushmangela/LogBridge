// One way to reach an agent, whichever machine it lives on.
//
// THE PROBLEM. There were two channels and no front door:
//
//   * a RUNNER on another machine, reached with a `task.offer` envelope
//     (`sendTaskOffer`), and
//   * a PTY on this machine, reached by injecting into a live session or cold-
//     starting one (`deliverTaskLocally` / `spawnAndSubmit`).
//
// Every caller had to know both existed and try them in the right order. Three
// sites in `gateway.ts` did, with an identical copy-pasted
// `sendTaskOffer(...) || deliverTaskLocally(...)`. **Twelve did not** — they
// called `sendTaskOffer` alone, which returns false when the agent's machine
// has no open socket. A local PTY agent never has one, because there is no
// runner process for it. So a task assigned to a local agent from any of those
// twelve paths was silently dropped: state stayed `submitted`, the agent stayed
// `idle`, and nothing anywhere said so.
//
// That included `orchestrate()` — the orchestrator's own delivery step — and
// every task created through the REST API, every trigger firing, and every
// retry. Confirmed against the running server before this file existed.
//
// So this is not a tidy-up. The duplication WAS the bug, and it had already
// bitten twice before: the completion gate had to be added to both completion
// paths, and the agent lifecycle envelopes only ever got the PTY half.
import type { Db } from "./db.js";
import type { HiveManager } from "./hive.js";
import type { NodeSockets } from "./nodeGateway/types.js";
import { sendTaskOffer, deliverTaskLocally } from "./nodeGateway/task-offers.js";
import { submitPromptToAgent, spawnAndSubmit } from "./ptyGateway.js";

export type DeliveryVia = "runner" | "pty-inject" | "pty-spawn";

export interface Delivery {
  delivered: boolean;
  via: DeliveryVia | null;
  /** Set when nothing was delivered, so callers can say WHY rather than
   *  swallowing a false the way the old boolean did. */
  reason?: "no-such-agent" | "machine-offline" | "not-deliverable";
}

const ok = (via: DeliveryVia): Delivery => ({ delivered: true, via });
const no = (reason: Delivery["reason"]): Delivery => ({ delivered: false, via: null, reason });

/** Is a runner for this machine connected right now? */
function hasRunner(nodeSockets: NodeSockets, machineId: string | null | undefined): boolean {
  if (!machineId) return false;
  const socket = nodeSockets.get(machineId);
  return Boolean(socket && socket.readyState === socket.OPEN);
}

/**
 * Does this machine belong to a runner AT ALL?
 *
 * The load-bearing distinction, and the one a naive
 * "no socket, therefore local" rule gets catastrophically wrong. A runner's
 * socket is closed while it restarts, and during that window its agents still
 * belong to it: their workspace, their tool policy and their CLI all live on
 * that machine. Spawning their work here instead would run a teammate's agent
 * on the server's filesystem under the server's permissions.
 *
 * `pubkey` is set only by a real runner completing the signed handshake
 * (nodeGateway/gateway.ts), so its presence means "a runner owns this machine",
 * independent of whether it is connected this second. An agent created through
 * the browser with no runner behind it has none, and is genuinely ours to run.
 */
function isRunnerMachine(db: Db, machineId: string | null | undefined): boolean {
  if (!machineId) return false;
  const row = db.prepare("SELECT pubkey FROM machines WHERE id = ?").get(machineId) as any;
  return Boolean(row?.pubkey);
}

function agentRow(db: Db, agentId: string): any {
  return db.prepare("SELECT id, name, machine_id FROM agents WHERE id = ?").get(agentId);
}

/**
 * Put a TASK in front of whoever it is assigned to.
 *
 * Replaces every bare `sendTaskOffer()` call. The runner is tried first
 * because a machine that owns the agent should run it; the local PTY is the
 * fallback, not a special case.
 *
 * `postChat` exists because a locally-delivered task has no runner to report
 * progress, so the PTY path watches for the agent's reply and posts it into
 * the room itself.
 */
export function deliverTask(
  db: Db,
  nodeSockets: NodeSockets,
  taskId: string,
  hive?: HiveManager,
  postChat?: (agentId: string, agentName: string, text: string) => void
): Delivery {
  if (sendTaskOffer(db, nodeSockets, taskId)) return ok("runner");

  // Its runner is simply down. The task stays `submitted` and is redelivered
  // by reconcileOnConnect when that machine comes back — which is the
  // behaviour sendTaskOffer's own comment has always documented, and is why
  // this is NOT a fallback to running it here.
  const task = db.prepare("SELECT agent_id FROM tasks WHERE id = ?").get(taskId) as any;
  const agent = task?.agent_id ? agentRow(db, task.agent_id) : null;
  if (agent && isRunnerMachine(db, agent.machine_id)) return no("machine-offline");

  if (deliverTaskLocally(db, nodeSockets, taskId, hive, postChat)) return ok("pty-spawn");
  return no("not-deliverable");
}

/**
 * Put TEXT in front of an agent — a wake notice, a steer, a rejection from the
 * completion gate.
 *
 * Inject before spawn, always: a cold start costs 10-20 seconds and discards
 * whatever context the agent already had. `spawn` is optional because some
 * callers must never pay for a cold start to deliver a warning — the circuit
 * breaker being the clear case, where spawning a CLI to say "stop spending
 * money" spends money to say it.
 */
export function deliverText(
  db: Db,
  nodeSockets: NodeSockets,
  agentId: string,
  text: string,
  opts: { spawnIfCold?: boolean; hive?: HiveManager } = {}
): Delivery {
  const agent = agentRow(db, agentId);
  if (!agent) return no("no-such-agent");

  // A remote agent has no PTY here at all. Text for one is not something this
  // channel can deliver today — `agent.patch` and the task envelopes are the
  // only things that cross to a runner — so say so rather than pretending.
  if (hasRunner(nodeSockets, agent.machine_id) || isRunnerMachine(db, agent.machine_id)) {
    return no("not-deliverable");
  }

  if (submitPromptToAgent(agentId, text)) return ok("pty-inject");
  if (opts.spawnIfCold === false) return no("not-deliverable");
  if (spawnAndSubmit(db, agentId, agent.name || agentId, text, opts.hive)) return ok("pty-spawn");
  return no("not-deliverable");
}
