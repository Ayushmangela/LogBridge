import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveManager } from "./hive.js";

/**
 * hivePrompt.ts's own documented outbox JSON shape — the exact example
 * every commander is shown — has no "id" field:
 *   { "to": "...", "act": "request", "subject": "...", "body": "...",
 *     "requires_reply": true }
 * A commander following its own protocol therefore writes messages with no
 * id. wakeRecipient (hiveWake.ts) treats a message with no id as
 * unidentifiable and suppresses it before ever attempting to wake anyone —
 * so a real, correctly-delegated task produced zero visible effect: no PTY
 * wake, no chat room line, nothing. Reproduced live: commando dispatched a
 * real hive message to a subordinate, it landed in the subordinate's inbox
 * on disk, and the chat room stayed completely silent.
 *
 * routeOnce backfills a real id onto a message the moment it reads one off
 * disk, before anything downstream (dedup, wake) ever sees it.
 */
describe("routeOnce backfills a missing message id before delivery", () => {
  let tmpRoot: string;
  let hive: HiveManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "logbridge-id-backfill-"));
    hive = new HiveManager(tmpRoot);
  });

  afterEach(() => {
    hive.stopRouter();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  function writeRawOutboxMessage(agentId: string, body: Record<string, unknown>) {
    const outboxDir = join(tmpRoot, "agents", agentId, "outbox");
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, `${Date.now()}-dispatch.json`), JSON.stringify(body, null, 2));
  }

  test("a commander-authored message with no id is still delivered, with an id assigned", () => {
    hive.registerAgent({ id: "agt_boss", name: "commando", role: "planner", isGod: true });
    hive.registerAgent({ id: "agt_alex", name: "alex", role: "planner" });

    writeRawOutboxMessage("agt_boss", {
      to: "agt_alex",
      act: "request",
      subject: "Design system & page plan",
      body: "OBJECTIVE: ...",
      requires_reply: true,
    });

    const routed = hive.routeOnce();
    expect(routed).toBe(1);

    const inboxDir = join(tmpRoot, "agents", "agt_alex", "inbox");
    const files = readdirSync(inboxDir).filter((f: string) => f.endsWith(".json"));
    expect(files).toHaveLength(1);

    const delivered = JSON.parse(readFileSync(join(inboxDir, files[0]), "utf8"));
    expect(delivered.id).toBeTruthy();
    expect(typeof delivered.id).toBe("string");
  });

  test("the backfilled id reaches onMessage — a real dispatch is not silently suppressed", () => {
    const seen: any[] = [];
    const waked = new HiveManager(tmpRoot, undefined, (msg: any, from: string, to: string) => {
      seen.push({ msg, from, to });
    });
    waked.registerAgent({ id: "agt_boss", name: "commando", role: "planner", isGod: true });
    waked.registerAgent({ id: "agt_alex", name: "alex", role: "planner" });
    seen.length = 0; // drop the registration wake notices, only care about the dispatch below

    writeRawOutboxMessage("agt_boss", {
      to: "agt_alex",
      act: "request",
      subject: "Design system & page plan",
      body: "OBJECTIVE: ...",
      requires_reply: true,
    });

    waked.routeOnce();
    waked.stopRouter();

    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe("agt_alex");
    expect(seen[0].msg.id).toBeTruthy();
  });
});
