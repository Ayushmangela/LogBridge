import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ClientMessage, ServerMessage, type ChatMessageT, type RoomChatMessageT } from "@logbridge/protocol";
import {
  appendEvent, clearAgentWaiting, createTask, getTask, lastSeq,
  setTaskState, pauseTask, resumeTask, haltTask, setAgentSteer, type Db,
} from "./db.js";
import { acceptPlan, orchestrate, resolveDelegationConsent, sendTaskOffer, deliverTaskLocally, type NodeSockets } from "./nodeGateway.js";
import { planPrompt } from "./plan.js";
import { buildView, Positions } from "./view.js";
import { tokenFromRequest, userForToken } from "./sessions.js";
import type { HiveManager } from "./hive.js";

// `@agent-name the rest of the message` — see M4-KICKOFF.md. The "spec" this
// produces is deliberately dumb: the literal text after the mention, no
// real reasoning about it. There is no LLM wired into this project yet
// (same gap DECISIONS.md D24 documents for ptyHarness) — dressing this up
// as smarter than it is would be worse than a visibly naive stub.
function parseMention(text: string): { agentName: string; body: string } | null {
  const m = text.match(/^@(\S+)\s+(.+)$/s);
  return m ? { agentName: m[1], body: m[2].trim() } : null;
}

/** The words a person says to a colleague are not a task title. "can you make
 *  a website" is how a human asks; "make a website" is what goes on the board.
 *  Only the leading politeness is stripped — the rest of the sentence is left
 *  exactly as written, and the agent is still sent the original verbatim, so
 *  nothing about what actually runs depends on this. */
