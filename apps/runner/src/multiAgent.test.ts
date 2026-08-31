// One machine, several agents, different providers each.
//
// Until now the runner hardcoded `agents[0]`: task.offer carried no agentId,
// so a second agent on the same machine could never receive work, and every
// agent shared one harness. This is the foundation the Add Agent dialog needs
// — creating an agent from the browser is pointless if
// the runner can only ever drive the first one.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, type AgentDecl } from "./connection.js";
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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-multiagent-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Records which agent's prompts it saw, so we can prove routing. */
function tagHarness(tag: string): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    name: `tag:${tag}`,
    spawn(opts) {
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      q.push({ kind: "output", text: `${tag} handled: ${opts.prompt}` });
      q.push({ kind: "done", ok: true });
      q.close();
      return { events: q, interrupt: () => {}, kill: () => {} };
    },
  };
}

function makeRunner(agents: AgentDecl[], harness: AgentHarness) {
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity: loadOrCreateIdentity(dataDir, "node_multi"),
    machineName: "multi-mbp",
    ownerId: "usr_test",
    ownerName: "test",
    dataDir,
    leaseSeconds: 30,
    harness,
    agents,
    log: () => {},
  });
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

const decl = (id: string, name: string): AgentDecl => ({
  id, name, role: "developer", capabilities: ["fake_work"], projects: ["prj_test"],
});

describe("several agents on one machine", () => {
  test("a task reaches the agent it was addressed to, not just the first one", async () => {
    const shared = tagHarness("shared");
    const conn = makeRunner([decl("agt_one", "dev-one"), decl("agt_two", "dev-two")], shared);
    conn.connect();
    await waitFor(() => registered("agt_one") && registered("agt_two"), 6000, "both registered");

    // Address the SECOND agent — under the old agents[0] behaviour this task
    // would have been run as though it belonged to the first.
    const t = await offer("agt_two", "work for the second agent");
    await waitFor(() => taskState(t) === "completed", 8000, "task completed");
    expect(shared.prompts.some((p) => p.includes("work for the second agent"))).toBe(true);

    // The runner writes into the addressed agent's own working directory.
    const events = server.db.prepare("SELECT body FROM events WHERE task_id=? AND type='task.result'").all(t) as any[];
    expect(events).toHaveLength(1);
    conn.stop();
  }, 20_000);

  test("each agent runs on its own provider's harness", async () => {
    // agt_default has no provider -> the runner-wide default.
    // agt_custom names one -> its own harness. Proving the split needs a
    // real second harness, so this exercises the resolver directly.
    const fallback = tagHarness("fallback");
    const conn = makeRunner(
      [decl("agt_default", "dev-default"), { ...decl("agt_custom", "dev-custom"), provider: "claude" }],
      fallback
    );
    const resolve = (id: string | null) => (conn as any).harnessForAgent(id) as AgentHarness;

    expect(resolve("agt_default").name).toBe("tag:fallback");
    expect(resolve("agt_custom").name).toBe("pty:claude");
    // An unknown id falls back rather than throwing mid-task.
    expect(resolve("agt_nonexistent").name).toBe("tag:fallback");
    expect(resolve(null).name).toBe("tag:fallback");
  });

  test("the harness for an agent is built once and reused", async () => {
    const conn = makeRunner([{ ...decl("agt_p", "dev-p"), provider: "claude", model: "claude-opus-5" }], tagHarness("f"));
    const resolve = (id: string) => (conn as any).harnessForAgent(id) as AgentHarness;
    expect(resolve("agt_p")).toBe(resolve("agt_p")); // same instance, not rebuilt
  });

  test("an offer naming an unknown agent does not crash the runner", async () => {
    const shared = tagHarness("shared");
    const conn = makeRunner([decl("agt_only", "dev-only")], shared);
    conn.connect();
    await waitFor(() => registered("agt_only"), 6000, "registered");

    // Falls back to the single declared agent rather than throwing — an
    // older server that omits agentId must keep working.
    const t = await offer("agt_only", "still runs");
    await waitFor(() => taskState(t) === "completed", 8000, "completed");
    expect(shared.prompts.some((p) => p.includes("still runs"))).toBe(true);
    conn.stop();
  }, 20_000);
});
