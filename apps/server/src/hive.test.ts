import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveManager } from "./hive.js";

describe("HiveManager", () => {
  let tmpRoot: string;
  let hive: HiveManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "logbridge-hive-test-"));
    hive = new HiveManager(tmpRoot);
  });

  afterEach(() => {
    hive.stopRouter();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  test("initializes hive structure with protocol, registry, board, and tasks", () => {
    expect(existsSync(join(tmpRoot, "PROTOCOL.md"))).toBe(true);
    expect(existsSync(join(tmpRoot, "registry.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, "board.md"))).toBe(true);
    expect(existsSync(join(tmpRoot, "tasks.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, "log.jsonl"))).toBe(true);

    const board = hive.getBoard();
    expect(board).toContain("# Project Blackboard");

    const tasks = hive.getTasks();
    expect(tasks.length).toBeGreaterThan(0);
  });

  test("registers agent and provisions identity, memory, inbox, and outbox", () => {
    hive.registerAgent({
      id: "agt_test_1",
      name: "opencode-worker",
      role: "Backend Engineer",
      provider: "opencode",
      model: "Qwen 2.5 Coder 32B",
    });

    const agentDir = hive.agentDir("agt_test_1");
    expect(existsSync(join(agentDir, "identity.md"))).toBe(true);
    expect(existsSync(join(agentDir, "memory.md"))).toBe(true);
    expect(existsSync(join(agentDir, "inbox"))).toBe(true);
    expect(existsSync(join(agentDir, "outbox"))).toBe(true);

    const identity = readFileSync(join(agentDir, "identity.md"), "utf8");
    expect(identity).toContain("opencode-worker");
    expect(identity).toContain("Backend Engineer");

    const reg = hive.getRegistry();
    expect(reg.agents["agt_test_1"]).toBeDefined();
    expect(reg.agents["agt_test_1"].name).toBe("opencode-worker");
  });

  test("manages Kanban tasks in tasks.json", () => {
    const newTask = hive.upsertTask({
      title: "Write unit tests for authentication",
      description: "Ensure JWT expiration is covered",
      status: "in_progress",
      assigned_to: "agt_test_1",
      priority: "high",
    });

    expect(newTask.id).toBeDefined();
    expect(newTask.title).toBe("Write unit tests for authentication");

    const tasks = hive.getTasks();
    const found = tasks.find((t) => t.id === newTask.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("in_progress");

    // Update status to done
    hive.upsertTask({
      id: newTask.id,
      title: newTask.title,
      status: "done",
    });

    const updatedTasks = hive.getTasks();
    const updated = updatedTasks.find((t) => t.id === newTask.id);
    expect(updated?.status).toBe("done");
  });

  test("manages shared blackboard in board.md", () => {
    hive.setBoard("# Architecture Plan\n\n- Build microservices", "usr_admin");
    expect(hive.getBoard()).toContain("Build microservices");
  });

  test("routes messages from sender outbox to recipient inbox", () => {
    // Register two agents
    hive.registerAgent({ id: "agt_a", name: "Alice", role: "Frontend" });
    hive.registerAgent({ id: "agt_b", name: "Bob", role: "Backend" });

    // Alice sends a request to Bob
    const msg = hive.postMessage(
      {
        to: "agt_b",
        act: "request",
        subject: "Need User Profile API",
        body: "Please expose GET /api/user/:id",
      },
      "agt_a"
    );

    expect(msg.id).toBeDefined();

    // Verify it landed in Alice's outbox first
    const aliceMessagesBefore = hive.getAgentMessages("agt_a");
    expect(aliceMessagesBefore.outbox.length).toBe(1);

    // Bob has nothing in inbox yet
    const bobMessagesBefore = hive.getAgentMessages("agt_b");
    expect(bobMessagesBefore.inbox.length).toBe(0);

    // Run router
    const routed = hive.routeOnce();
    expect(routed).toBe(1);

    // Alice outbox is now drained
    const aliceMessagesAfter = hive.getAgentMessages("agt_a");
    expect(aliceMessagesAfter.outbox.length).toBe(0);

    // Bob has message in inbox!
    const bobMessagesAfter = hive.getAgentMessages("agt_b");
    expect(bobMessagesAfter.inbox.length).toBe(1);
    expect(bobMessagesAfter.inbox[0].subject).toBe("Need User Profile API");
    expect(bobMessagesAfter.inbox[0].from).toBe("agt_a");
    expect(bobMessagesAfter.inbox[0].act).toBe("request");

    // Both agents are now automatically in a visual meeting room collaboration!
    expect(hive.isAgentCollaborating("agt_a")).toBe(true);
    expect(hive.isAgentCollaborating("agt_b")).toBe(true);
    expect(hive.getCollaborationPartner("agt_a")).toBe("Bob");
    expect(hive.getCollaborationPartner("agt_b")).toBe("Alice");
    expect(hive.hasAnyCollaboration()).toBe(true);
  });

  test("manages explicit visual meetings and expiration", () => {
    hive.registerAgent({ id: "agt_1", name: "Commander", role: "Leader" });
    hive.registerAgent({ id: "agt_2", name: "Designer", role: "UI" });

    expect(hive.isAgentCollaborating("agt_1")).toBe(false);
    expect(hive.hasAnyCollaboration()).toBe(false);

    // Call meeting with 100ms duration
    hive.setMeeting("agt_1", "agt_2", 100, "Design Review");
    expect(hive.isAgentCollaborating("agt_1")).toBe(true);
    expect(hive.isAgentCollaborating("agt_2")).toBe(true);
    expect(hive.hasAnyCollaboration()).toBe(true);

    const active = hive.getActiveMeetings();
    expect(active.length).toBe(1);
    expect(active[0].reason).toBe("Design Review");

    // End meeting explicitly
    hive.endMeeting("agt_1");
    expect(hive.isAgentCollaborating("agt_1")).toBe(false);
    expect(hive.isAgentCollaborating("agt_2")).toBe(false);
    expect(hive.hasAnyCollaboration()).toBe(false);
  });
});
