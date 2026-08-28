import type { Db } from "./db.js";
import { lastSeq, recentMemories, tasksForProject, getProjectWorkflows, getProjectGoals } from "./db.js";
import { getProjectApprovals } from "./approvals.js";
import { getProjectEscalations } from "./escalations.js";
import { getProjectDeadLetters } from "./deadLetter.js";
import { recentActivity } from "./activity.js";
import type { HiveManager } from "./hive.js";
import {
  zoneFor,
  type AgentViewT,
  type BoardTaskT,
  type MachineViewT,
  type ProviderInfoT,
  type PullViewT,
  type RoomT,
  type TriggerViewT,
  type WorkflowViewT,
  type WorkspaceViewT,
  type HumanViewT,
} from "@logbridge/protocol";

export class Positions {
  private map = new Map<string, { roomId: string; x: number; y: number }>();

  set(userId: string, pos: { roomId: string; x: number; y: number }) {
    this.map.set(userId, pos);
  }

  get(userId: string) {
    return this.map.get(userId) ?? null;
  }

  delete(userId: string) {
    return this.map.delete(userId);
  }
}

/**
 * What an agent is doing right now, from the last thing it reported.
 *
 * `task.event` is excluded from the activity feed on purpose — it's a
 * firehose (see activity.ts). But the LATEST one is exactly what belongs on
 * the agent's own card, which is why this reads the tail rather than the
 * stream. `steps` is a count: the runner increments it per reported step
 * boundary, and no provider knows the total, so nothing here is ever a
 * percentage.
 */
export function latestProgress(db: Db, taskId: string): { note: string | null; steps: number } {
  // json_valid() is not defensive padding: json_extract THROWS on a malformed
  // body, and this runs inside the workspace projection — so one corrupt event
  // row would blank the whole office for every room, not just this card.
  const note = db
    .prepare(
      `SELECT json_extract(body, '$.summary') AS summary FROM events
       WHERE task_id = ? AND type = 'task.event' AND json_valid(body)
       ORDER BY seq DESC LIMIT 1`
    )
    .get(taskId) as any;

  // The newest event is not necessarily a step boundary — an ordinary output
  // line lands after one — so the count is read from the newest event that
  // actually carries it, rather than resetting to 0 on the next line of chat.
  const step = db
    .prepare(
      `SELECT json_extract(body, '$.data.steps') AS steps FROM events
       WHERE task_id = ? AND type = 'task.event' AND json_valid(body)
         AND json_extract(body, '$.data.steps') IS NOT NULL
       ORDER BY seq DESC LIMIT 1`
    )
    .get(taskId) as any;

  const summary = typeof note?.summary === "string" ? note.summary.trim() : "";
  const steps = Number(step?.steps);
  return {
    note: summary ? summary.slice(0, 80) : null,
    steps: Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 0,
  };
}

function parseJsonArray(raw: unknown): ProviderInfoT[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Newest-first, capped — the same bounded-projection rule as tasks/memories.
function recentPulls(db: Db, projectId: string, limit: number): PullViewT[] {
  const rows = db.prepare(
    "SELECT * FROM github_pulls WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?"
  ).all(projectId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title ?? "",
    state: r.state === "merged" || r.state === "closed" || r.state === "draft" ? r.state : "open",
    ci: r.ci === "success" || r.ci === "failure" || r.ci === "pending" ? r.ci : null,
    author: r.author ?? null,
    updatedAt: r.updated_at ?? new Date().toISOString(),
  }));
}

function normalizeRole(role: string | null | undefined): "developer" | "research" | "qa" | "review" | "docs" | "planner" {
  if (!role) return "developer";
  const r = role.toLowerCase();
  if (r.includes("plan") || r.includes("command") || r.includes("orchestrat") || r.includes("lead")) return "planner";
  if (r.includes("research") || r.includes("specialist") || r.includes("brand") || r.includes("menu")) return "research";
  if (r.includes("qa") || r.includes("test")) return "qa";
  if (r.includes("review")) return "review";
  if (r.includes("doc")) return "docs";
  return "developer";
}

