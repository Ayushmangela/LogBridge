// Editing a proposal (HANDOFF.md prompt 4): the human can rewrite a task
// before it runs — but only while it is `submitted`. The state machine is
// enforced, not advisory, so editing after acceptance is refused and logged.
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
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-edit-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "t/t", "t/t", "office"
  );
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner() {
  const identity = loadOrCreateIdentity(dataDir, "node_edit");
  const conn = new RunnerConnection({
    serverUrl: `${wsBase}/node-ws`,
    identity, machineName: "edit-machine",
    ownerId: "usr_test", ownerName: "test",
    dataDir, leaseSeconds: 30, harness: fakeHarness,
    agents: [{ id: "agt_e", name: "dev-e", role: "developer", capabilities: [], projects: ["prj_test"] }],
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

const ROOM = "prj_test";

function connectBrowser(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    ws.once("open", () => {
      // Chat is scoped per room server-side now — a browser that never
      // joins receives nothing, deliberately. Announce like the real UI.
      ws.send(JSON.stringify({ type: "join", roomId: ROOM }));
      setTimeout(() => resolve(ws), 120); // let the join land first
    });
  });
}

/** A task sitting in `submitted`, which is the only state edit applies to.
 *
 *  This used to come from a chat mention, back when "@dev-e initial wording"
 *  parked a proposal awaiting the human's approval. A human instruction is no
 *  longer gated that way — it dispatches on arrival — so the task is created
 *  directly here instead. What these two tests are actually about is the
 *  state machine (`submitted` is editable, anything past it is not), and that
 *  guarantee is unchanged by where the task came from. */
async function propose(_browser: WebSocket): Promise<string> {
  const { createTask } = await import("../../server/src/db/tasks.js");
  return createTask(server.db, {
    projectId: "prj_test",
    title: "initial wording",
    spec: "initial wording",
    creatorId: "you",
    agentId: "agt_e",
  });
}

describe("editing a proposed task", () => {
  test("edit rewrites the task while submitted; approval runs the EDITED text; activity records it", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT * FROM agents WHERE id = 'agt_e'").get(), 5000, "agent registered");

    const browser = await connectBrowser();
    const taskId = await propose(browser);

    browser.send(JSON.stringify({ type: "answer", taskId, choice: "edit", text: "the corrected wording" }));
    await waitFor(() => (server.db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as any)?.title === "the corrected wording", 5000, "title updated");

    // Logged, so the feed can narrate it.
    expect(server.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.edit'").get(taskId)).toMatchObject({ n: 1 });

    // Approve → the runner receives the edited text as its prompt.
    browser.send(JSON.stringify({ type: "answer", taskId, choice: "approve" }));
    await waitFor(() => (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state === "completed", 10_000, "edited task ran");
    const specRow = server.db.prepare("SELECT spec, title FROM tasks WHERE id = ?").get(taskId) as any;
    expect(specRow.title).toBe("the corrected wording");
    expect(specRow.spec).toBe("the corrected wording"); // what the CLI was actually given

    // Activity wording exists server-side (invariant 2 — UI only renders).
    const { recentActivity } = await import("../../server/src/activity.js");
    const items = recentActivity(server.db, "prj_test", 30);
    expect(items.some((i) => i.type === "task.edit" && i.summary.includes("revised")), "task.edit has feed wording").toBe(true);

    browser.close();
    conn.stop();
  }, 25_000);

  test("editing after acceptance is refused — state machine is not advisory", async () => {
    const conn = makeRunner();
    conn.connect();
    await waitFor(() => !!server.db.prepare("SELECT * FROM agents WHERE id = 'agt_e'").get(), 5000, "agent registered");

    const browser = await connectBrowser();
    const taskId = await propose(browser);
    browser.send(JSON.stringify({ type: "answer", taskId, choice: "approve" }));
    await waitFor(() => (server.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as any)?.state === "working", 8000, "task accepted and working");

    const errors: any[] = [];
    browser.on("message", (raw) => {
      const p = JSON.parse(raw.toString());
      if (p.type === "error") errors.push(p.error);
    });
    browser.send(JSON.stringify({ type: "answer", taskId, choice: "edit", text: "too late" }));

    await waitFor(() => errors.some((e) => String(e).includes("Too late")), 5000, "browser told the edit was refused");
    expect((server.db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as any)?.title).not.toBe("too late");
    expect(server.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.edit.refused'").get(taskId)).toMatchObject({ n: 1 });

    browser.close();
    conn.stop();
  }, 20_000);
});
