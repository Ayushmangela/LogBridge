import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Db } from "../db.js";
import type { NodeSockets } from "../nodeGateway.js";
import type { HiveManager } from "../hive.js";

export interface RouteDeps {
  db: Db;
  nodeSockets: NodeSockets;
  browserSockets: Set<WebSocket>;
  broadcastView: () => void;
  app: FastifyInstance;
  hive?: HiveManager;
}
