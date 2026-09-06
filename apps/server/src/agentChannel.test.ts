// One front door to reach an agent, and the routing rule behind it.
//
// The rule looks obvious and is not. "No socket, therefore run it here" is
// wrong in one direction and "always wait for the socket" is wrong in the
// other, and the codebase shipped both mistakes at once: three call sites
// tried runner-then-local, and twelve tried runner only — silently dropping
// every task assigned to a local agent.
import { describe, expect, test, vi, beforeEach } from "vitest";
import { openDb, type Db } from "./db.js";

const spawned: string[] = [];
const offered: string[] = [];

// The two primitives are stubbed: this file is about WHICH one gets called,
// not about PTYs or sockets.
vi.mock("./nodeGateway/task-offers.js", () => ({
  // Faithful to the real one: it succeeds only when the socket for THIS
  // agent's machine is open. A stub that ignored the agent would have made
  // the local-agent case look like it already worked.
  sendTaskOffer: (_db: any, sockets: any, taskId: string) => {
    if (!taskId.includes("remote")) return false;   // local agents have no runner
    const s = sockets.get("node_runner");
    if (s && s.readyState === s.OPEN) { offered.push(taskId); return true; }
    return false;
  },
  deliverTaskLocally: (_db: any, _s: any, taskId: string) => { spawned.push(taskId); return true; },
}));
vi.mock("./ptyGateway.js", () => ({
  submitPromptToAgent: () => false,
  spawnAndSubmit: (_db: any, agentId: string) => { spawned.push(agentId); return true; },
}));

const { deliverTask, deliverText } = await import("./agentChannel.js");

const OPEN = 1;
function sockets(connected: boolean) {
  return new Map(connected ? [["node_runner", { readyState: OPEN, OPEN, send: () => {} }]] : []) as any;
}

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_c", "x/c", "C", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_c", "c", "C", 0);
  // A machine with a pubkey has completed a runner handshake. One without has
  // never had a runner behind it — it is the browser-created, local-PTY case.
  db.prepare("INSERT INTO machines (id, owner_id, name, online, pubkey) VALUES (?,?,?,?,?)")
    .run("node_runner", "usr_c", "friend-laptop", 1, "ed25519-real-key");
  db.prepare("INSERT INTO machines (id, owner_id, name, online, pubkey) VALUES (?,?,?,?,?)")
    .run("node_local", "usr_c", "this-laptop", 1, null);

  for (const [id, machine] of [["agt_remote", "node_runner"], ["agt_local", "node_local"]] as const) {
    db.prepare(
      `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, machine, "usr_c", "prj_c", id, "developer", "[]", 1, "idle");
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(`tsk_${id}`, "prj_c", "work", "spec", "usr_c", id, "submitted", 60, 1, 0, new Date().toISOString());
  }
  return db;
}

beforeEach(() => { spawned.length = 0; offered.length = 0; });

describe("a task goes to the machine that owns the agent", () => {
  test("a connected runner gets the envelope", () => {
    const db = seed(openDb(":memory:"));
    expect(deliverTask(db, sockets(true), "tsk_agt_remote")).toMatchObject({ delivered: true, via: "runner" });
    expect(offered).toEqual(["tsk_agt_remote"]);
    expect(spawned).toEqual([]);
    db.close();
  });

  test("a LOCAL agent is run here — the case twelve call sites used to drop", () => {
    // sendTaskOffer returns false for a local agent because it has no runner
    // socket, and twelve callers treated that false as "done". The task sat at
    // `submitted` and the agent stayed `idle`, with nothing logged anywhere.
    const db = seed(openDb(":memory:"));
    expect(deliverTask(db, sockets(true), "tsk_agt_local")).toMatchObject({ delivered: true, via: "pty-spawn" });
    expect(spawned).toEqual(["tsk_agt_local"]);
    db.close();
  });
});

describe("a runner that is merely DOWN keeps its work", () => {
  test("its task waits for reconnect instead of being run here", () => {
    // The dangerous half. A runner's socket is closed while it restarts, and
    // its agents still belong to it — their workspace, their tool policy and
    // their CLI are all on that machine. Pulling the work here would run a
    // teammate's agent on the server's filesystem under the server's
    // permissions. reconcileOnConnect redelivers when it returns.
    const db = seed(openDb(":memory:"));
    const result = deliverTask(db, sockets(false), "tsk_agt_remote");
    expect(result).toMatchObject({ delivered: false, reason: "machine-offline" });
    expect(spawned).toEqual([]);
    db.close();
  });

  test("and a local agent is still served while that runner is down", () => {
    const db = seed(openDb(":memory:"));
    expect(deliverTask(db, sockets(false), "tsk_agt_local").delivered).toBe(true);
    db.close();
  });
});

describe("text delivery", () => {
  test("a local agent with no live session is spawned with the text", () => {
    const db = seed(openDb(":memory:"));
    expect(deliverText(db, sockets(false), "agt_local", "read your inbox"))
      .toMatchObject({ delivered: true, via: "pty-spawn" });
    db.close();
  });

  test("spawnIfCold:false never pays for a cold start", () => {
    // The circuit breaker's case: starting a CLI to say "stop spending money"
    // would spend money to say it.
    const db = seed(openDb(":memory:"));
    expect(deliverText(db, sockets(false), "agt_local", "slow down", { spawnIfCold: false }))
      .toMatchObject({ delivered: false });
    expect(spawned).toEqual([]);
    db.close();
  });

  test("a remote agent is refused honestly rather than run here", () => {
    const db = seed(openDb(":memory:"));
    expect(deliverText(db, sockets(true), "agt_remote", "hello"))
      .toMatchObject({ delivered: false, reason: "not-deliverable" });
    expect(spawned).toEqual([]);
    db.close();
  });

  test("an unknown agent says so rather than returning a bare false", () => {
    const db = seed(openDb(":memory:"));
    expect(deliverText(db, sockets(false), "agt_ghost", "hi"))
      .toMatchObject({ delivered: false, reason: "no-such-agent" });
    db.close();
  });
});
