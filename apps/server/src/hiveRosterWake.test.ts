import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveManager } from "./hive.js";

/**
 * Regression: the commander started before its subordinates existed.
 *
 * Observed live: a project is created, the commander's terminal starts at
 * once and reads a registry containing only itself. It reports "no
 * subordinate agents are registered, so delegation isn't possible" and
 * starts building alone. The user adds sam/ram/dam moments later, but the
 * commander already decided and never revisits the roster — so no agent ever
 * messages another and the chat room stays empty.
 */
describe("roster changes wake the commander", () => {
  let tmpRoot: string;
  let hive: HiveManager;
  let seen: Array<{ to: string; body: string; subject: string }>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "logbridge-roster-wake-"));
    seen = [];
    hive = new HiveManager(tmpRoot, undefined, (msg: any, _from: string, to: string) => {
      seen.push({ to, body: msg.body, subject: msg.subject });
    });
  });

  afterEach(() => {
    hive.stopRouter();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  function seedCommander() {
    hive.registerAgent({ id: "cmd", name: "commander", role: "planner", isGod: true } as any);
  }

  test("registering a subordinate delivers a roster notice to the commander", () => {
    seedCommander();
    seen.length = 0;

    hive.registerAgent({ id: "sam", name: "sam", role: "developer" } as any);

    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe("cmd");
    expect(seen[0].subject).toContain("sam");
    // It must say the earlier roster is stale, or the commander has no reason
    // to revisit a conclusion it already committed to.
    expect(seen[0].body).toMatch(/stale/i);
    expect(seen[0].body).toContain("sam (developer)");
  });

  test("the notice lists every subordinate, not just the new one", () => {
    seedCommander();
    hive.registerAgent({ id: "sam", name: "sam", role: "developer" } as any);
    seen.length = 0;

    hive.registerAgent({ id: "ram", name: "ram", role: "designer" } as any);

    expect(seen).toHaveLength(1);
    expect(seen[0].body).toContain("sam (developer)");
    expect(seen[0].body).toContain("ram (designer)");
  });

  test("re-registering a known agent wakes nobody (server restart resyncs all agents)", () => {
    seedCommander();
    hive.registerAgent({ id: "sam", name: "sam", role: "developer" } as any);
    seen.length = 0;

    // What index.ts does on every boot: re-register every agent it knows.
    hive.registerAgent({ id: "cmd", name: "commander", role: "planner", isGod: true } as any);
    hive.registerAgent({ id: "sam", name: "sam", role: "developer" } as any);

    expect(seen).toHaveLength(0);
  });

  test("registering the commander itself wakes nobody", () => {
    seedCommander();
    expect(seen).toHaveLength(0);
  });

  test("a roster notice does not strand the commander in a meeting with 'operator'", () => {
    seedCommander();
    hive.registerAgent({ id: "sam", name: "sam", role: "developer" } as any);

    // "operator" has no sprite on the floor; a meeting with it would park the
    // commander at a table facing nobody until the timer expired.
    expect(hive.isAgentCollaborating("cmd")).toBe(false);
  });

  test("meetings between two real agents still work", () => {
    seedCommander();
    hive.registerAgent({ id: "sam", name: "sam", role: "developer" } as any);

    hive.setMeeting("cmd", "sam", 30000, "Design review");

    expect(hive.isAgentCollaborating("cmd")).toBe(true);
    expect(hive.isAgentCollaborating("sam")).toBe(true);
  });
});
