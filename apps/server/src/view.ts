import type { Db } from "./db.js";
import { lastSeq, recentMemories, tasksForProject } from "./db.js";
import {
  zoneFor,
  type AgentViewT,
  type BoardTaskT,
  type MachineViewT,
  type RoomT,
  type WorkspaceViewT,
} from "@logbridge/protocol";

export class Positions {
  private map = new Map<string, { roomId: string; x: number; y: number }>();

  set(userId: string, pos: { roomId: string; x: number; y: number }) {
    this.map.set(userId, pos);
  }

  get(userId: string) {
    return this.map.get(userId) ?? null;
  }
}

export function buildView(db: Db, positions: Positions, meId: string): WorkspaceViewT {
  const projects = db.prepare("SELECT * FROM projects ORDER BY id").all() as any[];
  const users = db.prepare("SELECT * FROM users ORDER BY rowid").all() as any[];
  const machines = db.prepare("SELECT * FROM machines").all() as any[];
  const agents = db.prepare("SELECT * FROM agents").all() as any[];

  const machineById = new Map(machines.map((m) => [m.id, m]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const cabinOf = new Map(users.map((u, i) => [u.id, u.cabin ?? i % 4]));

  const rooms: RoomT[] = projects.map((p) => {
    const roomHumans = users
      .filter((u) => positions.get(u.id)?.roomId === p.id)
      .map((u) => {
        const pos = positions.get(u.id);
        return {
          id: u.id,
          name: u.name ?? u.gh_login ?? u.id,
          avatar: u.avatar ?? 0,
          presence: "online" as const,
          position: pos ? { x: pos.x, y: pos.y } : null,
          cabin: cabinOf.get(u.id) ?? null,
        };
      });

    const roomAgents = agents.filter((a) => a.project_id === p.id);

    const views: AgentViewT[] = roomAgents.map((a) => {
      const machine = machineById.get(a.machine_id);
      const owner = userById.get(a.owner_id);
      const taskRow = a.current_task
        ? (db.prepare("SELECT * FROM tasks WHERE id = ?").get(a.current_task) as any)
        : null;
      const ghRef = a.github_ref ? JSON.parse(a.github_ref) : null;

      return {
        id: a.id,
        name: a.name,
        ownerId: a.owner_id,
        ownerName: owner?.name ?? owner?.gh_login ?? a.owner_id,
        machineId: a.machine_id,
        machineName: machine?.name ?? a.machine_id,
        role: a.role,
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
              note: null,
            }
          : null,
        waitingOn: a.waiting_on ?? null,
        githubRef: ghRef,
      };
    });

    // zone + stable slots: sort by id within each zone (contract invariant #3)
    const byZone = new Map<string, AgentViewT[]>();
    for (const av of views) {
      av.zone = zoneFor({
        status: av.status,
        waitingOn: av.waitingOn,
        hasLiveDelegation: false,
      });
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
      // Only project-scoped memories reach the browser: an agent's private
      // working notes are for that agent's own recall, not a team display.
      memories: recentMemories(db, p.id, 30).filter((m) => m.scope === "project"),
    };
  });

  return {
    seq: lastSeq(db),
    serverTime: new Date().toISOString(),
    meId,
    rooms,
  };
}
