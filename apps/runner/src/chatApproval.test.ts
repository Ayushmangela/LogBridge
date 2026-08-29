// The first real slice of M4 (see M4-KICKOFF.md): "@agent do X" in chat ->
// a proposed task the agent's zone visibly waits on -> a human answer that
// actually runs it. Wires ChatMessage.ask and the answer client message,
// both already speced in the protocol/CONTRACT.md but never previously
// connected to anything (chat only echoed; answers were logged and ignored).
//
// Goes through a real browser WS connection AND a real runner WS connection
// simultaneously — this is the first test in the repo that needs both at
// once, because the whole point is a human's chat message driving a real
// task through to a real runner.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { fakeHarness } from "./harness/fakeHarness.js";

let server: BuiltServer;
let baseUrl: string;
let wsBase: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: 30, sweepIntervalMs: 1000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-chat-approval-test-"));

  server.db
    .prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner() {
  const identity = loadOrCreateIdentity(dataDir, "node_test_chat");
  const conn = new RunnerConnection({
    serverUrl: `${wsBase}/node-ws`,
    identity,
    machineName: "test-machine-chat",
    ownerId: "usr_test",
    ownerName: "test",
    dataDir,
    leaseSeconds: 30,
    harness: fakeHarness,
    agents: [{ id: "agt_chat", name: "dev-chat", role: "developer", capabilities: ["fake_work"], projects: ["prj_test"] }],
    log: () => {},
  });
  return conn;
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function taskRow(taskId: string) {
  return server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
}

function agentRow(agentId: string) {
  return server.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
}

const ROOM = "prj_test";

function connectBrowser(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    ws.once("open", () => {
      // Chat is scoped per room server-side now — a browser that never
      // joins receives nothing, deliberately. Announce like the real UI.
      ws.send(JSON.stringify({ type: "join", roomId: ROOM }));
      setTimeout(() => resolve(ws), 120); // let the join land first
    });
  });
}

// Collects every `chat` message the browser socket receives, keyed by
// nothing in particular — tests just scan the array for what they need.
function collectChats(ws: WebSocket): any[] {
  const out: any[] = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString());
    if (parsed.type === "chat") out.push(parsed.msg);
  });
  return out;
}

describe("chat mention -> the agent just gets on with it", () => {
  test(
    "a mention runs to completion with no approval round-trip",
    async () => {
      const conn = makeRunner();
      conn.connect();
      await waitFor(() => !!agentRow("agt_chat"), 5000, "agent registered");
      expect(agentRow("agt_chat").status).toBe("idle");

      const browser = await connectBrowser();
      const chats = collectChats(browser);

      browser.send(JSON.stringify({ type: "chat", roomId: "prj_test", text: "@dev-chat can you write a hello world script" }));

      // The agent acknowledges and starts. It does not read the sentence back
      // and ask permission to act on words the human just typed.
      await waitFor(() => chats.some((c) => c.from?.id === "agt_chat"), 3000, "the agent answers in the room");
      const ack = chats.find((c) => c.from?.id === "agt_chat");
      expect(ack.ask).toBeNull();
      expect(ack.text).toMatch(/write a hello world script/i);
      expect(ack.text).not.toMatch(/Approve to run it/i);

      const task = server.db
        .prepare("SELECT * FROM tasks WHERE project_id = 'prj_test' ORDER BY rowid DESC LIMIT 1")
        .get() as any;

      // The politeness is dropped from the board's wording, but the agent is
      // given the sentence exactly as it was written.
      expect(task.title).toBe("Write a hello world script");
      expect(task.spec).toBe("can you write a hello world script");

      await waitFor(() => taskRow(task.id)?.state === "working", 3000, "task is offered and accepted without a click");
      await waitFor(() => taskRow(task.id)?.state === "completed", 8000, "task runs to completion via the fake harness");
      expect(agentRow("agt_chat")).toMatchObject({ status: "idle", waiting_on: null });

      browser.close();
      conn.stop();
    },
    20_000
  );

  test("the human is never parked waiting on their own instruction", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!agentRow("agt_chat"), 5000, "agent registered");

    const browser = await connectBrowser();
    const chats = collectChats(browser);
    browser.send(JSON.stringify({ type: "chat", roomId: "prj_test", text: "@dev-chat write a hello world script" }));

    await waitFor(() => chats.some((c) => c.from?.id === "agt_chat"), 3000, "the agent answers in the room");

    // Guards the absence-assertions below against a silent no-op.
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.some((c) => c.ask)).toBe(false);
    expect(chats.some((c) => /^Proposed:/.test(c.text ?? ""))).toBe(false);

    // needs_input is for an agent that genuinely needs an answer mid-task,
    // not for one that has just been told what to do.
    expect(agentRow("agt_chat").status).not.toBe("needs_input");
    expect(agentRow("agt_chat").waiting_on).toBeFalsy();

    browser.close();
    conn.stop();
  }, 20_000);

  test("a mention of an unknown agent name is silently ignored — no task, no crash", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!agentRow("agt_chat"), 5000, "agent registered");

    const browser = await connectBrowser();
    const chats = collectChats(browser);
    browser.send(JSON.stringify({ type: "chat", roomId: "prj_test", text: "@nobody-here do something" }));

    await waitFor(() => chats.length >= 1, 3000, "the human's own message at least echoes back");
    await new Promise((r) => setTimeout(r, 300));
    expect(chats.some((c) => c.ask)).toBe(false);
    expect(server.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toMatchObject({ n: 0 });

    browser.close();
    conn.stop();
  }, 8000);
});
