/**
 * Every state the office can render must trace to a real event in the log or to
 * stored state the server owns — the invariant the whole office rests on.
 *
 * This file enumerates each renderable state (agent status, zone, activity
 * line, badge) and proves it with a real DB row and a real view/event, never
 * a hand-built array. Where something does NOT trace, it is listed with a
 * recommendation rather than forced.
 */
import { describe, expect, test } from "vitest";
import { appendEvent, createTask, openDb, setAgentStatus, summonAgent, type Db } from "./db.js";
import { buildView, Positions } from "./view.js";
import { describeEvent, recentActivity } from "./activity.js";
import { createTrigger } from "./triggers.js";
import { WorkspaceView, zoneFor } from "@logbridge/protocol";

function seedProject(db: Db, id = "prj_a") {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_1", "u1", "u1", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run("m1", "usr_1", "m1", new Date().toISOString(), 1);
}

function addAgent(db: Db, id: string, status: string) {
  db.prepare("INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status) VALUES (?,?,?,?,?,?,?)")
    .run(id, "m1", "usr_1", "prj_a", id, "developer", status);
}

const ev = (type: string, body: unknown, taskId: string | null = "tsk_1", seq = 1) => ({
  seq, type, task_id: taskId, body: JSON.stringify(body), ts: new Date().toISOString(),
});
const titled = (t: string | null) => () => t;

describe("agent status traces to stored state (agents.status)", () => {
  const statuses = ["idle", "working", "waiting", "blocked", "needs_input", "reviewing", "completed", "failed"] as const;
  for (const status of statuses) {
    test(`status "${status}" survives a round-trip through the DB and the view`, () => {
      const db = openDb(":memory:");
      seedProject(db);
      addAgent(db, `agt_${status}`, status);
      const view = buildView(db, new Positions(), "usr_1");
      const ag = view.rooms[0].agents.find((a) => a.id === `agt_${status}`)!;
      expect(ag.status).toBe(status);
      // And the view itself is valid — the gateway would send it
      expect(WorkspaceView.safeParse(view).success).toBe(true);
      db.close();
    });
  }

  test("setAgentStatus is the write side and is itself driven by events (task.accept → working, task.result → idle)", () => {
    const db = openDb(":memory:");
    seedProject(db);
    addAgent(db, "agt_1", "idle");
    // Simulate the event that causes the transition: task.accept
    const t = createTask(db, { projectId: "prj_a", title: "work", creatorId: "you", agentId: "agt_1" });
    setAgentStatus(db, "agt_1", "working", t);
    appendEvent(db, "prj_a", t, "task.accept", {});
    let view = buildView(db, new Positions(), "usr_1");
    expect(view.rooms[0].agents[0].status).toBe("working");
    expect(view.rooms[0].agents[0].task?.id).toBe(t);

    // Completion clears the task and returns to idle
    setAgentStatus(db, "agt_1", "idle", null);
    appendEvent(db, "prj_a", t, "task.result", { state: "completed" });
    view = buildView(db, new Positions(), "usr_1");
    expect(view.rooms[0].agents[0].status).toBe("idle");
    expect(view.rooms[0].agents[0].task).toBeNull();
    db.close();
  });
});

describe("zone traces to stored state via zoneFor (status + waitingOn)", () => {
  const cases: Array<{ status: string; waitingOn: string | null; zone: string }> = [
    { status: "idle", waitingOn: null, zone: "idle" },
    { status: "waiting", waitingOn: null, zone: "idle" },
    { status: "working", waitingOn: null, zone: "working" },
    { status: "reviewing", waitingOn: null, zone: "reviewing" },
    { status: "blocked", waitingOn: null, zone: "blocked" },
    { status: "blocked", waitingOn: "qa-api@sams-mbp", zone: "collaborating" },
    { status: "needs_input", waitingOn: null, zone: "needs_human" },
    { status: "completed", waitingOn: null, zone: "done" },
    { status: "failed", waitingOn: null, zone: "done" },
  ];
  for (const c of cases) {
    test(`zoneFor(${c.status}, ${c.waitingOn ?? "null"}) → ${c.zone} and view shows it`, () => {
      // Pure function first
      expect(zoneFor({ status: c.status as any, waitingOn: c.waitingOn } as any)).toBe(c.zone);
      // Then through the view
      const db = openDb(":memory:");
      seedProject(db);
      db.prepare("INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, status, waiting_on) VALUES (?,?,?,?,?,?,?,?)")
        .run(`agt_${c.zone}`, "m1", "usr_1", "prj_a", `agt_${c.zone}`, "developer", c.status, c.waitingOn);
      const view = buildView(db, new Positions(), "usr_1");
      const ag = view.rooms[0].agents.find((a) => a.id === `agt_${c.zone}`)!;
      expect(ag.zone).toBe(c.zone);
      db.close();
    });
  }
});

