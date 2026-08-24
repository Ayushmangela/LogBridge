import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ClientMessage, ServerMessage, type ChatMessageT } from "@logbridge/protocol";
import {
  appendEvent, clearAgentWaiting, createTask, getTask, lastSeq,
  setAgentWaitingOnHuman, setTaskState, type Db,
} from "./db.js";
import { sendTaskOffer, type NodeSockets } from "./nodeGateway.js";
import { buildView, Positions } from "./view.js";

// `@agent-name the rest of the message` — see M4-KICKOFF.md. The "spec" this
// produces is deliberately dumb: the literal text after the mention, no
// real reasoning about it. There is no LLM wired into this project yet
// (same gap DECISIONS.md D24 documents for ptyHarness) — dressing this up
// as smarter than it is would be worse than a visibly naive stub.
function parseMention(text: string): { agentName: string; body: string } | null {
  const m = text.match(/^@(\S+)\s+(.+)$/s);
  return m ? { agentName: m[1], body: m[2].trim() } : null;
}

export function registerGateway(
  app: FastifyInstance,
  db: Db,
  positions: Positions,
  browserSockets: Set<WebSocket>,
  nodeSockets: NodeSockets
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

  const broadcastChat = (chat: ChatMessageT) => {
    const json = JSON.stringify({ type: "chat", roomId: chat.roomId, msg: chat });
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
        broadcastChat(chat);

        const mention = parseMention(msg.data.text);
        if (mention) {
          const agent = db
            .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ?")
            .get(msg.data.roomId, mention.agentName) as any;
          // Silently ignore a typo'd name or an agent already waiting on
          // something — no orphaned second proposal stacked on the first.
          if (agent && agent.status === "idle") {
            const taskId = createTask(db, {
              projectId: msg.data.roomId,
              title: mention.body,
              creatorId: "you",
              agentId: agent.id,
            });
            setAgentWaitingOnHuman(db, agent.id, "you");
            const ask: ChatMessageT = {
              id: crypto.randomUUID(),
              roomId: msg.data.roomId,
              from: { kind: "agent", id: agent.id, name: agent.name },
              text: `Proposed: "${mention.body}". Approve to run it?`,
              ts: new Date().toISOString(),
              ask: { taskId, options: ["approve", "reject"] },
            };
            appendEvent(db, msg.data.roomId, taskId, "chat", ask);
            broadcastChat(ask);
          }
          broadcastView(); // agent's zone just changed (idle -> needs_human), or didn't
        }
      } else if (msg.data.type === "answer") {
        appendEvent(db, null, msg.data.taskId, "human.answer", msg.data);
        const task = getTask(db, msg.data.taskId);
        if (task && task.state === "submitted" && task.agent_id) {
          if (msg.data.choice === "approve") {
            sendTaskOffer(db, nodeSockets, task.id);
          } else if (msg.data.choice === "reject") {
            setTaskState(db, task.id, "rejected", { ended_at: new Date().toISOString() });
            clearAgentWaiting(db, task.agent_id);
          }
          // "edit" / "answer" (mid-task question) are out of scope for this
          // slice — see M4-KICKOFF.md's explicitly-deferred list.
        }
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
