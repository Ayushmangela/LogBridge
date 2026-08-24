// Chat used to be broadcast and replayed to every browser regardless of room,
// with the client filtering for display. That was survivable while there was
// one room; the GitHub mirror creates one room per repo, so another project's
// conversation was being sent to browsers that had no business receiving it.
//
// These tests assert the scoping is real — the data does not leave the server
// — rather than that the UI happens to hide it.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { buildServer, type BuiltServer } from "./index.js";
import { appendEvent } from "./db.js";

let server: BuiltServer;
let wsUrl: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: 60, sweepIntervalMs: 5000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  wsUrl = `ws://127.0.0.1:${(server.app.server.address() as AddressInfo).port}/ws`;

  for (const [id, repo] of [["prj_a", "acme/a"], ["prj_b", "acme/b"]]) {
    server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
      .run(id, repo, repo, "office");
  }
  // One historical message in each room.
  for (const [room, text] of [["prj_a", "ROOM-A-HISTORY"], ["prj_b", "ROOM-B-HISTORY"]]) {
    appendEvent(server.db, room, null, "chat", {
      id: `h_${room}`, roomId: room, from: { kind: "user", id: "u", name: "someone" },
      text, ts: new Date().toISOString(), ask: null,
    });
  }
});

afterEach(async () => { await server.app.close(); });

/** Connect a browser and collect every chat message it is sent. */
async function browser() {
  const ws = new WebSocket(wsUrl);
  const chats: any[] = [];
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "chat") chats.push(m.msg);
  });
  return {
    ws, chats,
    join: (roomId: string) => ws.send(JSON.stringify({ type: "join", roomId })),
    say: (roomId: string, text: string) => ws.send(JSON.stringify({ type: "chat", roomId, text })),
    texts: () => chats.map((c) => c.text),
  };
}

const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

describe("chat is scoped to the room a browser joined", () => {
  test("joining replays only that room's history", async () => {
    const a = await browser();
    a.join("prj_a");
    await settle();

    expect(a.texts()).toContain("ROOM-A-HISTORY");
    expect(a.texts(), "another room's history must never be sent").not.toContain("ROOM-B-HISTORY");
    a.ws.close();
  });

  test("a live message reaches only browsers in that room", async () => {
    const inA = await browser();
    const inB = await browser();
    inA.join("prj_a");
    inB.join("prj_b");
    await settle();

    inA.say("prj_a", "HELLO-ROOM-A");
    await settle();

    expect(inA.texts()).toContain("HELLO-ROOM-A");
    expect(inB.texts(), "must not receive a message from a room it isn't in").not.toContain("HELLO-ROOM-A");
    inA.ws.close(); inB.ws.close();
  });

  test("a browser that never joined receives nothing", async () => {
    // Silence is recoverable; leaking another project's conversation is not.
    const lurker = await browser();
    const joined = await browser();
    joined.join("prj_a");
    await settle();
    joined.say("prj_a", "ONLY-FOR-JOINED");
    await settle();

    expect(joined.texts()).toContain("ONLY-FOR-JOINED");
    expect(lurker.chats).toHaveLength(0);
    lurker.ws.close(); joined.ws.close();
  });

  test("switching rooms swaps the history and the live feed", async () => {
    const b = await browser();
    b.join("prj_a");
    await settle();
    expect(b.texts()).toContain("ROOM-A-HISTORY");

    b.join("prj_b");
    await settle();
    expect(b.texts(), "the new room's history arrives on switch").toContain("ROOM-B-HISTORY");

    // ...and traffic in the room it left no longer arrives.
    const other = await browser();
    other.join("prj_a");
    await settle();
    other.say("prj_a", "AFTER-THEY-LEFT");
    await settle();
    expect(b.texts()).not.toContain("AFTER-THEY-LEFT");
    b.ws.close(); other.ws.close();
  });

  test("re-announcing the same room does not duplicate history", async () => {
    const b = await browser();
    b.join("prj_a");
    await settle();
    const first = b.texts().filter((t) => t === "ROOM-A-HISTORY").length;
    b.join("prj_a");
    await settle();
    expect(b.texts().filter((t) => t === "ROOM-A-HISTORY").length).toBe(first);
    b.ws.close();
  });

  test("joining a room that doesn't exist is ignored, not honoured", async () => {
    const b = await browser();
    b.join("prj_nonexistent");
    await settle();
    expect(b.chats).toHaveLength(0);
    // ...and the socket still works afterwards.
    b.join("prj_a");
    await settle();
    expect(b.texts()).toContain("ROOM-A-HISTORY");
    b.ws.close();
  });
});
