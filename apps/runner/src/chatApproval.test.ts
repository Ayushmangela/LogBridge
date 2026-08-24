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

function connectBrowser(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    ws.once("open", () => resolve(ws));
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

describe("chat mention -> proposal -> approval", () => {
  test(
    "approve: task actually runs to completion via the fake harness",
    async () => {
      const conn = makeRunner();
      conn.connect();
      await waitFor(() => !!agentRow("agt_chat"), 5000, "agent registered");
      expect(agentRow("agt_chat").status).toBe("idle");

      const browser = await connectBrowser();
      const chats = collectChats(browser);

      browser.send(JSON.stringify({ type: "chat", roomId: "prj_test", text: "@dev-chat write a hello world script" }));

      // The agent's own proposal comes back as a chat message with `ask` set.
      await waitFor(() => chats.some((c) => c.ask), 3000, "agent proposal chat message with ask arrives");
      const proposal = chats.find((c) => c.ask);
      expect(proposal.from).toMatchObject({ kind: "agent", id: "agt_chat" });
      expect(proposal.text).toContain("write a hello world script");
      expect(proposal.ask.options).toEqual(["approve", "reject"]);

      // The task exists but must NOT have been offered to the runner yet —
      // that's the whole point of the approval gate.
      const proposed = taskRow(proposal.ask.taskId);
      expect(proposed.state).toBe("submitted");
      expect(agentRow("agt_chat")).toMatchObject({ status: "needs_input", waiting_on: "human: you" });

      browser.send(JSON.stringify({ type: "answer", taskId: proposal.ask.taskId, choice: "approve" }));

      await waitFor(() => taskRow(proposal.ask.taskId)?.state === "working", 3000, "approved task actually gets offered and accepted");
      await waitFor(() => taskRow(proposal.ask.taskId)?.state === "completed", 8000, "task runs to completion via the fake harness");
      expect(agentRow("agt_chat")).toMatchObject({ status: "idle", waiting_on: null });

      browser.close();
      conn.stop();
    },
    20_000
  );

  test("reject: task is marked rejected, agent returns to idle, nothing is ever offered to the runner", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!agentRow("agt_chat"), 5000, "agent registered");

    const browser = await connectBrowser();
    const chats = collectChats(browser);

    browser.send(JSON.stringify({ type: "chat", roomId: "prj_test", text: "@dev-chat delete the production database" }));
    await waitFor(() => chats.some((c) => c.ask), 3000, "proposal arrives");
    const proposal = chats.find((c) => c.ask);

    browser.send(JSON.stringify({ type: "answer", taskId: proposal.ask.taskId, choice: "reject" }));

    await waitFor(() => taskRow(proposal.ask.taskId)?.state === "rejected", 3000, "task marked rejected");
    await waitFor(() => agentRow("agt_chat")?.status === "idle", 3000, "agent released back to idle");
    expect(agentRow("agt_chat").waiting_on).toBeNull();

    // Give the fake harness a beat — if it were ever (wrongly) offered the
    // task, it would flip to "working" almost immediately.
    await new Promise((r) => setTimeout(r, 300));
    expect(taskRow(proposal.ask.taskId).state).toBe("rejected");

    browser.close();
    conn.stop();
  }, 10_000);

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
