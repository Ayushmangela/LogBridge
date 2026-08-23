import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import { openDb } from "./db.js";
import { Positions } from "./view.js";
import { registerGateway } from "./gateway.js";

const PORT = Number(process.env.PORT ?? 8787);

const db = openDb();
const positions = new Positions();
const browserSockets = new Set<WebSocket>();

const app = Fastify({ logger: true });

await app.register(websocket);

await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets"),
  prefix: "/assets/",
  decorateReply: false,
});

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
await app.register(fastifyStatic, {
  root: webRoot,
  prefix: "/",
  decorateReply: true,
});
app.get("/", async (_req, reply) => reply.sendFile("index.html"));

registerGateway(app, db, positions, browserSockets);

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