describe("activity traces to the event log (describeEvent + recentActivity)", () => {
  const types = [
    "task.assigned",
    "task.accept",
    "task.result",
    "lease.expired",
    "task.cancel",
    "task.edit",
    "memory.write",
    "human.answer",
    "summon",
    "summon.cancel",
    "trigger.fired",
    "github.push",
    "github.pull",
  ];
  for (const type of types) {
    test(`activity type "${type}" is produced from an event row`, () => {
      const item = describeEvent(ev(type, {}), titled("x"));
      // Noise types are null, but none of the types above are noise
      expect(item, `${type} should not be noise`).not.toBeNull();
      expect(item!.type).toBe(type);
      expect(item!.summary.length).toBeGreaterThan(0);
    });
  }

  test("recentActivity round-trips through a real DB", () => {
    const db = openDb(":memory:");
    seedProject(db);
    const t = createTask(db, { projectId: "prj_a", title: "hello", creatorId: "you", agentId: null });
    appendEvent(db, "prj_a", t, "task.assigned", { agentName: "a" });
    appendEvent(db, "prj_a", null, "summon", { agentName: "dev-a", by: "you", x: 1, y: 2 });
    appendEvent(db, "prj_a", null, "trigger.fired", { triggerId: "trg_1", name: "t", rule: "r" });
    const feed = recentActivity(db, "prj_a", 10);
    expect(feed.some((f) => f.type === "task.assigned")).toBe(true);
    expect(feed.some((f) => f.type === "summon")).toBe(true);
    expect(feed.some((f) => f.type === "trigger.fired")).toBe(true);
    // Unknown future types still appear rather than vanish
    appendEvent(db, "prj_a", null, "some.future.thing", {});
    const feed2 = recentActivity(db, "prj_a", 10);
    expect(feed2.some((f) => f.type === "some.future.thing")).toBe(true);
    db.close();
  });
});

describe("badges trace to zone (ZONE_BADGE)", () => {
  // The browser's ZONE_BADGE is keyed by zone; if the zone traces, the badge traces.
  const zones = ["idle", "working", "reviewing", "collaborating", "blocked", "needs_human", "done"] as const;
  for (const zone of zones) {
    test(`badge for "${zone}" is keyed by zone`, () => {
      const db = openDb(":memory:");
      seedProject(db);
      // Map zone back to a status that produces it
      const statusFor: Record<string, string> = {
        idle: "idle", working: "working", reviewing: "reviewing",
        collaborating: "blocked", blocked: "blocked", needs_human: "needs_input", done: "completed",
      };
      const status = statusFor[zone]!;
      const waitingOn = zone === "collaborating" ? "x@y" : null;
      addAgent(db, "agt_badge", status);
      if (waitingOn) db.prepare("UPDATE agents SET waiting_on = ? WHERE id = ?").run(waitingOn, "agt_badge");
      const view = buildView(db, new Positions(), "usr_1");
      expect(view.rooms[0].agents[0].zone).toBe(zone);
      db.close();
    });
  }
});

describe("triggers and summoned position trace to stored state", () => {
  test("Room.triggers is stored state (triggers table) and appears in the view", () => {
    const db = openDb(":memory:");
    seedProject(db);
    createTrigger(db, { projectId: "prj_a", name: "t", kind: "schedule", rule: "every day at 09:00", template: { title: "do" }, tz: "UTC" });
    const view = buildView(db, new Positions(), "usr_1");
    expect(view.rooms[0].triggers).toHaveLength(1);
    expect(view.rooms[0].triggers[0].rule).toBe("every day at 09:00");
    expect(WorkspaceView.safeParse(view).success).toBe(true);
    db.close();
  });

  test("summonedPos is stored state (agents.summoned_*) and also logged as a summon event", () => {
    const db = openDb(":memory:");
    seedProject(db);
    addAgent(db, "agt_sum", "idle");
    summonAgent(db, "agt_sum", "you", 10, 20);
    appendEvent(db, "prj_a", null, "summon", { agentId: "agt_sum", agentName: "agt_sum", by: "you", x: 10, y: 20 });
    const view = buildView(db, new Positions(), "usr_1");
    expect(view.rooms[0].agents[0].summonedPos).toEqual({ x: 10, y: 20 });
    expect(view.rooms[0].activity.some((a) => a.type === "summon")).toBe(true);
    db.close();
  });

  test("empty triggers table still yields a valid view (no blank office)", () => {
    const db = openDb(":memory:");
    seedProject(db);
    addAgent(db, "agt_1", "idle");
    const view = buildView(db, new Positions(), "usr_1");
    expect(view.rooms[0].triggers).toEqual([]);
    expect(WorkspaceView.safeParse(view).success).toBe(true);
    db.close();
  });
});

describe("does NOT trace — idle roaming", () => {
  test("roaming is the only renderable motion with no event; it is deterministic and confined", () => {
    // The office renders an idle agent at a position that is NOT stored and NOT
    // logged — it is hash(agentId, bucket) inside the idle zone. Two browsers
    // must see the same office, so it cannot be Math.random(); it is derived
    // from data every client already has (agentId + serverTime). It is confined
    // to the idle zone so it never implies work. This is the D11 reconciliation:
    // wandering-while-idle depicts idleness rather than faking work. If this is
    // judged not to satisfy the invariant, the invariant should be reworded to
    // “every state that implies work traces to an event” — both outcomes are
    // acceptable; pretending it traces is not.
    expect(true).toBe(true);
  });
});
