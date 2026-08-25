// Two things an agent could not previously tell anyone.
//
// 1. PROGRESS. A task was a black box between "started" and "done": a 40
//    minute run and a 4 second run looked identical. Providers emit real step
//    boundaries (opencode's step_start, claude's assistant turns), so the
//    count is observable — but the TOTAL is not, which is why this is a count
//    and never a percentage.
//
// 2. REMEMBER. Shared memory only ever stored outcomes the runner inferred
//    ("Completed: <title>"). The agent — the thing that actually learned
//    something — had no way to say "this is worth keeping". That made the
//    premise of shared memory half true: the next agent inherited a list of
//    task titles, not knowledge.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { recentMemories } from "../../server/src/db.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, type AgentDecl } from "./connection.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import { providerById, rememberFrom, rememberInstruction } from "./harness/providers.js";
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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-agentmem-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A harness that emits a scripted event list, then finishes. */
function scriptedHarness(events: AgentEvent[]): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts, name: "scripted",
    spawn(opts) {
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      for (const e of events) q.push(e);
      q.push({ kind: "done", ok: true });
      q.close();
      return { events: q, interrupt: () => {}, kill: () => {} };
    },
  };
}

const decl = (id: string, name: string): AgentDecl => ({
  id, name, role: "developer", capabilities: ["fake_work"], projects: ["prj_test"],
});

function makeRunner(agents: AgentDecl[], harness: AgentHarness) {
  return new RunnerConnection({
    serverUrl: wsUrl, identity: loadOrCreateIdentity(dataDir, "node_mem"),
    machineName: "mem-mbp", ownerId: "usr_test", ownerName: "test",
    dataDir, leaseSeconds: 30, harness, agents, log: () => {},
  });
}

