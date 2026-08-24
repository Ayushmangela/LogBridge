import { describe, expect, test } from "vitest";
import {
  BodySchemas,
  Envelope,
  MESSAGE_TYPES,
  TERMINAL,
  assertTransition,
  canTransition,
  isSideEffecting,
  makeEnvelope,
  parseEnvelope,
  zoneFor,
} from "./index.js";
import type { TaskStateT } from "./index.js";

const ALL_STATES: TaskStateT[] = [
  "submitted", "working", "input-required", "auth-required", "blocked",
  "completed", "failed", "canceled", "rejected",
];

describe("task state machine", () => {
  test("terminal states are terminal", () => {
    for (const s of TERMINAL) expect(canTransition(s, s)).toBe(false);
    for (const s of TERMINAL) {
      for (const t of ALL_STATES) {
        if (t !== s) expect(canTransition(s, t), `${s} → ${t}`).toBe(false);
      }
    }
  });

  test("cannot go completed → working", () => {
    expect(canTransition("completed", "working")).toBe(false);
  });

  test("happy path works end to end", () => {
    expect(canTransition("submitted", "working")).toBe(true);
    expect(canTransition("working", "blocked")).toBe(true);
    expect(canTransition("blocked", "working")).toBe(true);
    expect(canTransition("working", "completed")).toBe(true);
  });

  test("rejected only reachable from submitted", () => {
    expect(canTransition("submitted", "rejected")).toBe(true);
    for (const s of ALL_STATES) {
      if (s !== "submitted") expect(canTransition(s, "rejected"), s).toBe(false);
    }
  });

  test("assertTransition throws on illegal transition at runtime", () => {
    expect(() => assertTransition("completed", "working")).toThrow(/illegal/);
    expect(() => assertTransition("canceled", "working")).toThrow();
    expect(() => assertTransition("submitted", "working")).not.toThrow();
  });
});