export function taskTitleFrom(body: string): string {
  const cleaned = body
    .replace(/^(?:hey|hi|ok|okay)[\s,]+/i, "")
    .replace(/^(?:please|pls|plz)\s+/i, "")
    .replace(/^(?:can|could|would|will)\s+(?:you|u|we)\s+(?:please\s+)?/i, "")
    .replace(/^(?:i\s+(?:want|need)\s+(?:you\s+)?to)\s+/i, "")
    .replace(/^(?:let's|lets)\s+/i, "")
    .trim();
  const title = cleaned || body.trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** A message from the room itself rather than a person or an agent. */
export function systemChat(roomId: string, text: string): ChatMessageT {
  return {
    id: crypto.randomUUID(), roomId,
    from: { kind: "agent", id: "system", name: "office" },
    text, ts: new Date().toISOString(), ask: null,
  };
}

/** An agent's own words in the room — as opposed to `On it —` (an ack the
 *  gateway generates) or a hive line (`sam → ram: ...`, generated from a
 *  structured inter-agent message). This is deliverTaskLocally's postChat:
 *  a direct "@cat hi" used to get exactly the ack and then silence forever,
 *  because nothing ever looked at what the agent actually said. */
export function agentReplyChat(roomId: string, agentId: string, agentName: string, text: string): ChatMessageT {
  return {
    id: crypto.randomUUID(), roomId,
    from: { kind: "agent", id: agentId, name: agentName },
    text, ts: new Date().toISOString(), ask: null,
  };
}

export function registerGateway(
  app: FastifyInstance,
  db: Db,
  positions: Positions,
  browserSockets: Set<WebSocket>,
  nodeSockets: NodeSockets,
  hive?: HiveManager
): { broadcastView: () => void; broadcastChat: (chat: ChatMessageT) => void } {
  // Which user is connected to each browser socket
  const userOf = new Map<WebSocket, string>();

  // The AUTHENTICATED identity of each browser socket, from its session token.
  // Separate from `userOf`, which is whatever `userId` the client put in a
  // join/position message and is used for avatar placement.
  //
  // Scoping the view must use THIS one. The workspace view now shows only the
  // projects you belong to, and deciding that from a client-supplied value
  // would make the filter advisory — anyone could ask for someone else's
  // floors by sending a different userId.
  const authUserOf = new Map<WebSocket, string>();

  // Which room each browser is looking at, set by the `join` message.
  const roomOf = new Map<WebSocket, string>();

  const broadcastView = () => {
    if (browserSockets.size === 0) return;
    for (const ws of browserSockets) {
      if (ws.readyState !== ws.OPEN) continue;
      const meId = authUserOf.get(ws) ?? userOf.get(ws) ?? "you";
      const msg = { type: "view" as const, view: buildView(db, positions, meId, hive) };
      const parsed = ServerMessage.safeParse(msg);
      if (!parsed.success) {
        app.log.error({ err: parsed.error }, "view failed contract validation — not sent");
        continue;
      }
      ws.send(JSON.stringify(parsed.data));
    }
  };

  const broadcastChat = (chat: ChatMessageT) => {
    const json = JSON.stringify({ type: "chat", roomId: chat.roomId, msg: chat });
    for (const ws of browserSockets) {
      if (ws.readyState !== ws.OPEN) continue;
      // A socket that hasn't joined yet gets nothing rather than everything:
      // silence is recoverable, leaking another project's conversation isn't.
      if (roomOf.get(ws) !== chat.roomId) continue;
      ws.send(json);
    }
  };

  /** The room's last messages, oldest first. Capped — invariant 1 applies to
   *  history too. Replayed on join, not on connect, because until a browser
   *  says which room it wants there is nothing correct to send. */
  const replayChat = (socket: WebSocket, roomId: string, limit = 50) => {
    const rows = db.prepare(
      "SELECT body FROM events WHERE type = 'chat' AND project_id = ? ORDER BY seq DESC LIMIT ?"
    ).all(roomId, limit) as any[];
    for (const row of rows.reverse()) {
      try {
        const msg = JSON.parse(row.body);
        if (msg?.roomId === roomId) socket.send(JSON.stringify({ type: "chat", roomId, msg }));
      } catch {
        /* skip a malformed row rather than dropping the rest */
      }
    }
  };

  app.get("/ws", { websocket: true }, (socket, req) => {
    // M1: browsers only. Node-runner auth (signed challenge) arrives in week 2.
    browserSockets.add(socket);

    // Resolve who this is BEFORE the first view is built. This used the
    // literal "you", which was harmless while every user could see every
    // project — and became "your office is empty, forever" once the view was
    // scoped to memberships, because no user has the id "you" so it matched
    // nothing and the browser sat on "Connecting…".
    const me = userForToken(db, tokenFromRequest(req as any));
    if (me) authUserOf.set(socket, me.id);

    socket.send(
      JSON.stringify({
        type: "view",
        view: buildView(db, positions, me?.id ?? "you", hive),
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

      if (msg.data.type === "join") {
        const known = db.prepare("SELECT id FROM projects WHERE id = ?").get(msg.data.roomId);
        if (!known) return; // don't hand out history for a room that isn't real
        const previous = roomOf.get(socket);
        roomOf.set(socket, msg.data.roomId);
        if (msg.data.userId) userOf.set(socket, msg.data.userId);
        // Only replay when the room actually changed, so a browser that
        // re-announces the same room doesn't duplicate its own history.
        if (previous !== msg.data.roomId) replayChat(socket, msg.data.roomId);
        return;
      }

      if (msg.data.type === "sync") {
        const roomId = msg.data.roomId;
        const lastSeenSeq = msg.data.lastSeenSeq;
        const known = db.prepare("SELECT id FROM projects WHERE id = ?").get(roomId);
        if (!known) return;

        // Fetch missed events up to limit (100)
        const rows = db.prepare(
          "SELECT seq, project_id, task_id, type, body, ts FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT 101"
        ).all(roomId, lastSeenSeq) as any[];

        if (rows.length > 100) {
          // Bounded fallback: too far behind, push fresh full view snapshot
          const meId = userOf.get(socket) || "you";
          socket.send(JSON.stringify({
            type: "view",
            view: buildView(db, positions, meId, hive),
          }));
        } else {
          const events = rows.map((r) => {
            let data: any = {};
            try { data = JSON.parse(r.body); } catch { data = { raw: r.body }; }
            return { seq: r.seq, projectId: r.project_id, taskId: r.task_id, type: r.type, data, ts: r.ts };
          });
          socket.send(JSON.stringify({
            type: "events_replay",
            roomId,
            events,
          }));
        }
        return;
      }

      if (msg.data.type === "position") {
        const uid = msg.data.userId || userOf.get(socket) || "you";
        userOf.set(socket, uid);
        positions.set(uid, {
          roomId: msg.data.roomId,
          x: msg.data.x,
          y: msg.data.y,
        });
        appendEvent(db, msg.data.roomId, null, "position", msg.data);
        broadcastView();
      } else if (msg.data.type === "room_chat") {
        const uid = msg.data.from?.id || userOf.get(socket) || "you";
        const uname = msg.data.from?.name || "Colleague";
        const roomMsg: RoomChatMessageT = {
          id: crypto.randomUUID(),
          roomId: msg.data.roomId,
          zone: msg.data.zone,
          from: {
            id: uid,
            name: uname,
            avatar: msg.data.from?.avatar ?? 0,
          },
          text: msg.data.text,
          ts: new Date().toISOString(),
        };
        appendEvent(db, msg.data.roomId, null, "room_chat", roomMsg);
        const json = JSON.stringify({ type: "room_chat", roomId: msg.data.roomId, msg: roomMsg });
        for (const ws of browserSockets) {
          if (ws.readyState !== ws.OPEN) continue;
          if (roomOf.get(ws) !== msg.data.roomId) continue;
          ws.send(json);
        }
      } else if (msg.data.type === "webrtc_signal") {
        const fromId = msg.data.fromUserId || userOf.get(socket) || "you";
        const forward = {
          type: "webrtc_signal" as const,
          roomId: msg.data.roomId,
          fromUserId: fromId,
          targetUserId: msg.data.targetUserId,
          signal: msg.data.signal,
        };
        const json = JSON.stringify(forward);
        for (const ws of browserSockets) {
          if (ws.readyState !== ws.OPEN) continue;
          if (userOf.get(ws) === msg.data.targetUserId) {
            ws.send(json);
            break;
          }
        }
      } else if (msg.data.type === "chat") {
        const uid = userOf.get(socket) || "you";
        const userRow = db.prepare("SELECT name FROM users WHERE id = ?").get(uid) as any;
        const chat: ChatMessageT = {
          id: crypto.randomUUID(),
          roomId: msg.data.roomId,
          from: { kind: "user", id: uid, name: userRow?.name || uid },
          text: msg.data.text,
          ts: new Date().toISOString(),
          ask: null,
        };
        appendEvent(db, msg.data.roomId, null, "chat", chat);
        broadcastChat(chat);

        // "/plan <goal>" turns a goal into tasks. It runs as an ordinary
        // task (so budget, tool policy and leases all apply) whose OUTPUT
        // happens to be a task list — see plan.ts.
        const plan = msg.data.text.match(/^\/plan\s+(.+)$/s);
        if (plan) {
          const goal = plan[1].trim().slice(0, 300);
          const agent = db.prepare(
            "SELECT * FROM agents WHERE project_id = ? AND status = 'idle' ORDER BY id LIMIT 1"
          ).get(msg.data.roomId) as any;
          if (!agent) {
            broadcastChat(systemChat(msg.data.roomId, "No agent is free to plan that right now."));
            return;
          }
          const taskId = createTask(db, {
            projectId: msg.data.roomId,
            title: `Plan: ${goal}`,
            spec: planPrompt(goal),
            creatorId: "you",
            agentId: agent.id,
            kind: "plan",
            budgetSeconds: 240,
          });
          appendEvent(db, msg.data.roomId, taskId, "plan.requested", { goal });
          const planRoomId = msg.data.roomId; // TS can't keep the "chat" narrowing across the closure below
          sendTaskOffer(db, nodeSockets, taskId) || deliverTaskLocally(db, nodeSockets, taskId, hive, (agentId, agentName, text) => {
            const reply = agentReplyChat(planRoomId, agentId, agentName, text);
            appendEvent(db, planRoomId, taskId, "chat", reply);
            broadcastChat(reply);
          });
          broadcastChat(systemChat(msg.data.roomId,
            `Planning “${goal}” — ${agent.name} is breaking it into tasks.`));
          broadcastView();
          return;
        }

        const mention = parseMention(msg.data.text);
        if (mention) {
          const agent = db
            .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ?")
            .get(msg.data.roomId, mention.agentName) as any;
          // Who can be mentioned, and why the guard is not just `=== "idle"`:
          //
          //  - "starting" is a READY-SOON state, not a busy one. An agent
          //    boots for 10-20s (CONTRACT 1.27), and the old guard dropped
          //    every mention in that window with no feedback at all — you
          //    created an agent, spoke to it, and nothing happened.
          //    A starting agent accepts work; deliverTaskLocally queues it
          //    behind the boot, which is exactly what the queue is for.
          //  - paused/retired are FLAGS, not statuses. Pausing an agent never
          //    changed `status`, so a paused agent still passed `=== "idle"`
          //    and took the work its owner had just stopped it from taking.
          //  - Anything else (working, blocked, needs_input, reviewing) is
          //    genuinely busy: stacking a second instruction would orphan the
          //    first proposal.
          //
          // And every rejection now SAYS so in the room. Silence was
          // indistinguishable from a typo'd name, a paused agent, and a bug.
          const mentionable = agent
            && !agent.paused && !agent.retired
            && (agent.status === "idle" || agent.status === "starting");

          if (agent && !mentionable) {
            const why = agent.retired ? `${agent.name} is retired.`
              : agent.paused ? `${agent.name} is paused — resume it to send work.`
              : `${agent.name} is ${String(agent.status).replace(/_/g, " ")} right now.`;
            const note = agentReplyChat(msg.data.roomId, agent.id, agent.name, why);
            appendEvent(db, msg.data.roomId, null, "chat", note);
            broadcastChat(note);
          }

          if (mentionable) {
            // Telling a colleague to do something is not a proposal awaiting
            // your consent. This used to answer "@commander can you make a
            // website" with `Proposed: "can you make a website". Approve to
            // run it?` — reading your own sentence back and parking the agent
            // in needs_human until you confirmed words you had just typed.
            //
            // The instruction IS the consent. The approve gate stays where a
            // decision genuinely rests with the human, and both of those are
            // agent-originated: an agent asking to delegate
            // (nodeGateway/delegation.ts) and an agent proposing a plan
            // (nodeGateway/plan-proposals.ts).
            //
            // The agent is sent `spec` — the original wording, untouched —
            // so a question ("what's the status?") and an order ("build X")
            // both just reach it, and it answers or works as a person would.
            // Nothing here has to guess which one you meant.
            const taskId = createTask(db, {
              projectId: msg.data.roomId,
              title: taskTitleFrom(mention.body),
              spec: mention.body,
              creatorId: "you",
              agentId: agent.id,
            });
            const mentionRoomId = msg.data.roomId; // TS can't keep the "chat" narrowing across the closure below
            sendTaskOffer(db, nodeSockets, taskId) || deliverTaskLocally(db, nodeSockets, taskId, hive, (agentId, agentName, text) => {
              const reply = agentReplyChat(mentionRoomId, agentId, agentName, text);
              appendEvent(db, mentionRoomId, taskId, "chat", reply);
              broadcastChat(reply);
            });
            const ack: ChatMessageT = {
              id: crypto.randomUUID(),
              roomId: msg.data.roomId,
              from: { kind: "agent", id: agent.id, name: agent.name },
              text: `On it — ${taskTitleFrom(mention.body)}`,
              ts: new Date().toISOString(),
              ask: null,
            };
            appendEvent(db, msg.data.roomId, taskId, "chat", ack);
            broadcastChat(ack);
          }
          broadcastView(); // agent's zone just changed (idle -> needs_human), or didn't
        }
      } else if (msg.data.type === "answer") {
        appendEvent(db, null, msg.data.taskId, "human.answer", msg.data);

        // A plan id, not a task id. Nothing was created when the plan was
        // proposed — approving is what creates the tasks, so a bad
        // decomposition costs a click rather than six running agents.
        if (msg.data.taskId.startsWith("pln_")) {
          if (msg.data.choice === "approve") {
            const n = acceptPlan(db, msg.data.taskId);
            const room = roomOf.get(socket);
            if (room) {
              broadcastChat(systemChat(room,
                n > 0 ? `Created ${n} task${n === 1 ? "" : "s"}. The orchestrator is routing them now.`
                      : "That plan has already been used or expired."));
            }
            if (n > 0) orchestrate(db, nodeSockets, app);
          }
          broadcastView();
          return;
        }

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

        // Edit a proposal before it runs. Only while `submitted` — the task
        // state machine is enforced, not advisory: once a runner has accepted
        // the work, the human's recourse is Stop, not silent rewrites.
        if (task && msg.data.choice === "edit" && task.agent_id) {
          const newTitle = (msg.data.text ?? "").trim();
          if (!newTitle) {
            socket.send(JSON.stringify({ type: "error", error: "An edit needs the replacement text." }));
            return;
          }
          if (task.state !== "submitted") {
            appendEvent(db, task.project_id, task.id, "task.edit.refused", { reason: `state was ${task.state}` });
            socket.send(JSON.stringify({ type: "error", error: "Too late to edit — that task has already left submitted." }));
            broadcastView();
            return;
          }
          const oldTitle = task.title;
          // After an edit, spec is always the edited text: "what you typed is
          // exactly what runs". A null spec would fall back to title at offer
          // time anyway — making it explicit beats implying a distinction.
          db.prepare("UPDATE tasks SET title = ?, spec = ? WHERE id = ?")
            .run(newTitle, msg.data.spec ?? newTitle, task.id);
          appendEvent(db, task.project_id, task.id, "task.edit", {
            by: "you", from: oldTitle, to: newTitle,
            specEdited: Boolean(msg.data.spec),
          });

          // Re-post the proposal with the new wording so every viewer sees
          // what would actually run — not just the person who edited.
          const agentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.agent_id) as any;
          const revised: ChatMessageT = {
            id: crypto.randomUUID(),
            roomId: task.project_id,
            from: { kind: "agent", id: agentRow.id, name: agentRow.name },
            text: `Revised: "${newTitle}". Approve to run it?`,
            ts: new Date().toISOString(),
            ask: { taskId: task.id, options: ["approve", "edit", "reject"] },
          };
          appendEvent(db, task.project_id, task.id, "chat", revised);
          broadcastChat(revised);
          broadcastView();
          return;
        }

        // Delegation consent: the "taskId" here may be a held delegation's
        // requestId rather than a task. resolveDelegationConsent returns
        // false for non-delegation ids, and we fall through to task answers.
        if (msg.data.choice === "approve" || msg.data.choice === "reject") {
          const handled = resolveDelegationConsent(
            db, nodeSockets, app, msg.data.taskId,
            msg.data.choice === "approve",
            // approve with no mode = this once; reject with never = standing rule
            msg.data.mode,
            broadcastChat
          );
          if (handled) { broadcastView(); return; }
        }

        if (task && task.state === "submitted" && task.agent_id) {
          if (msg.data.choice === "approve") {
            sendTaskOffer(db, nodeSockets, task.id) || deliverTaskLocally(db, nodeSockets, task.id, hive, (agentId, agentName, text) => {
              const reply = agentReplyChat(task.project_id, agentId, agentName, text);
              appendEvent(db, task.project_id, task.id, "chat", reply);
              broadcastChat(reply);
            });
          } else if (msg.data.choice === "reject") {
            setTaskState(db, task.id, "rejected", { ended_at: new Date().toISOString() });
            clearAgentWaiting(db, task.agent_id);
          }
          // "edit" is still deferred — see M4-KICKOFF.md (prompt 4).
        }
        broadcastView();
      } else if (msg.data.type === "task_control") {
        const { taskId, action } = msg.data;
        const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
        if (task) {
          if (action === "pause") pauseTask(db, taskId);
          else if (action === "resume") resumeTask(db, taskId);
          else if (action === "halt") haltTask(db, taskId, "Halted from UI");

          if (task.agent_id) {
            const agent = db.prepare("SELECT machine_id FROM agents WHERE id = ?").get(task.agent_id) as any;
            if (agent?.machine_id) {
              const sock = nodeSockets.get(agent.machine_id);
              if (sock && sock.readyState === 1) {
                sock.send(JSON.stringify({ type: `task_${action}`, taskId, agentId: task.agent_id }));
              }
            }
          }
          broadcastView();
        }
      } else if (msg.data.type === "steer") {
        const { agentId, text, taskId } = msg.data;
        setAgentSteer(db, agentId, text);
        const agent = db.prepare("SELECT machine_id, project_id FROM agents WHERE id = ?").get(agentId) as any;
        if (agent) {
          appendEvent(db, agent.project_id, taskId ?? null, "task_steer", {
            agentId,
            taskId,
            text,
            at: new Date().toISOString(),
          });
          if (agent.machine_id) {
            const sock = nodeSockets.get(agent.machine_id);
            if (sock && sock.readyState === 1) {
              sock.send(JSON.stringify({ type: "steer", agentId, taskId, text }));
            }
          }
          broadcastView();
        }
      }
    });

    socket.on("close", () => {
      browserSockets.delete(socket);
      roomOf.delete(socket);
      const uid = userOf.get(socket);
      if (uid) {
        userOf.delete(socket);
        authUserOf.delete(socket);
        positions.delete(uid);
        broadcastView();
      }
    });
  });

  app.get("/healthz", async () => ({
    ok: true,
    seq: lastSeq(db),
    clients: browserSockets.size,
    time: new Date().toISOString(),
  }));

  return { broadcastView, broadcastChat };
}
