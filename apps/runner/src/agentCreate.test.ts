// Runtime agent creation (HANDOFF.md prompt 1): a browser asks a machine to
// add an agent; the machine decides. Three things have to be true at once for
// this to be honest:
//   - a machine that hasn't opted in refuses (the gate is real, not UI paint)
//   - a created agent actually appears (card published without a restart)
//   - the created agent can actually WORK — its harness resolves at task time,
//     which is the part that would silently rot if only the card were checked
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-agent-create-"));

  server.db
    .prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner(machineId: string, opts: { allowAgentCreation?: boolean } = {}) {
  const dir = join(dataDir, machineId);
  const identity = loadOrCreateIdentity(dir, machineId);
  const conn = new RunnerConnection({
    serverUrl: `${wsBase}/node-ws`,
    identity,
    machineName: `machine-${machineId}`,
    ownerId: "usr_test",
    ownerName: "test",
    dataDir: dir,
    leaseSeconds: 30,
    harness: fakeHarness,
    allowAgentCreation: opts.allowAgentCreation ?? false,
    agents: [{
      id: `agt_${machineId}_seed`, name: "seed-agent", role: "developer",
      capabilities: [], projects: ["prj_test"],
    }],
    log: (m) => console.log("[runner]", machineId, m),
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

function createAgent(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "prj_test", name: "browser-made", role: "qa", ...body }),
  });
}

describe("runtime agent creation", () => {
  test("a machine that has not opted in refuses — no agent is created", async () => {
    const conn = makeRunner("node_closed");
    conn.connect();
    await waitFor(
      () => !!(server.db.prepare("SELECT online FROM machines WHERE id = ?").get("node_closed") as any)?.online,
      5000, "machine connected"
    );

    const res = await createAgent({ machineId: "node_closed" });
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/--allow-agent-creation/);

    // Nothing was born: no row, no card, nothing waiting.
    await new Promise((r) => setTimeout(r, 300));
    const agents = server.db.prepare("SELECT * FROM agents WHERE name = ?").all("browser-made");
    expect(agents).toHaveLength(0);
    conn.stop();
  });

  test("an opted-in machine creates the agent, publishes its card, and the agent runs a task", async () => {
    const conn = makeRunner("node_open", { allowAgentCreation: true });
    conn.connect();
    await waitFor(
      () => !!(server.db.prepare("SELECT online FROM machines WHERE id = ?").get("node_open") as any)?.online,
      5000, "machine connected"
    );

    const res = await createAgent({ machineId: "node_open" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; agentId: string };
    expect(body.ok).toBe(true);
    expect(body.agentId).toMatch(/^agt_node_open_browser-made/);

    // The card arrived — the agent exists server-side and is idle.
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(body.agentId), 5000, "agent card registered");
    const row = server.db.prepare("SELECT * FROM agents WHERE id = ?").get(body.agentId) as any;
    expect(row.status).toBe("idle");
    expect(row.project_id).toBe("prj_test");

    // The part that matters: give it work and watch it finish. A card alone
    // would pass even if runtime harness resolution were broken.
    const offer = await fetch(`${baseUrl}/debug/offer-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: body.agentId, title: "prove you work", spec: JSON.stringify({ durationSeconds: 1 }) }),
    });
    const { taskId } = await offer.json() as { taskId: string };
    await waitFor(() => (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state === "completed", 10_000, "created agent completed a task");
    conn.stop();
  }, 20_000);

  test("the runner enforces provider honesty: an unknown provider is refused by the machine, not the UI", async () => {
    const conn = makeRunner("node_open2", { allowAgentCreation: true });
    conn.connect();
    await waitFor(
      () => !!(server.db.prepare("SELECT online FROM machines WHERE id = ?").get("node_open2") as any)?.online,
      5000, "machine connected"
    );

    const res = await createAgent({ machineId: "node_open2", provider: "definitely-not-a-cli" });
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toMatch(/unknown provider/i);
    expect(server.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE name = 'browser-made'").get()).toMatchObject({ n: 0 });
    conn.stop();
  });

  test("creating against an offline or unknown machine fails honestly", async () => {
    const res = await createAgent({ machineId: "node_ghost" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/unknown machine|offline/);
  });

  test("a created agent survives a runner restart (created-agents.json)", async () => {
    // The split-brain this guards against: the server keeps the agent row, so
    // the office draws it and the orchestrator offers it work — but a runner
    // that forgot it would silently drop or misroute that work.
    const conn = makeRunner("node_persist", { allowAgentCreation: true });
    conn.connect();
    await waitFor(() => !!(server.db.prepare("SELECT online FROM machines WHERE id = 'node_persist'").get() as any)?.online, 5000, "machine connected");

    const res = await createAgent({ machineId: "node_persist" });
    const body = await res.json() as { ok: boolean; agentId: string };
    expect(body.ok).toBe(true);
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(body.agentId), 5000, "card registered");
    conn.stop();

    // Simulate the restart: same dataDir, fresh RunnerConnection. cli.ts does
    // exactly this merge at startup.
    const { loadCreatedAgents, mergeAgents } = await import("./createdAgents.js");
    const dir = join(dataDir, "node_persist");
    const persisted = loadCreatedAgents(dir);
    expect(persisted.some((a) => a.id === body.agentId)).toBe(true);

    const declared = [{ id: `agt_node_persist_seed`, name: "seed", role: "developer", capabilities: [], projects: ["prj_test"] }];
    const merged = mergeAgents(declared, persisted);
    expect(merged.some((a) => a.id === body.agentId)).toBe(true);
  }, 15_000);
});
