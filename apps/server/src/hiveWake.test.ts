// The wake path — the fix for dispatch delivering into a void.
//
// These tests carry unusual weight: the bug being fixed is one where every
// existing test passed while the system did nothing at all. Unit tests cannot
// prove an agent really starts working (see HANDOFF-PHASE0-WAKE.md §4 for the
// end-to-end check against the samsung hive), but they can prove the decision
// tree, which is where the subtle failures live.
import { beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { wakeRecipient, resetWakeMemory, roomLineFor, injectionNoticeFor } from "./hiveWake.js";
import type { HiveMessage } from "./hive.js";

let db: Db;
let injected: string[];
let spawned: string[];
let logs: string[];

beforeEach(() => {
  resetWakeMemory();
  injected = []; spawned = []; logs = [];
  db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id,gh_repo,name,layout) VALUES ('p','a/a','a/a','office')").run();
  db.prepare("INSERT INTO users (id,name,avatar) VALUES ('u','U',0)").run();
});

function machine(id: string, online: boolean) {
  db.prepare(
    "INSERT INTO machines (id,owner_id,name,online,last_seen) VALUES (?,?,?,?,?)"
  ).run(id, "u", id, online ? 1 : 0, new Date().toISOString());
}

function agent(id: string, name: string, machineId: string | null) {
  db.prepare(
    `INSERT INTO agents (id,machine_id,owner_id,project_id,name,role,capabilities,concurrency,status)
     VALUES (?,?,?,?,?,?,?,1,'idle')`
  ).run(id, machineId, "u", "p", name, "developer", "[]");
}

const deps = (opts: { canInject?: boolean; canSpawn?: boolean } = {}) => ({
  db,
  inject: (id: string, text: string) => {
    if (opts.canInject === false) return false;
    injected.push(`${id}:${text}`); return true;
  },
  spawn: (id: string, prompt: string) => {
    if (opts.canSpawn === false) return false;
    spawned.push(`${id}:${prompt}`); return true;
  },
  log: (m: string) => logs.push(m),
});

const msg = (over: Partial<HiveMessage> = {}): HiveMessage => ({
  id: "m1", from: "sam", to: "ram", act: "request",
  subject: "Review the card layout", body: "check contrast on .product-card",
  ...over,
} as HiveMessage);

describe("choosing a verb", () => {
  test("injects when a session is live — keeping the agent's context is worth more than a fresh start", () => {
    machine("mach", true); agent("ram", "ram", "mach");
    const r = wakeRecipient(msg(), "ram", deps());
    expect(r.outcome).toBe("injected");
    expect(injected).toHaveLength(1);
    expect(spawned, "must not also spawn — that would double-run the work").toHaveLength(0);
  });

  test("spawns when nothing is live, with the message as the prompt", () => {
    machine("mach", true); agent("ram", "ram", "mach");
    const r = wakeRecipient(msg(), "ram", deps({ canInject: false }));
    expect(r.outcome).toBe("spawned");
    expect(spawned[0]).toContain("Review the card layout");
    expect(spawned[0], "the body is the actual instruction").toContain("contrast");
  });
});

describe("D28 — an offline machine is unreachable", () => {
  test("records undeliverable rather than spawning into nothing", () => {
    machine("mach", false); agent("ram", "ram", "mach");
    const r = wakeRecipient(msg(), "ram", deps());
    expect(r.outcome).toBe("undeliverable");
    expect(injected).toHaveLength(0);
    expect(spawned).toHaveLength(0);
    // Silence is the failure mode we are fixing; the reason must be visible.
    expect(logs.join(" ")).toMatch(/offline/i);
  });
});

describe("idempotency — the router re-scans every 1.5 seconds", () => {
  test("one message wakes an agent exactly once, however often it is routed", () => {
    machine("mach", true); agent("ram", "ram", "mach");
    const d = deps();
    expect(wakeRecipient(msg(), "ram", d).outcome).toBe("injected");
    // Same message, three more ticks.
    for (let i = 0; i < 3; i++) {
      expect(wakeRecipient(msg(), "ram", d).outcome).toBe("duplicate");
    }
    expect(injected, "a file that stays on disk must not re-wake forever").toHaveLength(1);
  });

  test("a different message still gets through", () => {
    machine("mach", true); agent("ram", "ram", "mach");
    const d = deps();
    wakeRecipient(msg({ id: "m1" }), "ram", d);
    expect(wakeRecipient(msg({ id: "m2" }), "ram", d).outcome).toBe("injected");
    expect(injected).toHaveLength(2);
  });

  test("an undeliverable message is not retried on every tick either", () => {
    machine("mach", false); agent("ram", "ram", "mach");
    const d = deps();
    expect(wakeRecipient(msg(), "ram", d).outcome).toBe("undeliverable");
    expect(wakeRecipient(msg(), "ram", d).outcome).toBe("duplicate");
    expect(logs.filter((l) => /offline/i.test(l)), "one log line, not one per tick").toHaveLength(1);
  });
});

describe("degrading rather than throwing", () => {
  test("a message to an unknown agent is suppressed, not fatal", () => {
    const r = wakeRecipient(msg(), "nobody", deps());
    expect(r.outcome).toBe("suppressed");
    expect(r.reason).toMatch(/no such agent/);
  });

  test("a message with no id is suppressed — it could never be deduplicated", () => {
    machine("mach", true); agent("ram", "ram", "mach");
    const r = wakeRecipient(msg({ id: undefined as any }), "ram", deps());
    expect(r.outcome).toBe("suppressed");
  });

  test("no wake mechanism available is reported, not silently ignored", () => {
    machine("mach", true); agent("ram", "ram", "mach");
    const r = wakeRecipient(msg(), "ram", { db });
    expect(r.outcome).toBe("suppressed");
    expect(r.reason).toMatch(/no wake mechanism/);
  });
});

describe("what the room shows", () => {
  test("the agent's own words are used when it wrote them", () => {
    const line = roomLineFor(
      msg({ say: "hey, finished the card layout — can you check the contrast ratios?" } as any),
      "sam", "ram"
    );
    expect(line).toBe("hey, finished the card layout — can you check the contrast ratios?");
  });

  test("a missing `say` still produces a line — a silent office is the bug", () => {
    const line = roomLineFor(msg(), "sam", "ram");
    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain("Review the card layout");
  });

  test("with neither, it still says something rather than nothing", () => {
    const line = roomLineFor(msg({ subject: undefined, say: undefined } as any), "sam", "ram");
    expect(line).toBe("sam sent ram a request");
  });

  test("a long `say` is truncated so one agent cannot flood the room", () => {
    const line = roomLineFor(msg({ say: "x".repeat(500) } as any), "sam", "ram");
    expect(line.length).toBeLessThanOrEqual(280);
    expect(line.endsWith("…")).toBe(true);
  });

  test("the injected notice tells the agent to look, and who from", () => {
    const notice = injectionNoticeFor(msg(), "sam");
    expect(notice).toContain("sam");
    expect(notice).toContain("Review the card layout");
    expect(notice.toLowerCase()).toContain("inbox");
  });
});
