// The runner is the ENFORCER of tool policy — ptyHarness writes allowTools /
// denyPaths into the scoped settings before every spawn. An edit made in the
// browser that never reaches here would change what the office displays
// without changing what the agent may do: a permissions UI that lies.
//
// `agent.patch` had been in the protocol since 1.25 with no sender and no
// handler at all. These pin the handler's contract.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentPatch } from "./connection/agent-patch-handler.js";
import { createdAgentsPath } from "./createdAgents.js";
import type { AgentDecl } from "./connection/types.js";

let dataDir = "";
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "lb-patch-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); dataDir = ""; });

function run(agent: AgentDecl, body: any, created: AgentDecl[] = [agent]) {
  const logs: string[] = [];
  const cards: AgentDecl[] = [];
  handleAgentPatch(
    { dataDir, agents: [agent] } as any,
    created,
    {} as any,
    body,
    {
      log: (m) => logs.push(m),
      agentById: (id) => (id === agent.id ? agent : undefined),
      publishCard: (a) => cards.push(a),
    }
  );
  return { logs, cards };
}

const anAgent = (): AgentDecl =>
  ({ id: "agt_x", name: "worker", projects: ["prj"], allowTools: ["Read", "Write"] } as any);

describe("agent.patch on the runner", () => {
  test("an array replaces the policy the next spawn will enforce", () => {
    const agent = anAgent();
    run(agent, { agentId: "agt_x", allowTools: ["Read"] });
    expect((agent as any).allowTools).toEqual(["Read"]);
  });

  test("an absent field is left alone", () => {
    // A patch about a colour must not touch permissions. This is why the
    // protocol field is nullish rather than defaulted.
    const agent = anAgent();
    run(agent, { agentId: "agt_x", denyPaths: ["**/.env"] });
    expect((agent as any).allowTools).toEqual(["Read", "Write"]);
    expect((agent as any).denyPaths).toEqual(["**/.env"]);
  });

  test("null clears the policy back to the machine's defaults", () => {
    const agent = anAgent();
    run(agent, { agentId: "agt_x", allowTools: null });
    // Deleted, not set to [] — delegation-handler reads `agent.allowTools ??
    // DEFAULT_ALLOW_TOOLS`, so [] would mean "no tools at all" instead.
    expect((agent as any).allowTools).toBeUndefined();
  });

  test("an empty array is a real policy, not a clear", () => {
    const agent = anAgent();
    run(agent, { agentId: "agt_x", allowTools: [] });
    expect((agent as any).allowTools).toEqual([]);
  });

  test("the change is persisted so it survives a runner restart", () => {
    const agent = anAgent();
    run(agent, { agentId: "agt_x", allowTools: ["Grep"] });
    const path = createdAgentsPath(dataDir);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))[0].allowTools).toEqual(["Grep"]);
  });

  test("a DECLARED agent is not written to created-agents.json", () => {
    // createdAgents.ts: declared agents are the machine owner's explicit
    // configuration and win on restart. Persisting a patch for one here would
    // quietly promote a server-side edit over the owner's own CLI flags.
    const agent = anAgent();
    run(agent, { agentId: "agt_x", allowTools: ["Grep"] }, /* created */ []);
    expect(existsSync(createdAgentsPath(dataDir))).toBe(false);
    // ...but it still applies for this session.
    expect((agent as any).allowTools).toEqual(["Grep"]);
  });

  test("an agent this machine does not hold is ignored", () => {
    const { cards } = run(anAgent(), { agentId: "agt_somewhere_else", allowTools: ["Read"] });
    expect(cards).toEqual([]);
  });

  test("a patch that changes nothing publishes no card", () => {
    const { cards } = run(anAgent(), { agentId: "agt_x" });
    expect(cards).toEqual([]);
  });
});
