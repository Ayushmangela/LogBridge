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
): { broadcastView: () => void; broadcastChat: (chat: ChatMessageT) => void } {
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

        // Mid-task question: relay the human's words to the waiting agent.
        // The runner owns the state machine here — it flips the task back to
        // working (its next status confirms), delivers the text to the
        // process, and restarts its budget clock.
        if (task && msg.data.choice === "answer" && task.agent_id) {
          const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any;
          const socket = agent ? nodeSockets.get(agent.machine_id) : undefined;
          if (socket && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              v: 1, id: crypto.randomUUID(), type: "human.answer", project: task.project_id,
              from: { kind: "server", id: "server" }, to: { kind: "node", id: agent.machine_id },
              task: task.id, idem: null, ts: new Date().toISOString(),
              body: { askId: task.id, choice: "answer", text: msg.data.text ?? null },
            }));
            appendEvent(db, task.project_id, task.id, "human.answer.relayed", { to: agent.name });
            // The whole exchange belongs to the room (PLAN.md §8) — other
            // viewers see what was asked AND what was answered.
            const reply: ChatMessageT = {
              id: crypto.randomUUID(),
              roomId: task.project_id,
              from: { kind: "user", id: "you", name: "you" },
              text: `→ ${agent.name}: ${msg.data.text ?? "(no text)"}`,
              ts: new Date().toISOString(),
              ask: null,
            };
            appendEvent(db, task.project_id, task.id, "chat", reply);
            broadcastChat(reply);
          } else {
            appendEvent(db, task.project_id, task.id, "human.answer.undeliverable", { reason: "machine offline" });
          }
        }

        if (task && task.state === "submitted" && task.agent_id) {
          if (msg.data.choice === "approve") {
            sendTaskOffer(db, nodeSockets, task.id);
          } else if (msg.data.choice === "reject") {
            setTaskState(db, task.id, "rejected", { ended_at: new Date().toISOString() });
            clearAgentWaiting(db, task.agent_id);
          }
          // "edit" is still deferred — see M4-KICKOFF.md (prompt 4).
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

  return { broadcastView, broadcastChat };
}
