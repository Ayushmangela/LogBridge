// THE test. Every planning doc in this repo says some version of the same
// thing: leases + reconnect + idempotent results are what make this a
// distributed system instead of a demo, and this is the test that proves
// it. See SYSTEM.md §3f, DECISIONS.md D20.
//
// Scenario: a task starts, the runner is heartbeating it, the network dies
// mid-task (NOT the runner process — the agent keeps running locally), the
// server's lease sweep marks it failed after the lease expires, the network
// comes back, and the real result — which the runner produced the whole
// time — must still land exactly once, preserved rather than dropped.
//
// Lease/heartbeat timings are injected short so this runs in seconds, not
// the 60s/15s production values — see SYSTEM.md's own note that this is a
// standard, acceptable way to keep a slow-by-nature test fast.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { ChaosProxy } from "../test-support/chaosProxy.js";

const LEASE_SECONDS = 2;
const SWEEP_INTERVAL_MS = 400;

let server: BuiltServer;
let baseUrl: string;
let wsUrl: string; // through the chaos proxy — the runner never talks to the real port directly
let dataDir: string;
let proxy: ChaosProxy;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: LEASE_SECONDS, sweepIntervalMs: SWEEP_INTERVAL_MS });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`; // debug endpoints: real server, not through the proxy

  proxy = new ChaosProxy(addr.port);
  const proxyPort = await proxy.listen();
  wsUrl = `ws://127.0.0.1:${proxyPort}/node-ws`; // the runner only ever sees the proxy

  dataDir = mkdtempSync(join(tmpdir(), "logbridge-runner-test-"));

  // seed a project so buildView has a room to put the agent in
  server.db
    .prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await proxy.close();
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner(machineSuffix: string) {
  const dir = join(dataDir, machineSuffix);
  const identity = loadOrCreateIdentity(dir, `node_test_${machineSuffix}`);
  const log: string[] = [];
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity,
    machineName: `test-machine-${machineSuffix}`,
    ownerId: "usr_test",
    ownerName: "test",
    dataDir: dir,
    leaseSeconds: LEASE_SECONDS,
    agents: [
      {
        id: `agt_${machineSuffix}`,
        name: "dev-fake",
        role: "developer",
        capabilities: ["fake_work"],
        projects: ["prj_test"],
      },
    ],
    log: (m) => log.push(m),
  });
  return { conn, log, agentId: `agt_${machineSuffix}` };
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function offerTask(agentId: string, opts: { durationSeconds: number; budgetSeconds?: number }) {
  const res = await fetch(`${baseUrl}/debug/offer-task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId,
      title: "fake work",
      spec: JSON.stringify({ durationSeconds: opts.durationSeconds }),
      budgetSeconds: opts.budgetSeconds ?? 30,
    }),
  });
  const body = (await res.json()) as { taskId: string };
  return body.taskId;
}

function taskRow(taskId: string) {
  return server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
}

function eventsFor(taskId: string) {
  return server.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq").all(taskId) as any[];
}

describe("the Wi-Fi-drop test", () => {
  test(
    "network dies mid-task, agent keeps working, reconnect delivers exactly one late result",
    async () => {
      const { conn, agentId } = makeRunner("a");

      // agent.card is only sent after auth — wait for the agent to actually
      // register before offering it work.
      conn.connect();
      await waitFor(
        () => !!(server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId)),
        5000,
        "agent card registered"
      );

      // work item runs 6s — long enough to outlive a 2s lease and a network
      // outage, short enough to keep the test fast.
      const taskId = await offerTask(agentId, { durationSeconds: 6, budgetSeconds: 30 });

      await waitFor(() => taskRow(taskId)?.state === "working", 3000, "task accepted and started");

      // --- simulate the Wi-Fi dropping: a real network partition, not
      // just one dropped socket. A dropped socket alone doesn't prove
      // anything — this runner reconnects in ~1s flat, faster than any
      // sane lease, so the outage has to actually last long enough for
      // the lease to expire while genuinely unreachable. ---
      proxy.cutNetwork();

      // the lease sweep should notice and flip the task to failed —
      // *without* touching the still-running local process (the fake
      // worker keeps counting up in its own child process the whole time).
      await waitFor(
        () => taskRow(taskId)?.state === "failed",
        (LEASE_SECONDS + 2) * 1000 + SWEEP_INTERVAL_MS * 2,
        "lease expiry marks the task failed while it's still really running"
      );
      const failedEvent = eventsFor(taskId).find((e) => e.type === "lease.expired");
      expect(failedEvent, "a lease.expired event must be recorded").toBeTruthy();

      // --- network comes back ---
      proxy.restoreNetwork();
      // RunnerConnection's own backoff will reconnect it; we don't have to
      // do anything except wait. The fake work (6s total) is still running
      // in-process the whole time this network outage lasted.
      await waitFor(
        () => eventsFor(taskId).some((e) => e.type === "task.late_result"),
        10000,
        "the real result arrives after reconnect and is preserved as a late result"
      );

      // --- the invariants that actually matter ---
      const finalTask = taskRow(taskId);
      expect(finalTask.state, "a terminal state must never be overwritten by a late result").toBe("failed");

      const lateResults = eventsFor(taskId).filter((e) => e.type === "task.late_result");
      expect(lateResults, "exactly one late result — no duplicates from at-least-once redelivery").toHaveLength(1);
      const parsedBody = JSON.parse(lateResults[0].body);
      expect(parsedBody.state, "the work genuinely completed, it just arrived late").toBe("completed");

      conn.stop();
    },
    20_000
  );

  test("the budget cap kills a deliberately looping task", async () => {
    const { conn, agentId } = makeRunner("b");
    conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId), 5000, "agent registered");

    // work item claims it needs 30s; budget only allows 2s.
    const taskId = await offerTask(agentId, { durationSeconds: 30, budgetSeconds: 2 });

    await waitFor(
      () => taskRow(taskId)?.state === "failed",
      8000,
      "budget timer kills the process and reports failed within a couple seconds of the cap"
    );

    const resultEvent = eventsFor(taskId).find((e) => e.type === "task.result");
    expect(resultEvent, "a real task.result must be recorded, not just a lease-sweep failure").toBeTruthy();
    const body = JSON.parse(resultEvent!.body);
    expect(body.reason).toBe("budget_exceeded");

    conn.stop();
  }, 15_000);

  test("stop kills the process and cancels the task", async () => {
    const { conn, agentId } = makeRunner("c");
    conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId), 5000, "agent registered");

    const taskId = await offerTask(agentId, { durationSeconds: 30, budgetSeconds: 30 });
    await waitFor(() => taskRow(taskId)?.state === "working", 3000, "task started");

    const stoppedAt = Date.now();
    await fetch(`${baseUrl}/debug/stop-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, reason: "test stop" }),
    });

    expect(taskRow(taskId).state, "server marks canceled immediately, not waiting on the runner").toBe("canceled");

    // the runner must actually kill the child within ~2s of receiving task.cancel
    await waitFor(() => !(conn as any).taskRunner.has(taskId), 3000, "runner's local process is gone");
    expect(Date.now() - stoppedAt, "stop must land in under ~2s").toBeLessThan(2500);

    conn.stop();
  }, 10_000);
});
