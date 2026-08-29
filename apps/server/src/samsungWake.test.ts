// Verification of Phase 0 §4 against the live samsung hive fixture at /Users/ayush/project_test/samsung/
import { describe, expect, test } from "vitest";
import { HiveManager } from "./hive.js";
import { openDb } from "./db.js";
import { wakeRecipient, roomLineFor, resetWakeMemory } from "./hiveWake.js";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

describe("Phase 0 §4: Live samsung hive verification", () => {
  test("god dispatches to sam (agt_7f6a3c1d) -> routes -> wakes sam with plain English line", () => {
    resetWakeMemory();
    const samsungHiveRoot = "/Users/ayush/project_test/samsung/hive";
    if (!existsSync(samsungHiveRoot)) {
      console.warn("Samsung fixture directory not found at " + samsungHiveRoot);
      return;
    }

    const db = openDb(":memory:");
    db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES ('m_samsung', 'u', 'samsung-node', 1)").run();
    db.prepare("INSERT INTO agents (id, name, machine_id, provider) VALUES ('agt_7f6a3c1d', 'sam', 'm_samsung', 'opencode')").run();

    let wokenType: string | null = null;
    let wokenPrompt: string | null = null;
    let deliveredMsg: any = null;
    let roomChatLine: string | null = null;

    const hive = new HiveManager(samsungHiveRoot, () => {}, (msg, from, to) => {
      deliveredMsg = msg;
      const wake = wakeRecipient(msg, to, {
        db,
        inject: (id, text) => {
          wokenType = "inject";
          wokenPrompt = text;
          return false; // simulate no live terminal session -> triggers spawn
        },
        spawn: (id, prompt) => {
          wokenType = "spawn";
          wokenPrompt = prompt;
          return true;
        },
        log: () => {},
      });
      expect(wake.outcome).toBe("spawned");
      roomChatLine = roomLineFor(msg, from, to);
    });

    const testId = `verify_wake_${Date.now()}`;
    const testMsg = {
      id: testId,
      from: "god",
      to: "agt_7f6a3c1d",
      act: "request",
      subject: "Audit mobile viewport layout",
      body: "Check horizontal scroll behavior on 375px width screens.",
      say: "sam, check the 375px viewport layout",
      created_at: new Date().toISOString(),
    };

    const godOutbox = join(samsungHiveRoot, "agents", "god", "outbox");
    const outboxPath = join(godOutbox, `${testId}.json`);
    writeFileSync(outboxPath, JSON.stringify(testMsg, null, 2), "utf8");

    const routedCount = hive.routeOnce();
    expect(routedCount).toBeGreaterThanOrEqual(1);

    // Verify wake was triggered
    expect(wokenType).toBe("spawn");
    expect(wokenPrompt).toContain("Audit mobile viewport layout");
    expect(wokenPrompt).toContain("375px");

    // Verify room line
    expect(roomChatLine).toBe("sam, check the 375px viewport layout");

    // Clean up from sam's inbox
    const samInboxPath = join(samsungHiveRoot, "agents", "agt_7f6a3c1d", "inbox", `${testId}.json`);
    if (existsSync(samInboxPath)) {
      unlinkSync(samInboxPath);
    }
  });

  test("negative case: recipient's machine offline -> records undeliverable, nothing spawned", () => {
    resetWakeMemory();
    const db = openDb(":memory:");
    db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES ('m_offline', 'u', 'offline-node', 0)").run();
    db.prepare("INSERT INTO agents (id, name, machine_id, provider) VALUES ('agt_7f6a3c1d', 'sam', 'm_offline', 'opencode')").run();

    let spawned = false;
    const wake = wakeRecipient({
      id: "offline_test_" + Date.now(),
      from: "god",
      to: "agt_7f6a3c1d",
      act: "request",
      subject: "Test offline",
      body: "Will not spawn",
      conversation: "",
      in_reply_to: null,
      hops: 0,
      requires_reply: false,
      needs_human: false,
      created_at: new Date().toISOString(),
    }, "agt_7f6a3c1d", {
      db,
      spawn: () => { spawned = true; return true; }
    });

    expect(wake.outcome).toBe("undeliverable");
    expect(spawned).toBe(false);
  });
});