describe("envelope schemas", () => {
  test("every message type has a body schema", () => {
    for (const t of MESSAGE_TYPES) {
      expect(BodySchemas[t], `missing body schema for ${t}`).toBeDefined();
    }
  });

  function validBody(type: string): unknown {
    const budget = { seconds: 600, usd: 1.5 };
    switch (type) {
      case "task.offer": return { taskId: "t1", title: "x", spec: null, acceptance: null, budget };
      case "task.accept": return { taskId: "t1" };
      case "task.status": return { taskId: "t1", state: "working", note: null };
      case "task.event": return { taskId: "t1", kind: "tool_call", summary: "ran tests" };
      case "task.result":
        return { taskId: "t1", state: "completed", reason: null, artifact: null };
      case "task.cancel": return { taskId: "t1", by: "user", reason: null };
      case "delegate.request":
        return { capability: "run_tests", targetNodeId: "n1", projectId: "p1", inputs: {}, acceptance: null, budget, contextRefs: [], contextNote: null };
      case "delegate.decision": return { requestId: "r1", decision: "once", by: null };
      case "delegate.result":
        return { requestId: "r1", taskId: "t1", state: "completed", verified: true, artifact: null };
      case "review.request":
        return { toAgentId: null, subject: { kind: "pr", ref: "a/b#1" }, criteria: ["correct"], depth: "quick", budget };
      case "review.result":
        return { requestId: "r1", verdict: "approved", findings: [], summary: "ok", confidence: "high" };
      case "context.share":
        return { toAgentId: "a1", kind: "decision", title: "t", body: "b", refs: [], ttlDays: 7 };
      case "context.ack": return { shareId: "s1", accepted: true };
      case "human.ask": return { taskId: "t1", question: "push?", options: ["approve"] };
      case "human.answer": return { askId: "h1", choice: "answer", text: "yes" };
      case "agent.card":
        return {
          id: "agt_1", name: "dev", ownerId: "u1", machineId: "m1",
          role: "developer", capabilities: ["fix_test"], harness: "claude-agent-sdk",
          projects: ["acme/api"], concurrency: 1, status: "idle",
        };
      case "node.status": return { machineId: "m1", online: true, lastSeen: new Date().toISOString() };
      case "presence": return { userId: "u1", state: "online" };
      case "chat": return { roomId: "r1", fromKind: "user", fromId: "u1", fromName: "sam", text: "hi" };
      case "position": return { userId: "u1", roomId: "r1", x: 3, y: 4 };
      case "memory.write":
        return { scope: "project", kind: "fact", text: "the deploy script needs sudo", sourceTaskId: null };
      case "memory.recall": return { requestId: "req_1", query: "how do we deploy", limit: 5 };
      case "memory.result":
        return {
          requestId: "req_1",
          memories: [{
            id: "mem_1", scope: "project", kind: "fact", text: "the deploy script needs sudo",
            agentName: "dev-api", createdAt: new Date().toISOString(),
          }],
        };
      default: throw new Error(`no fixture for ${type}`);
    }
  }

  function envelopeFor(type: string, idem: string | null = "01JIDEM0000000000000000000") {
    return {
      v: 1,
      id: "01J00000000000000000000000",
      type,
      project: "prj_acme_api",
      from: { kind: "node", id: "node_1" },
      to: { kind: "node", id: "node_2" },
      task: "tsk_1",
      idem,
      ts: new Date().toISOString(),
      body: validBody(type),
    };
  }

  test("every type validates with a correct body", () => {
    for (const t of MESSAGE_TYPES) {
      const res = parseEnvelope(envelopeFor(t));
      expect(res.ok, `type ${t}: ${res.ok ? "" : res.error}`).toBe(true);
    }
  });

  test("side-effecting types require idem", () => {
    for (const t of MESSAGE_TYPES) {
      const res = parseEnvelope(envelopeFor(t, isSideEffecting(t) ? null : "x"));
      if (isSideEffecting(t)) {
        expect(res.ok, `${t} should require idem`).toBe(false);
      } else {
        expect(res.ok, `${t} should not require idem`).toBe(true);
      }
    }
  });

  test("rejects an invalid body per type", () => {
    expect(parseEnvelope({ ...envelopeFor("task.status"), body: { taskId: "t1", state: "flying" } }).ok).toBe(false);
    const bad = parseEnvelope({ ...envelopeFor("task.offer"), body: {} });
    expect(bad.ok).toBe(false);
  });

  test("rejects wrong envelope version and unknown types", () => {
    expect(Envelope.safeParse({ ...envelopeFor("presence"), v: 2 }).success).toBe(false);
    expect(
      Envelope.safeParse({ ...envelopeFor("presence"), type: "explode" }).success
    ).toBe(false);
  });

  test("round-trips through JSON without loss", () => {
    for (const t of MESSAGE_TYPES) {
      const env = makeEnvelope(t as never, {
        project: "prj_acme_api",
        from: { kind: "user", id: "u1" },
        to: { kind: "room", id: "r1" },
        task: null,
      }, validBody(t) as never);
      const back = parseEnvelope(JSON.parse(JSON.stringify(env)));
      expect(back.ok, `round-trip ${t}`).toBe(true);
    }
  });
});

describe("zone mapping", () => {
  test("contract examples map correctly", () => {
    expect(zoneFor({ status: "idle", waitingOn: null })).toBe("idle");
    expect(zoneFor({ status: "waiting", waitingOn: null })).toBe("idle");
    expect(zoneFor({ status: "working", waitingOn: null })).toBe("working");
    expect(zoneFor({ status: "reviewing", waitingOn: null })).toBe("reviewing");
    expect(zoneFor({ status: "blocked", waitingOn: "CI" })).toBe("blocked");
    expect(zoneFor({ status: "needs_input", waitingOn: null })).toBe("needs_human");
    expect(zoneFor({ status: "completed", waitingOn: null })).toBe("done");
    expect(zoneFor({ status: "failed", waitingOn: null })).toBe("done");
  });

  test("collaborating is derived, not a status", () => {
    expect(zoneFor({ status: "blocked", waitingOn: "qa-api@sams-mbp" })).toBe("collaborating");
    expect(
      zoneFor({ status: "working", waitingOn: null, hasLiveDelegation: true })
    ).toBe("collaborating");
  });
});
