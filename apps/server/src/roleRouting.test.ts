// `tasks.suggested_role` had no reader.
//
// The planner wrote it, contextBuilder pasted it into the agent's prompt as a
// line of text ("Suggested Role: REVIEWER"), and routing ignored it entirely —
// so a plan could ask for a reviewer and the work landed on whoever happened
// to score highest. These pin it as a PREFERENCE, and pin just as hard the
// thing it must never become: a gate.
import { describe, expect, test } from "vitest";
import { evaluateAgentCandidates, roleFit, type AgentCandidate } from "./orchestrator.js";

const agent = (id: string, over: Partial<AgentCandidate> = {}): AgentCandidate => ({
  id, name: id, capabilities: [], concurrency: 2, machineOnline: true,
  roleId: null, role: null, ...over,
});
const noLoad = new Map<string, number>();
const pick = (cands: AgentCandidate[], suggestedRole: string | null, cap: string | null = null) =>
  evaluateAgentCandidates(cands, noLoad, cap, { suggestedRole }).chosen?.id ?? null;

describe("roleFit", () => {
  test("an exact role-definition match scores highest", () => {
    expect(roleFit(agent("a", { roleId: "security-auditor" }), "security-auditor")).toBe(25);
  });

  test("the office category is a weaker match, not no match", () => {
    // A plan asking for "review" is better served by anyone in the review room
    // than by a developer.
    expect(roleFit(agent("a", { role: "review" }), "review")).toBe(12);
  });

  test("case and whitespace do not decide routing", () => {
    expect(roleFit(agent("a", { roleId: "QA" }), "  qa ")).toBe(25);
  });

  test("no suggestion, or no match, is simply neutral", () => {
    expect(roleFit(agent("a", { roleId: "qa" }), null)).toBe(0);
    expect(roleFit(agent("a", { roleId: "qa" }), "")).toBe(0);
    expect(roleFit(agent("a", { roleId: "qa" }), "docs")).toBe(0);
  });
});

describe("the suggested role now decides a close call", () => {
  test("between two equally qualified agents, the suggested one wins", () => {
    const chosen = pick([agent("agt_dev", { roleId: "developer" }), agent("agt_rev", { roleId: "reviewer" })], "reviewer");
    expect(chosen).toBe("agt_rev");
  });

  test("without a suggestion the tie breaks the old way, on agent id", () => {
    // Deterministic routing is a property worth keeping — same inputs, same
    // choice, so a routing decision can be explained after the fact.
    const chosen = pick([agent("agt_b", { roleId: "reviewer" }), agent("agt_a", { roleId: "developer" })], null);
    expect(chosen).toBe("agt_a");
  });

  test("a category match beats no match", () => {
    const chosen = pick([agent("agt_x", { role: "developer" }), agent("agt_y", { role: "review" })], "review");
    expect(chosen).toBe("agt_y");
  });

  test("an exact roleId beats a mere category match", () => {
    const chosen = pick(
      [agent("agt_room", { role: "review" }), agent("agt_exact", { roleId: "security-auditor", role: "review" })],
      "security-auditor"
    );
    expect(chosen).toBe("agt_exact");
  });

  test("the breakdown says so, so a routing decision can be explained", () => {
    const res = evaluateAgentCandidates([agent("a", { roleId: "qa" })], noLoad, null, { suggestedRole: "qa" });
    expect(res.candidates[0].breakdown.roleScore).toBe(25);
  });
});

describe("what it must NEVER become", () => {
  test("a task still gets done when its ideal role is absent", () => {
    // The failure this guards against actually happened: when the planner
    // emitted role names no agent could hold, four of every five planned tasks
    // became unassignable. A preference degrades; a gate deadlocks.
    const chosen = pick([agent("agt_dev", { roleId: "developer" })], "security-auditor");
    expect(chosen).toBe("agt_dev");
  });

  test("it cannot make an ineligible agent eligible", () => {
    // Capability stays the hard gate. A perfect role match on an agent that
    // lacks the capability must still lose to a qualified one.
    const chosen = pick(
      [
        agent("agt_right_role", { roleId: "qa", capabilities: [] }),
        agent("agt_qualified", { roleId: "developer", capabilities: ["run_tests"] }),
      ],
      "qa",
      "run_tests"
    );
    expect(chosen).toBe("agt_qualified");
  });

  test("it cannot revive an offline agent", () => {
    const chosen = pick(
      [agent("agt_perfect", { roleId: "qa", machineOnline: false }), agent("agt_up", { roleId: "docs" })],
      "qa"
    );
    expect(chosen).toBe("agt_up");
  });

  test("it cannot push an agent past its concurrency limit", () => {
    const load = new Map([["agt_busy", 2]]);
    const res = evaluateAgentCandidates(
      [agent("agt_busy", { roleId: "qa", concurrency: 2 }), agent("agt_free", { roleId: "docs" })],
      load, null, { suggestedRole: "qa" }
    );
    expect(res.chosen?.id).toBe("agt_free");
  });
});
