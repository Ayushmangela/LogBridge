// Two defects found reviewing the runtime-agent-creation feature:
//
// 1. Created agents lived only in the runner's memory. On restart the server
//    kept the agent row — so the office drew it and the orchestrator counted
//    it as capacity — while the runner had never heard of it.
// 2. Worse, a task naming an agent the runner didn't have fell back to
//    `agents[0]`, silently running the work under a different provider and a
//    different tool policy than whoever queued it believed.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, type AgentDecl } from "./connection.js";
import { createdAgentsPath, loadCreatedAgents, mergeAgents, saveCreatedAgents } from "./createdAgents.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import type { AgentEvent, AgentHarness } from "./harness/types.js";

let server: BuiltServer;
let baseUrl: string;
let wsUrl: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: 60, sweepIntervalMs: 2000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsUrl = `ws://127.0.0.1:${addr.port}/node-ws`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-persist-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function tagHarness(tag: string): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts, name: `tag:${tag}`,
    spawn(opts) {
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      q.push({ kind: "done", ok: true });
      q.close();
      return { events: q, interrupt: () => {}, kill: () => {} };
    },
  };
}

const decl = (id: string, name: string): AgentDecl => ({
  id, name, role: "developer", capabilities: [], projects: ["prj_test"],
});

function connect(agents: AgentDecl[], harness: AgentHarness, allowCreate = true) {
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity: loadOrCreateIdentity(dataDir, "node_persist"),
    machineName: "persist-mbp", ownerId: "usr_test", ownerName: "test",
    dataDir, leaseSeconds: 60, harness, agents,
    allowAgentCreation: allowCreate,
    log: () => {},
  });
  conn.connect();
  return conn;
}

async function waitFor(check: () => boolean, ms: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const agentRows = () => server.db.prepare("SELECT id,name FROM agents").all() as any[];
const taskRow = (id: string) => server.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;

// ---------------------------------------------------------------- storage

describe("created-agents storage", () => {
  test("round-trips through disk", () => {
    const a = [{ ...decl("agt_x", "dev-x"), provider: "claude", model: "m" }];
    saveCreatedAgents(dataDir, a);
    expect(loadCreatedAgents(dataDir)).toEqual(a);
  });

  test("no file yet is empty, not an error", () => {
    expect(loadCreatedAgents(join(dataDir, "nope"))).toEqual([]);
  });

  test("a corrupt file costs the agents, not the whole startup", () => {
    writeFileSync(createdAgentsPath(dataDir), "{not json");
    const logged: string[] = [];
    expect(loadCreatedAgents(dataDir, (m) => logged.push(m))).toEqual([]);
    expect(logged.join(" ")).toMatch(/could not read/);
  });

  test("one malformed entry doesn't discard the good ones", () => {
    writeFileSync(createdAgentsPath(dataDir), JSON.stringify([decl("agt_ok", "ok"), { junk: true }]));
    const loaded = loadCreatedAgents(dataDir, () => {});
    expect(loaded.map((a) => a.id)).toEqual(["agt_ok"]);
  });

  test("declared config wins over a persisted agent with the same id", () => {
    const declared = [{ ...decl("agt_dup", "declared-name") }];
    const created = [{ ...decl("agt_dup", "stale-name") }, decl("agt_new", "new")];
    const merged = mergeAgents(declared, created);
    expect(merged.map((a) => a.name)).toEqual(["declared-name", "new"]);
  });
});

// ------------------------------------------------------------ end to end

describe("a browser-created agent survives a runner restart", () => {
  test("it is reloaded and can still run work", async () => {
    const first = connect([decl("agt_base", "dev-base")], tagHarness("h1"));
    await waitFor(() => agentRows().length >= 1, 6000, "base agent registered");

    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: "node_persist", projectId: "prj_test", name: "made-in-browser" }),
    });
    const created = (await res.json()) as { ok: boolean; agentId: string };
    expect(created.ok).toBe(true);
    await waitFor(() => agentRows().some((a) => a.id === created.agentId), 6000, "created agent registered");

    // It must be on disk, not just in memory — that's the whole fix.
    expect(loadCreatedAgents(dataDir).map((a) => a.id)).toContain(created.agentId);
    first.stop();
    await new Promise((r) => setTimeout(r, 300));

    // Restart with ONLY the declared agent, exactly as cli.ts would...
    const restored = mergeAgents([decl("agt_base", "dev-base")], loadCreatedAgents(dataDir));
    expect(restored.map((a) => a.id)).toContain(created.agentId);

    const h2 = tagHarness("h2");
    const second = connect(restored, h2);
    await waitFor(() => agentRows().some((a) => a.id === created.agentId), 6000, "still known after restart");

    // ...and it can still be given work.
    const offer = await fetch(`${baseUrl}/debug/offer-task`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: created.agentId, title: "post-restart work", budgetSeconds: 30 }),
    });
    const { taskId } = (await offer.json()) as { taskId: string };
    await waitFor(() => taskRow(taskId)?.state === "completed", 10000, "task completed after restart");
    // The task prompt now carries the REMEMBER convention appended to it,
    // so assert the task is IN the prompt rather than equal to it.
    expect(h2.prompts.some((p) => p.includes("post-restart work"))).toBe(true);

    second.stop();
  }, 40_000);

  test("a task naming an unknown agent fails loudly instead of running on the wrong one", async () => {
    // The dangerous case: work meant for agent B silently executed by agent A,
    // under A's provider and A's tool policy.
    const h = tagHarness("only");
    const conn = connect([decl("agt_only", "dev-only")], h);
    await waitFor(() => agentRows().length >= 1, 6000, "registered");

    server.db.prepare(
      `INSERT INTO tasks (id, project_id, title, creator_id, agent_id, state, cost_usd, created_at)
       VALUES ('tsk_ghost','prj_test','work for a vanished agent','test','agt_vanished','submitted',0,?)`
    ).run(new Date().toISOString());
    server.db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
       VALUES ('agt_vanished','node_persist','usr_test','prj_test','ghost','developer','[]',1,'idle')`
    ).run();

    const { sendTaskOffer } = await import("../../server/src/nodeGateway.js");
    sendTaskOffer(server.db, server.nodeSockets, "tsk_ghost");

    await waitFor(() => taskRow("tsk_ghost")?.state === "failed", 8000, "task failed rather than misrouting");
    expect(h.prompts, "the wrong agent must not have run it").toHaveLength(0);

    conn.stop();
  }, 25_000);
});
