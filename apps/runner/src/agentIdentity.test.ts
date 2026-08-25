// Who an agent IS, as opposed to what it is doing.
//
// The Add Agent wizard lets a person choose a sprite, a colour, a folder and
// a briefing. None of that is worth anything if it evaporates on the next
// runner restart, or if a reconnecting runner silently overwrites something a
// human typed in the browser. Both are easy mistakes and both are tested here.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, type AgentDecl } from "./connection.js";
import { loadCreatedAgents, mergeAgents } from "./createdAgents.js";
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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-identity-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function quietHarness(): AgentHarness {
  return {
    name: "quiet",
    spawn() {
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

function connect(agents: AgentDecl[]) {
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity: loadOrCreateIdentity(dataDir, "node_ident"),
    machineName: "ident-mbp", ownerId: "usr_test", ownerName: "test",
    dataDir, leaseSeconds: 60, harness: quietHarness(), agents,
    allowAgentCreation: true, log: () => {},
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

const rowFor = (id: string) =>
  server.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;

const IDENTITY = {
  character: "lucy",
  color: "#c05d5d",
  folder: "/Users/someone/code/api",
  isolation: "worktree" as const,
  description: "runs the floor",
  goal: "keep the payments service green",
};

async function createAgent(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineId: "node_ident", projectId: "prj_test", name: "made-in-browser",
      ...IDENTITY, ...extra,
    }),
  });
  return (await res.json()) as { ok: boolean; agentId: string; error?: string };
}

describe("identity chosen in the browser", () => {
  test("reaches the server and survives a runner restart", async () => {
    const first = connect([decl("agt_base", "dev-base")]);
    await waitFor(() => !!rowFor("agt_base"), 6000, "base agent registered");

    const created = await createAgent();
    expect(created.ok, created.error ?? "").toBe(true);
    await waitFor(() => !!rowFor(created.agentId), 6000, "created agent registered");

    const row = rowFor(created.agentId);
    expect(row.character).toBe("lucy");
    expect(row.color).toBe("#c05d5d");
    expect(row.folder).toBe("/Users/someone/code/api");
    expect(row.isolation).toBe("worktree");
    expect(row.description).toBe("runs the floor");
    expect(row.goal).toBe("keep the payments service green");

    // On disk, not just in memory — a restart is the real test.
    const onDisk = loadCreatedAgents(dataDir).find((a) => a.id === created.agentId);
    expect(onDisk?.character).toBe("lucy");
    expect(onDisk?.folder).toBe("/Users/someone/code/api");

    first.stop();
    await new Promise((r) => setTimeout(r, 300));

    // Wipe the server's memory of it, then restart the runner exactly as
    // cli.ts would. The identity has to come back from the runner's disk.
    server.db.prepare("DELETE FROM agents WHERE id = ?").run(created.agentId);
    const second = connect(mergeAgents([decl("agt_base", "dev-base")], loadCreatedAgents(dataDir)));
    await waitFor(() => !!rowFor(created.agentId), 6000, "re-registered after restart");

    expect(rowFor(created.agentId).character, "identity must survive a restart").toBe("lucy");
    expect(rowFor(created.agentId).goal).toBe("keep the payments service green");
    second.stop();
  }, 40_000);

  test("an agent created without any identity still works", async () => {
    // Every agent that existed before this shipped has none of it. A null is
    // a missing preference, never a missing agent.
    const conn = connect([decl("agt_plain", "dev-plain")]);
    await waitFor(() => !!rowFor("agt_plain"), 6000, "registered");

    const row = rowFor("agt_plain");
    expect(row.character).toBeNull();
    expect(row.folder).toBeNull();
    expect(row.name).toBe("dev-plain");
    conn.stop();
  }, 20_000);

  test("a reconnecting runner does NOT wipe a note typed in the browser", async () => {
    // The bug this exists for: `note` is the one identity field a human edits
    // in the browser rather than declaring on the machine. If it rode along
    // on agent.card like the others, every reconnect would erase it — and
    // reconnects are routine, so the note would vanish seemingly at random.
    const conn = connect([decl("agt_noted", "dev-noted")]);
    await waitFor(() => !!rowFor("agt_noted"), 6000, "registered");

    server.db.prepare("UPDATE agents SET note = ? WHERE id = ?")
      .run("flaky on the staging box", "agt_noted");

    conn.stop();
    await new Promise((r) => setTimeout(r, 300));
    const again = connect([decl("agt_noted", "dev-noted")]);
    await waitFor(() => !!rowFor("agt_noted"), 6000, "re-registered");
    // Give the card a moment to land and do its damage, if it were going to.
    await new Promise((r) => setTimeout(r, 400));

    expect(rowFor("agt_noted").note, "a human's note must outlive a reconnect")
      .toBe("flaky on the staging box");
    again.stop();
  }, 30_000);

  test("a long briefing is capped rather than stored unbounded", async () => {
    const conn = connect([decl("agt_base2", "dev-base2")]);
    await waitFor(() => !!rowFor("agt_base2"), 6000, "registered");

    const created = await createAgent({
      name: "verbose", description: "d".repeat(500), goal: "g".repeat(5000),
    });
    expect(created.ok).toBe(true);
    await waitFor(() => !!rowFor(created.agentId), 6000, "registered");

    const row = rowFor(created.agentId);
    expect(row.description.length).toBeLessThanOrEqual(120);
    expect(row.goal.length).toBeLessThanOrEqual(2000);
    conn.stop();
  }, 30_000);
});
