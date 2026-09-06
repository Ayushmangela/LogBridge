// Pause, retire and delete, applied on the machine that actually runs the
// agent.
//
// All five envelope types existed in the protocol with NO handler, so every
// one of them stopped at the server's database. Invisible while agents are
// local — Delete kills the PTY directly, Pause works because the orchestrator
// filters paused candidates. On a friend's laptop neither held: Pause let an
// in-flight agent carry on, and Delete left their CLI running with no roster
// entry and no way to stop it, still spending.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAgentLifecycle, isHalted, resetHalted,
} from "./connection/agent-lifecycle-handler.js";
import { createdAgentsPath } from "./createdAgents.js";
import type { AgentDecl } from "./connection/types.js";

let dataDir = "";
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "lb-life-")); resetHalted(); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); dataDir = ""; resetHalted(); });

const anAgent = (id = "agt_x"): AgentDecl =>
  ({ id, name: "worker", role: "developer", capabilities: [], projects: ["prj"] } as any);

function run(
  type: string,
  agent: AgentDecl,
  opts: { created?: AgentDecl[]; roster?: AgentDecl[]; running?: string[] } = {}
) {
  const created = opts.created ?? [agent];
  const roster = opts.roster ?? [agent];
  const running = opts.running ?? [];
  const stopped: string[] = [];
  const logs: string[] = [];

  handleAgentLifecycle(
    { dataDir, agents: roster } as any,
    created,
    { type } as any,
    { agentId: agent.id },
    {
      log: (m) => logs.push(m),
      agentById: (id) => roster.find((a) => a.id === id),
      stopTasksFor: (agentId) => {
        const ids = running.filter(() => agentId === agent.id);
        stopped.push(...ids);
        return ids;
      },
      forget: (agentId) => {
        const i = roster.findIndex((a) => a.id === agentId);
        if (i >= 0) roster.splice(i, 1);
      },
    }
  );
  return { stopped, logs, created, roster };
}

describe("pause and retire stop NEW work", () => {
  test("a paused agent is refused further offers on this machine", () => {
    const a = anAgent();
    expect(isHalted(a.id)).toBe(false);
    run("agent.pause", a);
    expect(isHalted(a.id)).toBe(true);
  });

  test("retire behaves the same way", () => {
    const a = anAgent();
    run("agent.retire", a);
    expect(isHalted(a.id)).toBe(true);
  });

  test("work already in flight is LEFT ALONE", () => {
    // The database's own note for `paused` is "visible but never routed work".
    // A human who wants to stop a running task has Cancel; killing it on Pause
    // would discard a run that cost real money on a verb that never promised
    // to do that.
    const a = anAgent();
    const { stopped } = run("agent.pause", a, { running: ["tsk_1"] });
    expect(stopped).toEqual([]);
  });

  test("resume and unretire make it available again", () => {
    const a = anAgent();
    run("agent.retire", a);
    run("agent.unretire", a);
    expect(isHalted(a.id)).toBe(false);

    run("agent.pause", a);
    run("agent.resume", a);
    expect(isHalted(a.id)).toBe(false);
  });

  test("pausing one agent does not halt another", () => {
    run("agent.pause", anAgent("agt_a"));
    expect(isHalted("agt_a")).toBe(true);
    expect(isHalted("agt_b")).toBe(false);
  });
});

describe("delete has to reach into the running process", () => {
  test("it stops the running task BEFORE forgetting the agent", () => {
    // Forgetting first would orphan the CLI: the process outlives every record
    // of what it was, which is the exact failure this handler exists to stop.
    const a = anAgent();
    const { stopped, roster } = run("agent.delete", a, { running: ["tsk_1", "tsk_2"] });
    expect(stopped).toEqual(["tsk_1", "tsk_2"]);
    expect(roster.find((x) => x.id === a.id)).toBeUndefined();
  });

  test("a runtime-created agent is removed from disk so it stays deleted", () => {
    const a = anAgent();
    const { created } = run("agent.delete", a);
    expect(created).toEqual([]);
    const path = createdAgentsPath(dataDir);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });

  test("a DECLARED agent is not written out of the owner's own config", () => {
    // Declared agents come from the machine owner's CLI flags. The server
    // deleting one must not silently rewrite their configuration; it returns
    // on restart, and the log says so.
    const a = anAgent();
    const { logs } = run("agent.delete", a, { created: [] });
    expect(existsSync(createdAgentsPath(dataDir))).toBe(false);
    expect(logs.join(" ")).toContain("returns on restart");
  });

  test("deleting clears any halt, so the id cannot leak into a future agent", () => {
    const a = anAgent();
    run("agent.pause", a);
    run("agent.delete", a);
    expect(isHalted(a.id)).toBe(false);
  });
});

describe("messages for agents this machine does not hold", () => {
  test("a pause for an unknown agent is ignored, not an error", () => {
    // The server addresses a MACHINE; a machine legitimately does not hold
    // every agent in a project.
    const { logs } = run("agent.pause", anAgent("agt_elsewhere"), { roster: [] });
    expect(isHalted("agt_elsewhere")).toBe(false);
    expect(logs).toEqual([]);
  });

  test("a delete still cleans up even if the agent is not on the live roster", () => {
    // The row may be gone from memory while its entry survives on disk from a
    // previous run — that is exactly the state that leaves an orphan.
    const a = anAgent();
    const { created } = run("agent.delete", a, { roster: [], created: [a] });
    expect(created).toEqual([]);
  });
});
