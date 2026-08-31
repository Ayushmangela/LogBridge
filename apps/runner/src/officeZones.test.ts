// Automates the "office comes alive" acceptance test, which until now only
// existed as a manual demo step: "the character walks into the open office → finishes
// → moves to the table tennis room. Nothing else in the room moves." That's
// a claim about buildView()'s zone output tracking a real task's lifecycle
// through the real server+runner wire, not just zoneFor() in isolation
// (covered by protocol/bodies.test.ts) or buildView() against hand-seeded
// rows (covered by server/view.test.ts). Neither of those proves the wiring
// between "a task actually ran" and "the office view reflects it" — this
// does, the same way wifiDrop.test.ts automates M2's acceptance test instead
// of leaving it as an eyeball check.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { Positions, buildView } from "../../server/src/view.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { fakeHarness } from "./harness/fakeHarness.js";

const LEASE_SECONDS = 30; // generous — this test isn't exercising lease expiry

let server: BuiltServer;
let baseUrl: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: LEASE_SECONDS, sweepIntervalMs: 1000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-office-zones-test-"));

  server.db
    .prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner(machineSuffix: string, agentDefs: { id: string; name: string }[]) {
  const dir = join(dataDir, machineSuffix);
  const identity = loadOrCreateIdentity(dir, `node_test_${machineSuffix}`);
  const conn = new RunnerConnection({
    serverUrl: `ws://127.0.0.1:${new URL(baseUrl).port}/node-ws`,
    identity,
    machineName: `test-machine-${machineSuffix}`,
    ownerId: "usr_test",
    ownerName: "test",
    dataDir: dir,
    leaseSeconds: LEASE_SECONDS,
    harness: fakeHarness,
    agents: agentDefs.map((a) => ({
      id: a.id,
      name: a.name,
      role: "developer",
      capabilities: ["fake_work"],
      projects: ["prj_test"],
    })),
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

async function offerTask(agentId: string, durationSeconds: number) {
  const res = await fetch(`${baseUrl}/debug/offer-task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId,
      title: "fake work",
      spec: JSON.stringify({ durationSeconds }),
      budgetSeconds: 30,
    }),
  });
  const body = (await res.json()) as { taskId: string };
  return body.taskId;
}

function taskRow(taskId: string) {
  return server.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
}

function zoneOf(agentId: string): string | undefined {
  const view = buildView(server.db, new Positions(), "usr_test");
  const room = view.rooms.find((r) => r.id === "prj_test");
  return room?.agents.find((a) => a.id === agentId)?.zone;
}

describe("office zones track a real task lifecycle", () => {
  test(
    "an agent moves working -> idle as its task runs and completes, without disturbing an unrelated idle agent",
    async () => {
      const conn = makeRunner("z", [
        { id: "agt_walker", name: "dev-walker" },
        { id: "agt_bystander", name: "dev-bystander" },
      ]);
      conn.connect();

      await waitFor(
        () => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get("agt_walker") &&
              !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get("agt_bystander"),
        5000,
        "both agents registered"
      );

      // Before any task: both start in the idle zone (the table tennis room).
      expect(zoneOf("agt_walker")).toBe("idle");
      expect(zoneOf("agt_bystander")).toBe("idle");

      const taskId = await offerTask("agt_walker", 2);

      // "walks into the open office": zone flips to working as soon as the
      // runner accepts and the task starts, well before it finishes.
      await waitFor(() => taskRow(taskId)?.state === "working", 3000, "task accepted and started");
      expect(zoneOf("agt_walker")).toBe("working");
      // "Nothing else in the room moves."
      expect(zoneOf("agt_bystander")).toBe("idle");

      // "finishes -> moves to the table tennis room": zone returns to idle
      // once the result lands — the same zone value as before, so this is
      // the one assertion that actually needs the full round trip: getting
      // it right by accident (e.g. a stub that never changes state) would
      // pass the "no other agent moved" check too.
      await waitFor(() => taskRow(taskId)?.state === "completed", 5000, "task completed");
      await waitFor(() => zoneOf("agt_walker") === "idle", 3000, "agent zone returns to idle after completion");
      expect(zoneOf("agt_bystander")).toBe("idle");

      conn.stop();
    },
    15_000
  );
});
