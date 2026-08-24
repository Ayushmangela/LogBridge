// Review + context sharing between agents (HANDOFF.md prompt 6), end to end.
//
// D15: a review returns a JUDGEMENT, not work — different shape, separate
// flow. Findings and shared context are CONTENT: sealed exactly like
// delegated payloads, and the receiving side stores context LOCALLY rather
// than into server-readable team memory. The grep at the end pins that.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import type { AgentEvent, AgentHarness } from "./harness/types.js";

const SECRET_CONTEXT = "STAGING-DB-URL=postgres://internal-only/staging";

let server: BuiltServer;
let wsUrl: string;
let dataDir: string;

beforeEach(async () => {
  server = await buildServer({ dbPath: ":memory:", leaseSeconds: 30, sweepIntervalMs: 1000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${addr.port}/node-ws`;
  dataDir = mkdtempSync(join(tmpdir(), "logbridge-review-"));
  server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_test", "t/t", "t/t", "office"
  );
});

afterEach(async () => {
  await server.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

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
  return { conn, agentId, dir };
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Echoes the prompt — the review prompt must contain what was asked. */
function echoHarness(): AgentHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    name: "echo",
    spawn(opts) {
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      q.push({ kind: "output", text: "reviewed: looks fine overall" });
      q.push({ kind: "done", ok: true });
      q.close();
      return { events: q, interrupt: () => {}, kill: () => q.close(), answer: () => {} };
    },
  };
}

describe("reviews and shared context", () => {
  test("a review round trip: criteria travel sealed, judgement returns sealed", async () => {
    const harnessB = echoHarness();
    const a = makeRunner("ra", echoHarness());
    const b = makeRunner("rb", harnessB, true);
    a.conn.connect();
    b.conn.connect();
    await waitFor(() => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey), 6000, "peers");

    // Standing grant for review requests from A's owner (consent itself has
    // its own suite; here we test the review mechanics).
    const { setGrant } = await import("../../server/src/db.js");
    setGrant(server.db, "usr_rb", "usr_ra", "prj_test", "request_review", "always");

    const CRITERIA = "no replay window on token refresh";
    const judgement = await a.conn.requestReview({
      targetAgentId: b.agentId,
      subject: { kind: "pr" as const, ref: "acme/api#212" },
      criteria: [CRITERIA],
      depth: "thorough",
    });

    // B's harness actually received the subject and the criteria…
    expect(harnessB.prompts[0]).toContain("acme/api#212");
    expect(harnessB.prompts[0]).toContain(CRITERIA);

    // …and A got a real verdict back through the sealed channel.
    expect(judgement.verdict).toBe("approved");
    expect(judgement.summary).toContain("looks fine");

    // The server stored THAT a review happened — never its content.
    const stored = JSON.stringify(
      server.db.prepare("SELECT type FROM events").all()
    ) + JSON.stringify(server.db.prepare("SELECT body FROM events WHERE type LIKE 'review%'").all());
    expect(stored).not.toContain(CRITERIA);
    expect(stored).not.toContain("looks fine");

    a.conn.stop();
    b.conn.stop();
  }, 25_000);

  test("shared context arrives sealed, is stored locally, and is recallable — never server-side", async () => {
    const a = makeRunner("ca", echoHarness());
    const b = makeRunner("cb", echoHarness(), true);
    a.conn.connect();
    b.conn.connect();
    await waitFor(() => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey), 6000, "peers");

    const { setGrant } = await import("../../server/src/db.js");
    setGrant(server.db, "usr_cb", "usr_ca", "prj_test", "share_context", "always");

    await a.conn.shareContext({
      targetAgentId: b.agentId,
      kind: "constraint",
      title: "staging constraint",
      body: SECRET_CONTEXT,
      summary: "how to reach staging",
    });

    // B acknowledged, and the content landed in B's LOCAL store only.
    const file = join(dataDir, "cb", "shared-context.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(SECRET_CONTEXT);

    const recalled = b.conn.recallSharedContext("staging");
    expect(recalled[0]?.text).toBe(SECRET_CONTEXT);
    expect(b.conn.recallSharedContext("unrelated-query-xyz")).toHaveLength(0); // keyword match, BM25-honest

    // The server never saw it — the whole point of sealing this flow.
    const tables = server.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
    const everything = tables.map((t) => JSON.stringify(server.db.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
    expect(everything).not.toContain(SECRET_CONTEXT);

    a.conn.stop();
    b.conn.stop();
  }, 25_000);

  test("review requests are refused by machines that take no outside work", async () => {
    const a = makeRunner("xa", echoHarness());
    const b = makeRunner("xb", echoHarness(), false); // opted OUT
    a.conn.connect();
    b.conn.connect();
    await waitFor(() => a.conn.peerList().some((p) => p.agentId === b.agentId && !!p.sealingPubkey), 6000, "peers");

    const result = await Promise.race([
      a.conn.requestReview({
        targetAgentId: b.agentId,
        subject: { kind: "diff" as const, ref: "HEAD~1..HEAD" },
        criteria: ["correctness"],
      }),
      new Promise<any>((r) => setTimeout(() => r({ verdict: "no-answer" }), 8000)),
    ]);
    // The SERVER refused before asking anyone — B's machine never saw it.
    expect(result.verdict ?? result.summary).toBeDefined();
    expect(result.summary).toContain("does not accept outside requests");

    a.conn.stop();
    b.conn.stop();
  }, 20_000);
});
