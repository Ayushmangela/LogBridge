// Cross-machine delegation with end-to-end sealed payloads (SEALED.md).
//
// The claim: machine A can hand work to machine B through the server, and
// the server — which routes it, logs it and draws the office from it —
// cannot read what was sent. The load-bearing test here is the one that
// greps the server's entire database for the plaintext and finds nothing.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import type { AgentEvent, AgentHarness } from "./harness/types.js";

const SECRET = "PROPRIETARY-BRANCH-NAME-feat/acquisition-q4";

let server: BuiltServer;
let wsUrl: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: 30, sweepIntervalMs: 1000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${addr.port}/node-ws`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-sealed-test-"));
  server.db
    .prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)")
    .run("prj_test", "t/t", "t/t", "office");
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Echoes the prompt it was given, so the delegated result is checkable. */
function echoHarness(): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    name: "echo",
    spawn(opts) {
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      q.push({ kind: "output", text: `ran: ${opts.prompt}` });
      q.push({ kind: "done", ok: true });
      q.close();
      return { events: q, interrupt: () => {}, kill: () => {} };
    },
  };
}

function makeRunner(suffix: string, harness: AgentHarness, acceptDelegations = false) {
  const dir = join(dataDir, suffix);
  const agentId = `agt_${suffix}`;
  const conn = new RunnerConnection({
    serverUrl: wsUrl,
    identity: loadOrCreateIdentity(dir, `node_${suffix}`),
    machineName: `machine-${suffix}`,
    ownerId: `usr_${suffix}`,
    ownerName: suffix,
    dataDir: dir,
    leaseSeconds: 30,
    harness,
    acceptDelegations,
    agents: [{
      id: agentId, name: `dev-${suffix}`, role: "developer",
      capabilities: ["run_integration_tests"], projects: ["prj_test"],
    }],
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

const registered = (id: string) => !!server.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id);
const agentRow = (id: string) => server.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;

/** Every byte the server persisted, as one string. */
function everythingTheServerStored(): string {
  const tables = server.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")
    .all() as any[];
  return tables
    .map((t) => JSON.stringify(server.db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join("\n");
}

describe("sealed cross-machine delegation", () => {
  test(
    "A delegates to B through the server, and the server never sees the payload",
    async () => {
      const harnessA = echoHarness();
      const harnessB = echoHarness();
      const a = makeRunner("a", harnessA);
      const b = makeRunner("b", harnessB, true); // B's owner opted in to running others' work

      a.conn.connect();
      b.conn.connect();
      await waitFor(() => registered(a.agentId) && registered(b.agentId), 6000, "both agents registered");
      // Both must have learned about each other before either can seal.
      await waitFor(
        () => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey),
        6000,
        "A learned B's sealing key"
      );

      // Per-request consent would hold this delegation for B's owner to
      // approve. This test is about the ENCRYPTION, so B grants 'always'
      // up front — the consent flow itself has its own tests.
      const { setGrant } = await import("../../server/src/db.js");
      setGrant(server.db, "usr_b", "usr_a", "prj_test", "run_integration_tests", "always");

      const result = await a.conn.delegate({
        capability: "run_integration_tests",
        targetAgentId: b.agentId,
        inputs: { prompt: SECRET },
      });

      // B really executed it, and really received the plaintext.
      expect(harnessB.prompts).toContain(SECRET);
      expect(result.state).toBe("completed");
      expect(result.findings).toContain(SECRET); // sealed back to A, opened by A

      // --- the actual security claim ---
      const stored = everythingTheServerStored();
      expect(stored).not.toContain(SECRET);
      expect(stored).not.toContain("acquisition");
      // ...while the server *did* still record that a delegation happened,
      // which is what lets it route and draw the office.
      expect(stored).toContain("delegate.request");
      expect(stored).toContain("run_integration_tests");

      a.conn.stop();
      b.conn.stop();
    },
    30_000
  );

  test("a machine that has not opted in refuses delegated work", async () => {
    const harnessB = echoHarness();
    const a = makeRunner("a2", echoHarness());
    const b = makeRunner("b2", harnessB, false); // default: does NOT accept

    a.conn.connect();
    b.conn.connect();
    await waitFor(() => registered(a.agentId) && registered(b.agentId), 6000, "registered");
    await waitFor(() => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey), 6000, "keys exchanged");

    const result = await a.conn.delegate({
      capability: "run_integration_tests",
      targetAgentId: b.agentId,
      inputs: { prompt: "please run this" },
    });

    expect(result.state).toBe("failed");
    // The refusal is the point: nothing was executed on B.
    expect(harnessB.prompts).toHaveLength(0);

    a.conn.stop();
    b.conn.stop();
  }, 30_000);

  test("delegating puts the requester in the meeting room, then releases it", async () => {
    // A harness held open on purpose: with an instant one the blocked window
    // closes in microseconds and the assertion races. The property under
    // test is that the requester STAYS in the meeting room for as long as
    // the remote work is actually running, so the work has to actually run.
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    const heldHarness: AgentHarness = {
      name: "held",
      spawn() {
        const q = new AsyncEventQueue<AgentEvent>();
        void gate.then(() => { q.push({ kind: "done", ok: true }); q.close(); });
        return { events: q, interrupt: () => {}, kill: () => { q.close(); } };
      },
    };

    const a = makeRunner("a3", echoHarness());
    const b = makeRunner("b3", heldHarness, true);
    a.conn.connect();
    b.conn.connect();
    await waitFor(() => registered(a.agentId) && registered(b.agentId), 6000, "registered");
    await waitFor(() => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey), 6000, "keys exchanged");

    // This test is about the MEETING-ROOM visual, not consent — grant always.
    const { setGrant } = await import("../../server/src/db.js");
    setGrant(server.db, "usr_b3", "usr_a3", "prj_test", "run_integration_tests", "always");

    const done = a.conn.delegate({
      capability: "run_integration_tests",
      targetAgentId: b.agentId,
      inputs: { prompt: "run them" },
    });

    // waiting_on carries an "@", which is exactly what zoneFor() turns into
    // the `collaborating` zone — the cross-machine meeting-room visual.
    await waitFor(() => agentRow(a.agentId)?.waiting_on?.includes("@"), 6000, "requester blocked on a remote agent");
    expect(agentRow(a.agentId).status).toBe("blocked");
    expect(agentRow(a.agentId).waiting_on).toContain("dev-b3");

    finish(); // let B's work complete
    await done;
    await waitFor(() => agentRow(a.agentId)?.status === "idle", 6000, "requester released after the result");
    expect(agentRow(a.agentId).waiting_on).toBeNull();

    a.conn.stop();
    b.conn.stop();
  }, 30_000);

  test("delegating to an unknown peer fails loudly instead of sending plaintext", async () => {
    const a = makeRunner("a4", echoHarness());
    a.conn.connect();
    await waitFor(() => registered(a.agentId), 6000, "registered");

    await expect(
      a.conn.delegate({ capability: "x", targetAgentId: "agt_nobody", inputs: { prompt: "secret" } })
    ).rejects.toThrow(/unknown peer/);

    a.conn.stop();
  }, 15_000);
});
