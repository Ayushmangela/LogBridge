import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ClientMessage, ServerMessage, type ChatMessageT } from "@logbridge/protocol";
import { appendEvent, lastSeq, type Db } from "./db.js";
import { buildView, Positions } from "./view.js";

export function registerGateway(
  app: FastifyInstance,
  db: Db,
  positions: Positions,
  browserSockets: Set<WebSocket>
): () => void {
  const broadcastView = () => {
    if (browserSockets.size === 0) return;
    const msg = { type: "view" as const, view: buildView(db, positions, "you") };
    const parsed = ServerMessage.safeParse(msg);
    if (!parsed.success) {
      app.log.error({ err: parsed.error }, "view failed contract validation — not sent");
      return;
    }
    const json = JSON.stringify(parsed.data);
    for (const ws of browserSockets) if (ws.readyState === ws.OPEN) ws.send(json);
  };

  app.get("/ws", { websocket: true }, (socket, req) => {
    // M1: browsers only. Node-runner auth (signed challenge) arrives in week 2.
    browserSockets.add(socket);

    socket.send(
      JSON.stringify({
        type: "view",
        view: buildView(db, positions, "you"),
      })
    );

    socket.on("message", (raw: Buffer) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = ClientMessage.safeParse(parsedJson);
      if (!msg.success) {
        socket.send(JSON.stringify({ type: "error", error: msg.error.message }));
        return;
      }

      if (msg.data.type === "position") {
        positions.set("you", { roomId: msg.data.roomId, x: msg.data.x, y: msg.data.y });
        appendEvent(db, msg.data.roomId, null, "position", msg.data);
        broadcastView();
      } else if (msg.data.type === "chat") {
        const chat: ChatMessageT = {
          id: crypto.randomUUID(),
          roomId: msg.data.roomId,
          from: { kind: "user", id: "you", name: "you" },
          text: msg.data.text,
          ts: new Date().toISOString(),
          ask: null,
        };
        appendEvent(db, msg.data.roomId, null, "chat", chat);
        for (const ws of browserSockets) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "chat", roomId: chat.roomId, msg: chat }));
          }
        }
      } else if (msg.data.type === "answer") {
        appendEvent(db, null, msg.data.taskId, "human.answer", msg.data);
        broadcastView();
      }
    });

    socket.on("close", () => browserSockets.delete(socket));
  });

  app.get("/healthz", async () => ({
    ok: true,
    seq: lastSeq(db),
    clients: browserSockets.size,
    time: new Date().toISOString(),
  }));

  return broadcastView;
}