async function waitFor(check: () => boolean, ms: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const offer = async (agentId: string, title: string) => {
  const res = await fetch(`${baseUrl}/debug/offer-task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, title, budgetSeconds: 30 }),
  });
  return ((await res.json()) as { taskId: string }).taskId;
};
const taskState = (id: string) =>
  (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(id) as any)?.state;
const registered = (id: string) => !!server.db.prepare("SELECT 1 FROM agents WHERE id=?").get(id);
const eventsFor = (taskId: string) =>
  (server.db.prepare("SELECT body FROM events WHERE task_id=? AND type='task.event'").all(taskId) as any[])
    .map((r) => JSON.parse(r.body));

// ------------------------------------------------------- parsing (pure)

describe("the REMEMBER convention", () => {
  test("a line the agent marked becomes a remember event", () => {
    expect(rememberFrom("REMEMBER: this repo uses pnpm, never npm")).toEqual({
      kind: "remember", memoryKind: "fact", text: "this repo uses pnpm, never npm",
    });
  });

  test("ordinary output is left alone", () => {
    expect(rememberFrom("I'll remember to check that later")).toBeNull();
    expect(rememberFrom("done")).toBeNull();
  });

  test("it is found mid-line, since CLIs prefix and wrap output", () => {
    const e = rememberFrom("  ⏺ REMEMBER: the staging DB resets nightly");
    expect(e).toMatchObject({ kind: "remember", text: "the staging DB resets nightly" });
  });

  test("the instruction tells the agent it is fine to skip", () => {
    // Without this every task produces a memory, and a store of noise is
    // worse than an empty one — recall surfaces the noise instead of facts.
    expect(rememberInstruction()).toMatch(/skip it/i);
    expect(rememberInstruction()).toContain("REMEMBER:");
  });
});

describe("step boundaries are real, not invented", () => {
  test("claude: an assistant turn is one step", () => {
    const e = providerById("claude")!.parseLine(JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text: "hi" }] },
    }));
    expect(e.filter((x) => x.kind === "progress")).toHaveLength(1);
  });

  test("opencode: a step_start is one step", () => {
    const e = providerById("opencode")!.parseLine(JSON.stringify({ type: "step_start", part: {} }));
    expect(e.filter((x) => x.kind === "progress")).toHaveLength(1);
  });

  test("no provider reports a percentage, because the total is unknowable", () => {
    const all = [
      ...providerById("claude")!.parseLine(JSON.stringify({
        type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })),
      ...providerById("opencode")!.parseLine(JSON.stringify({ type: "step_start", part: {} })),
    ];
    for (const e of all.filter((x) => x.kind === "progress")) {
      expect(Object.keys(e)).not.toContain("percent");
      expect(Object.keys(e)).not.toContain("total");
    }
  });
});

// ------------------------------------------------------------ end to end

describe("an agent that decides something is worth remembering", () => {
  test("the fact reaches the shared store, and a later agent recalls it", async () => {
    const h = scriptedHarness([
      { kind: "remember", memoryKind: "fact", text: "the payments API rejects requests without an Idempotency-Key" },
    ]);
    const conn = makeRunner([decl("agt_one", "dev-one")], h);
    conn.connect();
    await waitFor(() => registered("agt_one"), 6000, "registered");

    const t = await offer("agt_one", "fix the checkout timeout");
    await waitFor(() => taskState(t) === "completed", 8000, "completed");
    await waitFor(
      () => recentMemories(server.db, "prj_test").some((m) => m.kind === "fact"),
      3000, "the agent's fact was stored"
    );

    const fact = recentMemories(server.db, "prj_test").find((m) => m.kind === "fact")!;
    expect(fact.text).toBe("the payments API rejects requests without an Idempotency-Key");
    // Attribution matters: recall renders "from <agent>", and a fact credited
    // to the wrong teammate is worse than an unattributed one.
    expect(fact.agentName).toBe("dev-one");
    conn.stop();
  }, 20_000);

  test("the agent is TOLD the convention, or it can never use it", async () => {
    const h = scriptedHarness([]);
    const conn = makeRunner([decl("agt_p", "dev-p")], h);
    conn.connect();
    await waitFor(() => registered("agt_p"), 6000, "registered");

    const t = await offer("agt_p", "some task");
    await waitFor(() => h.prompts.length > 0, 8000, "prompted");
    expect(h.prompts[0]).toContain("REMEMBER:");
    // ...without burying the task it was actually given.
    expect(h.prompts[0]).toContain("some task");
    await waitFor(() => taskState(t) === "completed", 8000, "completed");
    conn.stop();
  }, 20_000);

  test("a memory is credited to the agent that ran the task, not agents[0]", async () => {
    // The dangerous version of this bug is quiet: everything works, and the
    // team slowly attributes one agent's knowledge to another.
    const h = scriptedHarness([{ kind: "remember", memoryKind: "decision", text: "we dropped redis" }]);
    const conn = makeRunner([decl("agt_first", "dev-first"), decl("agt_second", "dev-second")], h);
    conn.connect();
    await waitFor(() => registered("agt_first") && registered("agt_second"), 6000, "both registered");

    const t = await offer("agt_second", "work for the second agent");
    await waitFor(() => taskState(t) === "completed", 8000, "completed");
    await waitFor(
      () => recentMemories(server.db, "prj_test").some((m) => m.kind === "decision"),
      3000, "stored"
    );

    const mem = recentMemories(server.db, "prj_test").find((m) => m.kind === "decision")!;
    expect(mem.agentName, "credited to the agent that actually ran it").toBe("dev-second");
    conn.stop();
  }, 20_000);
});

describe("a running task reports how far it has got", () => {
  test("step boundaries arrive as events the office can render", async () => {
    const h = scriptedHarness([
      { kind: "progress", step: 1 },
      { kind: "output", text: "reading the schema" },
      { kind: "progress", step: 1 },
    ]);
    const conn = makeRunner([decl("agt_s", "dev-s")], h);
    conn.connect();
    await waitFor(() => registered("agt_s"), 6000, "registered");

    const t = await offer("agt_s", "a task with visible steps");
    await waitFor(() => taskState(t) === "completed", 8000, "completed");

    const steps = eventsFor(t).filter((e) => typeof e.data?.steps === "number");
    expect(steps.length, "both boundaries reported").toBe(2);
    // Counted cumulatively by the runner — the provider only says "a step
    // happened", it does not track how many.
    expect(steps.map((e) => e.data.steps)).toEqual([1, 2]);
    conn.stop();
  }, 20_000);
});
