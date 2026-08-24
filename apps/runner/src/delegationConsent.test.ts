// Per-request consent for cross-machine work (HANDOFF.md prompt 5).
// Machine-level --accept-delegations remains the outer gate; this adds the
// inner one: the FIRST request for a capability from a given owner is HELD
// unread until that machine's owner answers in the room.
//
//   once    -> runs, and the next request asks again
//   always  -> a grant row; future requests flow without asking
//   never   -> a deny-grant; future requests are refused without asking
//
// The sealed payload must stay opaque throughout — including while held.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import type { AgentEvent, AgentHarness } from "./harness/types.js";

const SECRET = "PROPRIETARY-INPUT-do-not-route-past-consent";
let server: BuiltServer;
let wsUrl: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({
    dbPath: ":memory:", leaseSeconds: 30, sweepIntervalMs: 1000,
    consentTimeoutMs: 4000,
  });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${addr.port}/node-ws`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-consent-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "t/t", "t/t", "office"
  );
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function echoHarness(): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    name: "echo",
    spawn(opts) {
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      q.push({ kind: "output", text: `ran: ${opts.prompt}` });
      q.push({ kind: "done", ok: true });
      q.close();
      return {
        events: q,
        interrupt: () => {},
        kill: () => q.close(),
        answer: () => {},
      };
    },
  };
}

function makeRunner(suffix: string, harness: AgentHarness, acceptDelegations = false) {
  const dir = join(dataDir, suffix);
  const agentId = `agt_${suffix}`;
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity: loadOrCreateIdentity(dir, `node_${suffix}`),
    machineName: `machine-${suffix}`,
    ownerId: `usr_${suffix}`,
    ownerName: suffix,
    dataDir: dir,
    leaseSeconds: 30,
    harness,
    acceptDelegations,
    agents: [{
      id: agentId, name: `dev-${suffix}`, role: "developer",
      capabilities: ["run_integration_tests"], projects: ["prj_test"],
    }],
    log: () => {},
  });
  return { conn, agentId };
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const ROOM = "prj_test";

function connectBrowser(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.app.server.address() as AddressInfo).port}/ws`);
    ws.once("open", () => {
      // Chat is scoped per room server-side now — a browser that never joins
      // receives nothing, deliberately. Announce like the real UI.
      ws.send(JSON.stringify({ type: "join", roomId: ROOM }));
      setTimeout(() => resolve(ws), 120); // let the join land first
    });
  });
}

function collectAsks(ws: WebSocket): any[] {
  const out: any[] = [];
  ws.on("message", (raw) => {
    const p = JSON.parse(raw.toString());
    if (p.type === "chat" && p.msg.ask) out.push(p.msg);
  });
  return out;
}

async function setup() {
  const harnessA = echoHarness();
  const harnessB = echoHarness();
  const a = makeRunner("a", harnessA);
  const b = makeRunner("b", harnessB, true);
  a.conn.connect();
  b.conn.connect();
  await waitFor(
    () => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey),
    6000, "peers learned"
  );
  const browser = await connectBrowser();
  return { harnessA, harnessB, a, b, browser };
}

describe("per-request delegation consent", () => {
  test("first ask holds; 'once' runs it; the next ask asks again", async () => {
    const { harnessB, a, b, browser } = await setup();
    const asks = collectAsks(browser);

    let settled: any = null;
    const promise = a.conn.delegate({
      capability: "run_integration_tests",
      targetAgentId: b.agentId,
      inputs: { prompt: SECRET },
      summary: "verify the auth suite before release",
    }).then((r) => (settled = r));

    // Held: B has NOT run anything, no grant exists, and the room was asked
    // — with the requester's SUMMARY, not the payload.
    await waitFor(() => asks.some((c) => c.ask.options.includes("approve")), 5000, "consent question in room");
    expect(harnessB.prompts, "nothing ran before consent").toHaveLength(0);
    const stored = JSON.stringify(server.db.prepare("SELECT * FROM grants").all());
    expect(stored).not.toContain("always");
    const question = asks.find((c) => c.ask.options.includes("approve"));
    expect(question.text).toContain("run_integration_tests");
    expect(question.text).toContain("verify the auth suite");
    expect(JSON.stringify(server.db.prepare("SELECT * FROM events").all())).not.toContain(SECRET);

    browser.send(JSON.stringify({ type: "answer", taskId: question.ask.taskId, choice: "approve", mode: "once" }));

    const result = await Promise.race([
      promise.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    expect(result).toBe("done");
    expect(settled.state).toBe("completed");
    expect(harnessB.prompts).toContain(SECRET); // ran after consent

    // 'once' means once: the second request asks again.
    let settled2: any = null;
    const promise2 = a.conn.delegate({
      capability: "run_integration_tests",
      targetAgentId: b.agentId,
      inputs: { prompt: "second run" },
    }).then((r) => (settled2 = r));
    await waitFor(() => asks.filter((c) => c.ask.options.includes("approve")).length >= 2, 5000, "second consent question");
    expect(harnessB.prompts).not.toContain("second run");

    browser.send(JSON.stringify({ type: "answer", taskId: asks[asks.length - 1].ask.taskId, choice: "approve", mode: "once" }));
    await Promise.race([promise2, new Promise((r) => setTimeout(r, 8000))]);
    void settled2;

    browser.close();
    a.conn.stop();
    b.conn.stop();
  }, 30_000);

  test("'always' persists a grant — later requests never ask", async () => {
    const { harnessB, a, b, browser } = await setup();
    const asks = collectAsks(browser);

    const p1 = a.conn.delegate({ capability: "run_integration_tests", targetAgentId: b.agentId, inputs: { prompt: "one" } });
    await waitFor(() => asks.length >= 1, 5000, "first question");
    browser.send(JSON.stringify({ type: "answer", taskId: asks[0].ask.taskId, choice: "approve", mode: "always" }));
    await p1;

    // The grant row exists.
    const grants = server.db.prepare("SELECT * FROM grants").all() as any[];
    expect(grants.some((g) => g.mode === "always")).toBe(true);

    // Second delegation: completes with NO new question.
    const chatCountBefore = asks.length;
    const p2 = a.conn.delegate({ capability: "run_integration_tests", targetAgentId: b.agentId, inputs: { prompt: "two" } });
    const result = await Promise.race([
      p2.then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 6000)),
    ]);
    expect(result).toBe("done");
    expect(harnessB.prompts).toContain("two");
    expect(asks.length).toBe(chatCountBefore);

    browser.close();
    a.conn.stop();
    b.conn.stop();
  }, 30_000);

  test("'never' refuses now and automatically refuses later requests", async () => {
    const { harnessB, a, b, browser } = await setup();
    const asks = collectAsks(browser);

    const p1 = a.conn.delegate({ capability: "run_integration_tests", targetAgentId: b.agentId, inputs: { prompt: SECRET } });
    await waitFor(() => asks.length >= 1, 5000, "question");
    browser.send(JSON.stringify({ type: "answer", taskId: asks[0].ask.taskId, choice: "reject", mode: "never" }));

    const r1 = await p1;
    expect(r1.state).toBe("failed");
    expect(harnessB.prompts, "denied work never ran").toHaveLength(0);

    // Standing rule: next request denied WITHOUT asking.
    const p2 = a.conn.delegate({ capability: "run_integration_tests", targetAgentId: b.agentId, inputs: { prompt: "x" } });
    const r2 = await Promise.race([p2, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    expect(r2).toMatchObject({ state: "failed" });
    expect(asks.length).toBe(1); // no second question ever appeared

    browser.close();
    a.conn.stop();
    b.conn.stop();
  }, 30_000);
});
