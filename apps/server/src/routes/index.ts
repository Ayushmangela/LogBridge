import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./types.js";
import { registerAgentRoutes } from "./agents.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerWorkflowRoutes } from "./workflows.js";
import { registerGoalRoutes } from "./goals.js";
import { registerGovernanceRoutes } from "./governance.js";
import { registerSystemRoutes } from "./system.js";
import { registerCommunicationRoutes } from "./communication.js";
import { registerHiveRoutes } from "./hive.js";
import { registerProjectRoutes } from "./projects.js";
import { registerAuthRoutes } from "./auth.js";

export * from "./types.js";
export * from "./agents.js";
export * from "./tasks.js";
export * from "./workflows.js";
export * from "./goals.js";
export * from "./governance.js";
export * from "./system.js";
export * from "./communication.js";
export * from "./hive.js";
export * from "./projects.js";
export * from "./auth.js";

export function registerAllRoutes(app: FastifyInstance, deps: RouteDeps) {
  registerAgentRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerWorkflowRoutes(app, deps);
  registerGoalRoutes(app, deps);
  registerGovernanceRoutes(app, deps);
  registerSystemRoutes(app, deps);
  registerCommunicationRoutes(app, deps);
  registerHiveRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerAuthRoutes(app, deps);
}