export function buildView(db: Db, positions: Positions, meId: string, hive?: HiveManager): WorkspaceViewT {
  const projects = db.prepare("SELECT * FROM projects ORDER BY id").all() as any[];
  const users = db.prepare("SELECT * FROM users ORDER BY rowid").all() as any[];
  const machines = db.prepare("SELECT * FROM machines").all() as any[];
  const agents = db.prepare("SELECT * FROM agents").all() as any[];

  const machineById = new Map(machines.map((m) => [m.id, m]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const cabinOf = new Map(users.map((u, i) => [u.id, u.cabin ?? i % 4]));

  const rooms: RoomT[] = projects.map((p) => {
    let projectUsers = db.prepare(
      "SELECT u.* FROM users u JOIN project_members pm ON u.id = pm.user_id WHERE pm.project_id = ?"
    ).all(p.id) as any[];
    if (!projectUsers.length) projectUsers = users;

    const roomHumans: HumanViewT[] = projectUsers
      .filter((u) => {
        const pos = positions.get(u.id);
        if (pos?.roomId === p.id) return true;
        if (positions.get("you")?.roomId === p.id && (u.id === "you" || (users.length === 1 && users[0].id === u.id))) return true;
        return false;
      })
      .map((u, idx) => {
        let pos = positions.get(u.id);
        if (!pos && (u.id === "you" || (users.length === 1 && users[0].id === u.id))) {
          pos = positions.get("you");
        }
        return {
          id: u.id,
          name: u.name ?? u.gh_login ?? u.id,
          avatar: ((Number(u.avatar) || idx) % 8),
          presence: "online" as const,
          position: pos ? { x: pos.x, y: pos.y } : null,
          cabin: (cabinOf.get(u.id) ?? (idx % 4)) as 0 | 1 | 2 | 3,
        };
      });

    // Backwards compatibility for tests that set "you" directly in positions
    const youPos = positions.get("you");
    if (youPos && youPos.roomId === p.id && !roomHumans.some((h) => h.id === "you")) {
      roomHumans.unshift({
        id: "you",
        name: "You",
        avatar: 0,
        presence: "online",
        position: { x: youPos.x, y: youPos.y },
        cabin: 0,
      });
    }

    const roomAgents = agents.filter((a) => a.project_id === p.id);

    const roomTriggers: TriggerViewT[] = (
      db.prepare("SELECT * FROM triggers WHERE project_id = ? ORDER BY created_at").all(p.id) as any[]
    ).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      enabled: Boolean(r.enabled),
      kind: r.kind as "schedule" | "event",
      rule: r.rule,
      taskTitle: r.task_title ?? null,
      taskSpec: r.task_spec ?? null,
      taskCapability: r.task_capability ?? null,
      budgetSeconds: r.budget_seconds ?? null,
      budgetUsd: r.budget_usd ?? null,
      tz: r.tz ?? null,
      createdAt: r.created_at,
      lastFiredAt: r.last_fired_at ?? null,
      nextFireAt: r.next_fire_at ?? null,
      lastEvtSeq: r.last_evt_seq ?? 0,
    }));

    const views: AgentViewT[] = roomAgents.map((a) => {
      const machine = machineById.get(a.machine_id);
      const owner = userById.get(a.owner_id);
      const taskRow = a.current_task
        ? (db.prepare("SELECT * FROM tasks WHERE id = ?").get(a.current_task) as any)
        : null;
      // M6: a task that came from a GitHub issue carries its origin in the
      // idem key ("gh:owner/repo#42") — surface it so the office links back.
      let ghRef = a.github_ref ? JSON.parse(a.github_ref) : null;
      if (!ghRef && taskRow?.idem?.startsWith("gh:")) {
        const ref = String(taskRow.idem).slice(3); // "acme/api#42"
        ghRef = { kind: ref.includes("#") && Number(ref.split("#")[1]) % 1 === 0 ? "issue" : "issue", ref };
      }

      return {
        id: a.id,
        name: a.name,
        ownerId: a.owner_id,
        ownerName: owner?.name ?? owner?.gh_login ?? a.owner_id,
        machineId: a.machine_id,
        machineName: machine?.name ?? a.machine_id,
        // Straight passthrough — the browser must not invent an identity for
        // an agent (invariant 2). A null is a real "not set", and the office
        // falls back deterministically rather than picking at random, so two
        // people watching the same room see the same sprite.
        character: a.character ?? null,
        color: a.color ?? null,
        folder: a.folder ?? null,
        isolation: a.isolation ?? null,
        note: a.note ?? null,
        description: a.description ?? null,
        goal: a.goal ?? null,
        provider: a.provider ?? null,
        summonedBy: a.summoned_by ?? null,
        summonedAt: a.summoned_at ?? null,
        summonedPos: a.summoned_x != null && a.summoned_y != null ? { x: Number(a.summoned_x), y: Number(a.summoned_y) } : null,
        paused: Boolean(a.paused),
        retired: Boolean(a.retired),
        health: {
          lastHeartbeat: machine?.last_seen ?? null,
          consecutiveFailures: (() => {
            const pastStates = db.prepare(
              "SELECT state FROM tasks WHERE agent_id = ? AND state IN ('completed', 'failed') ORDER BY created_at DESC LIMIT 10"
            ).all(a.id) as any[];
            let f = 0;
            for (const s of pastStates) {
              if (s.state === "failed") f++;
              else break;
            }
            return f;
          })(),
          machineOnline: Boolean(machine?.online),
        },
        machineOnline: Boolean(machine?.online),
        contextUsed: a.context_used ?? null,
        contextLimit: a.context_limit ?? null,
        toolCalls: a.tool_calls ?? (taskRow ? 1 : 0),
        cwd: a.folder ?? null,
        model: a.model ?? null,
        role: normalizeRole(a.role),
        status: a.status,
        zone: "idle",
        slot: 0,
        zoneAnchor: a.zone_anchor ?? null,
        task: taskRow
          ? {
              id: taskRow.id,
              title: taskRow.title,
              elapsedSec: taskRow.started_at
                ? Math.max(0, Math.floor((Date.now() - Date.parse(taskRow.started_at)) / 1000))
                : 0,
              costUsd: taskRow.cost_usd ?? 0,
              ...latestProgress(db, taskRow.id),
            }
          : null,
        waitingOn: a.waiting_on ?? null,
        githubRef: ghRef,
      };
    });

    // zone + stable slots: sort by id within each zone (contract invariant #3)
    const byZone = new Map<string, AgentViewT[]>();
    for (const av of views) {
      const isCollab = hive ? hive.isAgentCollaborating(av.id) : false;
      if (isCollab) {
        av.zone = "collaborating";
        const partnerName = hive?.getCollaborationPartner(av.id);
        if (partnerName) {
          av.waitingOn = partnerName;
        }
      } else {
        av.zone = zoneFor({
          status: av.status,
          waitingOn: av.waitingOn,
          hasLiveDelegation: false,
        });
      }
      if (av.zone === "needs_human" && av.zoneAnchor === null && av.waitingOn?.startsWith("human: ")) {
        const waitingName = av.waitingOn.slice("human: ".length);
        const owner = users.find((u) => u.name === waitingName);
        if (owner) av.zoneAnchor = cabinOf.get(owner.id) ?? null;
      }
      const list = byZone.get(av.zone) ?? [];
      list.push(av);
      byZone.set(av.zone, list);
    }
    for (const list of byZone.values()) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      list.forEach((av, i) => (av.slot = i));
    }

    // scoped to THIS project: only machines that actually run an agent here —
    // showing every machine in every room was the bug (a machine with no
    // agents on this project has no business appearing in it).
    const machineIdsInRoom = new Set(roomAgents.map((a) => a.machine_id));
    const roomMachines: MachineViewT[] = machines
      .filter((m) => machineIdsInRoom.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        ownerId: m.owner_id,
        online: Boolean(m.online),
        lastSeen: m.last_seen,
        // What the machine itself reported at its last handshake. An empty
        // provider list is honest: an older runner that predates capability
        // reporting genuinely offers nothing creatable.
        providers: parseJsonArray(m.providers),
        allowAgentCreation: Boolean(m.allow_agent_creation),
        allowUnsandboxed: Boolean(m.allow_unsandboxed),
      }));

    const boardTasks: BoardTaskT[] = tasksForProject(db, p.id).map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      agentId: t.agent_id ?? null,
      agentName: t.agent_name ?? null,
      // Rows from before the created_at column existed (see db.ts's
      // migration guard) have it NULL — fall back rather than violate the
      // contract's non-nullable createdAt.
      createdAt: t.created_at ?? t.started_at ?? new Date(0).toISOString(),
      startedAt: t.started_at ?? null,
      costUsd: t.cost_usd ?? 0,
    }));

    return {
      id: p.id,
      name: p.name ?? p.gh_repo ?? p.id,
      callLink: p.call_link ?? null,
      layout: p.layout ?? "office",
      humans: roomHumans,
      agents: views,
      machines: roomMachines,
      tasks: boardTasks,
      // Distinct owners with an online machine. Cross-machine delegation,
      // review and consent are all inert below two — surfacing them would be
      // furniture for something you can't do.
      collaborationAvailable:
        new Set(roomMachines.filter((m) => m.online).map((m) => m.ownerId)).size >= 2 ||
        (hive ? hive.hasAnyCollaboration() : false),
      // Only project-scoped memories reach the browser: an agent's private
      // working notes are for that agent's own recall, not a team display.
      memories: recentMemories(db, p.id, 30).filter((m) => m.scope === "project"),
      activity: recentActivity(db, p.id, 30),
      pulls: recentPulls(db, p.id, 20),
      triggers: roomTriggers,
      workflows: getProjectWorkflows(db, p.id).map((w) => ({
        id: w.id,
        projectId: w.project_id,
        title: w.title,
        description: w.description,
        creatorId: w.creator_id,
        state: w.state,
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      })),
      goals: getProjectGoals(db, p.id).map((g) => ({
        id: g.id,
        projectId: g.projectId,
        title: g.title,
        description: g.description,
        state: g.state,
        workflowId: g.workflowId,
        creatorId: g.creatorId,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        approvedAt: g.approvedAt,
        startedAt: g.startedAt,
        completedAt: g.completedAt,
      })),
      approvals: getProjectApprovals(db, p.id).map((a) => ({
        id: a.id,
        projectId: a.projectId,
        workflowId: a.workflowId,
        goalId: a.goalId,
        taskId: a.taskId,
        requesterId: a.requesterId,
        requesterType: a.requesterType,
        approvalType: a.approvalType,
        title: a.title,
        description: a.description,
        reason: a.reason,
        riskLevel: a.riskLevel,
        state: a.state,
        requestedAt: a.requestedAt,
        resolvedAt: a.resolvedAt,
        resolvedBy: a.resolvedBy,
      })),
      escalations: getProjectEscalations(db, p.id).map((e) => ({
        id: e.id,
        projectId: e.projectId,
        workflowId: e.workflowId,
        taskId: e.taskId,
        goalId: e.goalId,
        agentId: e.agentId,
        urgency: e.urgency,
        title: e.title,
        reason: e.reason,
        state: e.state,
        createdAt: e.createdAt,
        resolvedAt: e.resolvedAt,
        resolvedBy: e.resolvedBy,
      })),
      deadLetters: getProjectDeadLetters(db, p.id).map((dl) => ({
        id: dl.id,
        projectId: dl.projectId,
        taskId: dl.taskId,
        workflowId: dl.workflowId,
        goalId: dl.goalId,
        failureCategory: dl.failureCategory,
        retryAttempts: dl.retryAttempts,
        lastError: dl.lastError,
        recommendedAction: dl.recommendedAction,
        status: dl.status,
        createdAt: dl.createdAt,
        resolvedAt: dl.resolvedAt,
        resolvedBy: dl.resolvedBy,
      })),
    };
  });

  return {
    seq: lastSeq(db),
    serverTime: new Date().toISOString(),
    meId,
    rooms,
  };
}
