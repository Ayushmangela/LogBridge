import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { assignPendingTasks } from "../orchestrator.js";
import { sendTaskOffer } from "./task-offers.js";
import type { NodeSockets } from "./types.js";

/** Run the orchestrator and offer whatever it just assigned. The single entry
 *  point — called wherever capacity changes: a machine connects, an agent
 *  finishes, a new agent registers. */
export function orchestrate(db: Db, nodeSockets: NodeSockets, app?: FastifyInstance) {
  for (const { taskId, agentId } of assignPendingTasks(db)) {
    app?.log.info({ taskId, agentId }, "orchestrator assigned task");
    sendTaskOffer(db, nodeSockets, taskId);
  }
}
