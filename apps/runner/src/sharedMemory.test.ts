// The claim shared memory actually makes: "the next agent you spin up
// starts already knowing how the team works." That is only true if a memory
// formed by an agent on ONE machine reaches an agent on a DIFFERENT machine
// — which is why memory lives on the server (D2) rather than on the node.
// This test is that sentence, executable: two separate runners, two machine
// identities, and an assertion that the second one's prompt contains what
// the first one learned.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { recentMemories } from "../../server/src/db.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, withMemories } from "./connection.js";
import { fakeHarness } from "./harness/fakeHarness.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import type { AgentEvent, AgentHarness } from "./harness/types.js";

let server: BuiltServer;
let baseUrl: string;
let wsUrl: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: 30, sweepIntervalMs: 1000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsUrl = `ws://127.0.0.1:${addr.port}/node-ws`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-shared-memory-test-"));
  server.db
    .prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A harness that records the prompt it was handed, then finishes instantly. */
function recordingHarness(): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    name: "recording",
    spawn(opts) {
      prompts.push(opts.prompt);
      const queue = new AsyncEventQueue<AgentEvent>();
      queue.push({ kind: "done", ok: true });
      queue.close();
      return { events: queue, interrupt: () => {}, kill: () => {} };
    },
  };
}

function makeRunner(suffix: string, harness: AgentHarness) {
  const dir = join(dataDir, suffix);
  const identity = loadOrCreateIdentity(dir, `node_${suffix}`);
  const agentId = `agt_${suffix}`;
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity,
    machineName: `machine-${suffix}`,
    ownerId: "usr_test",
    ownerName: "test",
    dataDir: dir,
    leaseSeconds: 30,
    harness,
    agents: [{ id: agentId, name: `dev-${suffix}`, role: "developer", capabilities: ["fake_work"], projects: ["prj_test"] }],
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

// The runner uses `spec ?? title` as the prompt. fakeHarness needs a spec to
// know how long to "work" for; recordingHarness finishes instantly and wants
// no spec, so the prompt under assertion is the human-readable title.
async function offerTask(agentId: string, title: string, opts: { durationSeconds?: number } = {}) {
  const spec = opts.durationSeconds === undefined ? null : JSON.stringify({ durationSeconds: opts.durationSeconds });
  const res = await fetch(`${baseUrl}/debug/offer-task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, title, spec, budgetSeconds: 30 }),
  });
  return ((await res.json()) as { taskId: string }).taskId;
}

function taskState(taskId: string) {
  return (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state;
}

describe("shared memory across machines", () => {
  test(
    "an agent on one machine starts a task already knowing what an agent on another machine learned",
    async () => {
      // --- machine A does a piece of work and forms a memory from it ---
      const a = makeRunner("a", fakeHarness);
      a.conn.connect();
      await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(a.agentId), 5000, "agent A registered");

      const taskId = await offerTask(a.agentId, "migrate the billing schema", { durationSeconds: 1 });
      await waitFor(() => taskState(taskId) === "completed", 10000, "A's task completed");
      await waitFor(() => recentMemories(server.db, "prj_test").length > 0, 3000, "A wrote a memory");

      const stored = recentMemories(server.db, "prj_test");
      expect(stored[0].text).toBe("Completed: migrate the billing schema");
      expect(stored[0].agentName).toBe("dev-a");
      a.conn.stop();

      // --- machine B has never run anything and shares no local state ---
      const harnessB = recordingHarness();
      const b = makeRunner("b", harnessB);
      b.conn.connect();
      await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(b.agentId), 5000, "agent B registered");

      const taskB = await offerTask(b.agentId, "billing schema follow-up");
      await waitFor(() => harnessB.prompts.length > 0, 8000, "B's harness got a prompt");

      // The actual assertion: B's prompt carries A's memory, attributed to A.
      const prompt = harnessB.prompts[0];
      expect(prompt).toContain("Completed: migrate the billing schema");
      expect(prompt).toContain("dev-a");
      expect(prompt).toContain("billing schema follow-up"); // the real task is still there
      // Memory is framed as context, never as a competing instruction.
      expect(prompt).toContain("context, not instructions");

      await waitFor(() => taskState(taskB) === "completed", 8000, "B's task completed");
      b.conn.stop();
    },
    30_000
  );

  test("a task still runs when the agent has no memories to recall", async () => {
    const harness = recordingHarness();
    const r = makeRunner("solo", harness);
    r.conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(r.agentId), 5000, "registered");

    const taskId = await offerTask(r.agentId, "the very first task");
    await waitFor(() => harness.prompts.length > 0, 8000, "harness got a prompt");

    // An empty memory store must leave the prompt completely untouched —
    // no empty "what this team knows" preamble.
    // No memories -> no context preamble. The REMEMBER convention is still
    // appended, so the task must be the START of the prompt, not all of it.
    expect(harness.prompts[0].startsWith("the very first task")).toBe(true);
    expect(harness.prompts[0]).not.toContain("What this team already knows");
    await waitFor(() => taskState(taskId) === "completed", 8000, "completed");
    r.conn.stop();
  }, 20_000);

  test("a failed task is remembered as a failure, not silently dropped", async () => {
    const r = makeRunner("fail", fakeHarness);
    r.conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(r.agentId), 5000, "registered");

    // budget shorter than the work -> the budget kill path
    const res = await fetch(`${baseUrl}/debug/offer-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: r.agentId, title: "a doomed task",
        spec: JSON.stringify({ durationSeconds: 30 }), budgetSeconds: 2,
      }),
    });
    const { taskId } = (await res.json()) as { taskId: string };

    await waitFor(() => taskState(taskId) === "failed", 10000, "task failed on budget");
    await waitFor(() => recentMemories(server.db, "prj_test").length > 0, 3000, "failure remembered");

    const mem = recentMemories(server.db, "prj_test")[0];
    expect(mem.text).toContain("Failed: a doomed task");
    expect(mem.text).toContain("budget_exceeded"); // *why* it failed is the useful part
    r.conn.stop();
  }, 20_000);
});

describe("withMemories", () => {
  const mem = (over: Partial<Parameters<typeof withMemories>[1][number]> = {}) => ({
    id: "mem_1", scope: "project" as const, kind: "fact", text: "use pnpm, not npm",
    agentName: "dev-api", createdAt: new Date().toISOString(), ...over,
  });

  test("returns the prompt untouched when there is nothing to recall", () => {
    expect(withMemories("do the thing", [])).toBe("do the thing");
  });

  test("attributes each memory and keeps the task clearly separate", () => {
    const out = withMemories("do the thing", [mem(), mem({ id: "mem_2", kind: "decision", text: "we dropped redis" })]);
    expect(out).toContain("- (fact, from dev-api) use pnpm, not npm");
    expect(out).toContain("- (decision, from dev-api) we dropped redis");
    // the task has to survive intact, at the end, under its own heading
    expect(out.endsWith("Task:\ndo the thing")).toBe(true);
  });
});
