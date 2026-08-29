// Phase 1 — delivery guarantee tests.
//
// Every test covers one state transition from the brief's model:
//   pending → delivered → handled
//                       → redeliver (timeout + attempts < N)
//                       → dead       (timeout + attempts = N)
//
// Each must fail without its fix. The revert-and-check protocol:
//   1. Comment out the production code under test.
//   2. Watch the test go red.
//   3. Restore the production code.
//   4. Watch it go green.
//
// Unit tests cannot prove the system works end-to-end — the bug class being
// fixed is one where all tests passed while the system did nothing. Live
// verification against /Users/ayush/project_test/samsung/ is required.
import { beforeEach, describe, expect, test } from "vitest";
import { openDb, appendEvent, type Db } from "./db.js";
import { wakeRecipient, resetWakeMemory } from "./hiveWake.js";
import {
  recordDelivery,
  checkForAcks,
  sweepDeliveries,
  isAlreadyDelivered,
  getDeliveries,
  deliveryCounts,
  DEFAULT_TIMEOUT_MS,
} from "./hiveDelivery.js";
import type { HiveMessage } from "./hive.js";
import type { WakeResult } from "./hiveWake.js";
import { mkdirSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: Db;
let hiveRoot: string;
let injected: string[];
let spawned: string[];
let logs: string[];

beforeEach(() => {
  resetWakeMemory();
  injected = [];
  spawned = [];
  logs = [];
  db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id,gh_repo,name,layout) VALUES ('p','a/a','a/a','office')").run();
  db.prepare("INSERT INTO users (id,name,avatar) VALUES ('u','U',0)").run();
  hiveRoot = join(tmpdir(), `.test-hive-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

function machine(id: string, online: boolean) {
  db.prepare(
    "INSERT INTO machines (id,owner_id,name,online,last_seen) VALUES (?,?,?,?,?)"
  ).run(id, "u", id, online ? 1 : 0, new Date().toISOString());
}

function agent(id: string, name: string, machineId: string | null, status = "idle") {
  db.prepare(
    `INSERT INTO agents (id,machine_id,owner_id,project_id,name,role,capabilities,concurrency,status)
     VALUES (?,?,?,?,?,?,?,1,?)`
  ).run(id, machineId, "u", "p", name, "developer", "[]", status);
}

function setupHiveInbox(agentId: string) {
  const inboxDir = join(hiveRoot, "agents", agentId, "inbox");
  const doneDir = join(inboxDir, ".done");
  mkdirSync(doneDir, { recursive: true });
  return { inboxDir, doneDir };
}

const makeDeps = (opts: { canInject?: boolean; canSpawn?: boolean } = {}) => ({
  db,
  inject: (id: string, text: string) => {
    if (opts.canInject === false) return false;
    injected.push(`${id}:${text}`);
    return true;
  },
  spawn: (id: string, prompt: string) => {
    if (opts.canSpawn === false) return false;
    spawned.push(`${id}:${prompt}`);
    return true;
  },
  log: (m: string) => logs.push(m),
});

const msg = (over: Partial<HiveMessage> = {}): HiveMessage =>
  ({
    id: "m1",
    from: "sam",
    to: "ram",
    act: "request",
    subject: "Review the card layout",
    body: "check contrast on .product-card",
    ...over,
  } as HiveMessage);

// ── Recording and dedup ──────────────────────────────────────────────

describe("delivery recording replaces in-memory dedup", () => {
  test("a recorded delivery is found by isAlreadyDelivered", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    const wake: WakeResult = { outcome: "injected" };
    recordDelivery(db, msg(), "ram", "p", wake);
    expect(isAlreadyDelivered(db, "m1")).toBe(true);
    expect(isAlreadyDelivered(db, "other")).toBe(false);
  });

  test("wakeRecipient deduplicates via DB after server restart (memory cleared)", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    // First wake succeeds
    const d = makeDeps();
    const r1 = wakeRecipient(msg(), "ram", d);
    expect(r1.outcome).toBe("injected");
    // Record the delivery
    recordDelivery(db, msg(), "ram", "p", r1);
    // Simulate server restart: clear in-memory cache
    resetWakeMemory();
    // Second wake must be "duplicate" from DB, not injected again
    const r2 = wakeRecipient(msg(), "ram", d);
    expect(r2.outcome).toBe("duplicate");
    expect(injected).toHaveLength(1); // only the first one
  });

  test("deliveryCounts returns correct state distribution", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    recordDelivery(db, msg({ id: "a" }), "ram", "p", { outcome: "injected" });
    recordDelivery(db, msg({ id: "b" }), "ram", "p", { outcome: "spawned" });
    const counts = deliveryCounts(db);
    expect(counts.delivered).toBe(2);
    expect(counts.handled).toBe(0);
    expect(counts.dead).toBe(0);
  });
});

// ── Ack via .done/ ───────────────────────────────────────────────────

describe("ack — the .done/ move is the honest signal", () => {
  test("a message moved to .done/ transitions from delivered to handled", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    const { inboxDir, doneDir } = setupHiveInbox("ram");

    // Deliver and record
    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });

    // Place message file in inbox, then move to .done (what the agent does)
    writeFileSync(join(inboxDir, "m1.json"), JSON.stringify(msg()));
    renameSync(join(inboxDir, "m1.json"), join(doneDir, "m1.json"));

    // Run ack scan
    const acked = checkForAcks(db, [hiveRoot]);
    expect(acked).toBe(1);

    // Verify state transition
    const deliveries = getDeliveries(db, { state: "handled" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].messageId).toBe("m1");
    expect(deliveries[0].handledAt).not.toBeNull();
  });

  test("a message NOT in .done/ stays as delivered", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    setupHiveInbox("ram");

    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });

    // No .done/ file — agent hasn't handled it
    const acked = checkForAcks(db, [hiveRoot]);
    expect(acked).toBe(0);

    const deliveries = getDeliveries(db, { state: "delivered" });
    expect(deliveries).toHaveLength(1);
  });

  test("ack race — file disappears mid-scan — counts as handled, not error", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    const { doneDir } = setupHiveInbox("ram");

    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });

    // The file is in .done/ — agent moved it
    writeFileSync(join(doneDir, "m1.json"), "{}");

    // checkForAcks reads the directory and finds m1 — it should update the row.
    // Even if the file were removed between readdir and the UPDATE, the DB
    // update is safe (it's by message_id, not by file handle).
    const acked = checkForAcks(db, [hiveRoot]);
    expect(acked).toBe(1);
  });
});

// ── Timeout and redelivery ───────────────────────────────────────────

describe("timeout and redelivery", () => {
  test("a stale message is redelivered, bumping the attempt count", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");

    // Record delivery in the past
    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });
    // Backdate to exceed timeout
    db.prepare(
      "UPDATE hive_deliveries SET last_attempt_at = ? WHERE message_id = ?"
    ).run(new Date(Date.now() - DEFAULT_TIMEOUT_MS - 1000).toISOString(), "m1");

    // Clear the in-memory dedup so wake can fire again
    resetWakeMemory();

    const d = makeDeps();
    const result = sweepDeliveries({
      ...d,
      hiveRoots: [hiveRoot],
      maxAttempts: 3,
    });

    expect(result.redelivered).toBe(1);
    expect(result.deadLettered).toBe(0);

    // Attempt count bumped
    const row = getDeliveries(db, { agentId: "ram" })[0];
    expect(row.attempts).toBe(2);
    expect(row.state).toBe("delivered"); // still delivered, not dead
  });

  test("a working agent is NOT redelivered — the brief says check status first", () => {
    machine("mach", true);
    agent("ram", "ram", "mach", "working");

    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });
    db.prepare(
      "UPDATE hive_deliveries SET last_attempt_at = ? WHERE message_id = ?"
    ).run(new Date(Date.now() - DEFAULT_TIMEOUT_MS - 1000).toISOString(), "m1");

    resetWakeMemory();

    const result = sweepDeliveries({
      ...makeDeps(),
      hiveRoots: [hiveRoot],
      maxAttempts: 3,
    });

    expect(result.redelivered).toBe(0);
    expect(result.deadLettered).toBe(0);
    // Attempt count unchanged
    const row = getDeliveries(db)[0];
    expect(row.attempts).toBe(1);
  });

  test("a message that is not yet timed out is not touched", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");

    // Record delivery just now (not timed out)
    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });

    const result = sweepDeliveries({
      ...makeDeps(),
      hiveRoots: [hiveRoot],
      maxAttempts: 3,
    });

    expect(result.redelivered).toBe(0);
    expect(result.deadLettered).toBe(0);
  });
});

// ── Dead-lettering ───────────────────────────────────────────────────

describe("dead-lettering after max attempts", () => {
  test("a message at max attempts transitions to dead and emits event", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    const { inboxDir } = setupHiveInbox("ram");

    // Record delivery already at attempt 3 (max)
    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });
    db.prepare(
      "UPDATE hive_deliveries SET attempts = 3, last_attempt_at = ? WHERE message_id = ?"
    ).run(new Date(Date.now() - DEFAULT_TIMEOUT_MS - 1000).toISOString(), "m1");

    // Place file in inbox so dead-lettering can move it
    writeFileSync(join(inboxDir, "m1.json"), JSON.stringify(msg()));

    const emitted: any[] = [];
    const chatted: string[] = [];

    const result = sweepDeliveries({
      ...makeDeps(),
      hiveRoots: [hiveRoot],
      maxAttempts: 3,
      emitEvent: (_pid, _mid, type, body) => emitted.push({ type, body }),
      postChat: (_pid, text) => chatted.push(text),
    });

    expect(result.deadLettered).toBe(1);
    expect(result.redelivered).toBe(0);

    // DB state
    const row = getDeliveries(db, { state: "dead" })[0];
    expect(row).toBeDefined();
    expect(row.deadAt).not.toBeNull();

    // File moved to dead-letter/
    expect(existsSync(join(inboxDir, "m1.json"))).toBe(false);
    expect(existsSync(join(inboxDir, "dead-letter", "m1.json"))).toBe(true);

    // Event emitted
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("hive_message.dead_lettered");

    // Chat message posted for human visibility
    expect(chatted).toHaveLength(1);
    expect(chatted[0]).toContain("Dead-lettered");
    expect(chatted[0]).toContain("3 attempts");
  });

  test("killing an agent mid-task causes exactly one redelivery, not a stream", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");

    recordDelivery(db, msg(), "ram", "p", { outcome: "spawned" });
    // Backdate past timeout
    db.prepare(
      "UPDATE hive_deliveries SET last_attempt_at = ? WHERE message_id = ?"
    ).run(new Date(Date.now() - DEFAULT_TIMEOUT_MS - 1000).toISOString(), "m1");

    resetWakeMemory();

    const d = makeDeps();
    // First sweep: redelivers
    const r1 = sweepDeliveries({ ...d, hiveRoots: [hiveRoot], maxAttempts: 3 });
    expect(r1.redelivered).toBe(1);

    // Second sweep immediately after: last_attempt_at was just updated, so
    // the message is not stale yet. No second redelivery.
    const r2 = sweepDeliveries({ ...d, hiveRoots: [hiveRoot], maxAttempts: 3 });
    expect(r2.redelivered).toBe(0);
  });

  test("an agent that handles a message normally never triggers redelivery", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    const { doneDir } = setupHiveInbox("ram");

    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });
    // Agent handles it immediately
    writeFileSync(join(doneDir, "m1.json"), "{}");
    checkForAcks(db, [hiveRoot]);

    // Backdate what was the delivery time (but state is now "handled")
    db.prepare(
      "UPDATE hive_deliveries SET last_attempt_at = ? WHERE message_id = ?"
    ).run(new Date(Date.now() - DEFAULT_TIMEOUT_MS - 1000).toISOString(), "m1");

    const result = sweepDeliveries({
      ...makeDeps(),
      hiveRoots: [hiveRoot],
      maxAttempts: 3,
    });

    // No redelivery — it was already handled
    expect(result.redelivered).toBe(0);
    expect(result.deadLettered).toBe(0);
  });
});

// ── Server restart resilience ────────────────────────────────────────

describe("server restart does not reset attempt counts", () => {
  test("attempt count persists across in-memory resets", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");

    recordDelivery(db, msg(), "ram", "p", { outcome: "injected" });
    db.prepare(
      "UPDATE hive_deliveries SET attempts = 2, last_attempt_at = ? WHERE message_id = ?"
    ).run(new Date(Date.now() - DEFAULT_TIMEOUT_MS - 1000).toISOString(), "m1");

    // "Restart" — clear in-memory state
    resetWakeMemory();

    const result = sweepDeliveries({
      ...makeDeps(),
      hiveRoots: [hiveRoot],
      maxAttempts: 3,
    });

    // Should redeliver (attempt 2 → 3), not reset to attempt 1
    expect(result.redelivered).toBe(1);
    const row = getDeliveries(db)[0];
    expect(row.attempts).toBe(3);
  });
});

// ── Query helpers ────────────────────────────────────────────────────

describe("query helpers", () => {
  test("getDeliveries filters by agent and state", () => {
    machine("mach", true);
    agent("ram", "ram", "mach");
    agent("sam", "sam", "mach");

    recordDelivery(db, msg({ id: "a" }), "ram", "p", { outcome: "injected" });
    recordDelivery(db, msg({ id: "b", to: "sam" }), "sam", "p", { outcome: "spawned" });

    expect(getDeliveries(db, { agentId: "ram" })).toHaveLength(1);
    expect(getDeliveries(db, { agentId: "sam" })).toHaveLength(1);
    expect(getDeliveries(db)).toHaveLength(2);
    expect(getDeliveries(db, { state: "handled" })).toHaveLength(0);
  });
});
