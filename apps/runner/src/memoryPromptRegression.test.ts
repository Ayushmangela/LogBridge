// Regression: withMemories() silently disabled the fake harness's control
// channel, so `durationSeconds` reverted to the default and `askAfter` never
// fired — meaning mid-task questions could not happen in any project that had
// ever completed a task (outcomes auto-write a memory).
//
// Every existing test missed this because a `:memory:` database starts empty,
// so the FIRST task in a test always runs with zero memories. The failure only
// appears on the second task in a project — i.e. every real session. These
// tests run a task with memories already present, on purpose.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { writeMemory } from "../../server/src/db.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, withMemories } from "./connection.js";
import { fakeHarness } from "./harness/fakeHarness.js";

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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-memprompt-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const taskRow = (id: string) => server.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
const agentRow = () => server.db.prepare("SELECT * FROM agents WHERE id=?").get("agt_mem") as any;

/** Seed the room so the runner's recall returns something — the whole point. */
function seedMemories() {
  for (const text of ["Completed: an earlier task", "the deploy script needs sudo"]) {
    writeMemory(server.db, {
      projectId: "prj_test", scope: "project", scopeId: null, kind: "outcome",
      text, sourceTaskId: null, agentId: "agt_mem", agentName: "dev-mem",
    });
  }
}

function connect() {
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity: loadOrCreateIdentity(dataDir, "node_mem"),
    machineName: "mem-mbp", ownerId: "usr_test", ownerName: "test",
    dataDir, leaseSeconds: 60, harness: fakeHarness,
    agents: [{ id: "agt_mem", name: "dev-mem", role: "developer", capabilities: ["fake_work"], projects: ["prj_test"] }],
    log: () => {},
  });
  conn.connect();
  return conn;
}

const offer = async (spec: object, title = "spec-driven task") => {
  const res = await fetch(`${baseUrl}/debug/offer-task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "agt_mem", title, spec: JSON.stringify(spec), budgetSeconds: 120 }),
  });
  return ((await res.json()) as { taskId: string }).taskId;
};

describe("the control channel survives memory injection", () => {
  test("withMemories keeps the task section machine-readable", () => {
    const spec = JSON.stringify({ durationSeconds: 120, askAfter: 2 });
    const decorated = withMemories(spec, [
      { id: "m1", scope: "project", kind: "outcome", text: "Completed: x", agentName: "dev", createdAt: "" },
    ]);
    // The envelope is deliberately not JSON — that's the bug's origin.
    expect(() => JSON.parse(decorated)).toThrow();
    // ...but the task section still is, and that's what the harness reads.
    const idx = decorated.lastIndexOf("\nTask:\n");
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(decorated.slice(idx + "\nTask:\n".length))).toEqual({ durationSeconds: 120, askAfter: 2 });
  });

  test("a task WITH memories present still honours durationSeconds", async () => {
    seedMemories();
    const conn = connect();
    await waitFor(() => !!agentRow(), 6000, "agent registered");

    const id = await offer({ durationSeconds: 30 });
    await waitFor(() => taskRow(id)?.state === "working", 6000, "started");

    // Before the fix this completed in ~5s (the silent default). Still
    // running after 8s proves the spec was actually read.
    await new Promise((r) => setTimeout(r, 8000));
    expect(taskRow(id).state, "must still be working, not silently defaulted to 5s").toBe("working");

    conn.stop();
  }, 30_000);

  test("a mid-task question still fires WITH memories present", async () => {
    seedMemories();
    const conn = connect();
    await waitFor(() => !!agentRow(), 6000, "agent registered");

    const id = await offer({ durationSeconds: 60, askAfter: 1 }, "needs a decision");
    // The whole feature: the agent stops and waits for a human.
    await waitFor(() => taskRow(id)?.state === "input-required", 15000, "task waits on a human");
    expect(agentRow().status).toBe("needs_input");

    conn.stop();
  }, 30_000);
});
