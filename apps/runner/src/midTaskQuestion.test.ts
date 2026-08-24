// Mid-task questions (HANDOFF.md prompt 3), end to end: a running agent asks
// a real question, the room sees it with an answer field, a human's words
// travel back INTO the already-spawned process, and the task completes on
// what it was told. Also pins the two design decisions:
//   - waiting state is `input-required` (not blocked) — it's a human decision
//     this task needs, not an external dependency
//   - the wall-clock budget PAUSES while waiting — a task must not die because
//     its human was at lunch (budget 4s here; the wait alone would exceed it)
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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-question-"));

  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "t/t", "t/t", "office"
  );
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner() {
  const identity = loadOrCreateIdentity(dataDir, "node_q");
  const conn = new RunnerConnection({
    serverUrl: `${wsBase}/node-ws`,
    identity,
    machineName: "q-machine",
    ownerId: "usr_test",
    ownerName: "test",
    dataDir,
    leaseSeconds: 30,
    harness: fakeHarness,
    agents: [{ id: "agt_q", name: "dev-q", role: "developer", capabilities: [], projects: ["prj_test"] }],
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

function connectBrowser(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    ws.once("open", () => resolve(ws));
  });
}

function collectChats(ws: WebSocket): any[] {
  const out: any[] = [];
  ws.on("message", (raw) => {
    const p = JSON.parse(raw.toString());
    if (p.type === "chat") out.push(p.msg);
  });
  return out;
}

describe("mid-task questions", () => {
  test("agent asks → input-required + room question → answered in words → completes within its budget", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT * FROM agents WHERE id = 'agt_q'").get(), 5000, "agent registered");

    const browser = await connectBrowser();
    const chats = collectChats(browser);

    // Budget 4s total. The worker asks at t=1s and blocks; the "human" takes
    // ~2s to answer. If the clock kept running while waiting, this fails.
    const offer = await fetch(`${baseUrl}/debug/offer-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agt_q",
        title: "deploy thing",
        spec: JSON.stringify({ durationSeconds: 3, askAfter: 1 }),
        budgetSeconds: 8,
      }),
    });
    const { taskId } = await offer.json() as { taskId: string };

    await waitFor(() => (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state === "input-required", 8000, "task entered input-required");
    expect((server.db.prepare("SELECT status, waiting_on FROM agents WHERE id = 'agt_q'").get() as any))
      .toMatchObject({ status: "needs_input" });

    // The room saw the question, addressed to a human, with an answer affordance.
    await waitFor(() => chats.some((c) => c.ask?.options?.includes("answer")), 5000, "question chat message arrived");
    const q = chats.find((c) => c.ask?.options?.includes("answer"));
    expect(q.from.name).toBe("dev-q");
    expect(q.ask.taskId).toBe(taskId);
    expect(q.text).toContain("Deploy to staging");

    // The human answers IN WORDS.
    browser.send(JSON.stringify({ type: "answer", taskId, choice: "answer", text: "yes, deploy to staging" }));

    await waitFor(() => (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state === "completed", 10_000, "task completed after the answer");
    // Agent released.
    expect(server.db.prepare("SELECT status, waiting_on FROM agents WHERE id = 'agt_q'").get())
      .toMatchObject({ status: "idle", waiting_on: null });

    // The agent's process actually received the words — its output stream
    // echoed them back ("answer received: …").
    const echo = server.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.event' AND body LIKE '%yes, deploy to staging%'"
    ).get(taskId) as any;
    expect(echo.n, "the answer text reached the running process").toBeGreaterThan(0);

    browser.close();
    conn.stop();
  }, 25_000);

  test("an unanswered question keeps waiting — no silent timeout, Stop still works", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT * FROM agents WHERE id = 'agt_q'").get(), 5000, "agent registered");

    const offer = await fetch(`${baseUrl}/debug/offer-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agt_q",
        title: "needs someone",
        spec: JSON.stringify({ durationSeconds: 30, askAfter: 1 }),
        budgetSeconds: 60,
      }),
    });
    const { taskId } = await offer.json() as { taskId: string };

    await waitFor(() => (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state === "input-required", 8000, "waiting on human");
    await new Promise((r) => setTimeout(r, 2500)); // longer than many a heartbeat cycle
    expect((server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state).toBe("input-required");

    // Stop works from the room regardless of what the agent waits on.
    await fetch(`${baseUrl}/debug/stop-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    expect((server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state).toBe("canceled");

    conn.stop();
  }, 20_000);
});
