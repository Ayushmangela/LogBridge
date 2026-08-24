import { z } from "zod";
import { TaskState } from "./task-state.js";

export const AgentRole = z.enum([
  "developer", "research", "qa", "review", "docs", "planner",
]);

export const AgentStatus = z.enum([
  "idle", "working", "waiting", "blocked",
  "needs_input", "reviewing", "completed", "failed",
]);

export const ZoneId = z.enum([
  "idle", "working", "reviewing", "collaborating",
  "blocked", "needs_human", "done",
]);

export const TaskBrief = z.object({
  id: z.string(),
  title: z.string(),
  elapsedSec: z.number().int().nonnegative(),
  costUsd: z.number(),
  note: z.string().nullable(),
});

// The Kanban board's row shape — every task in the room, not just an
// agent's *current* one (TaskBrief above is scoped to a single agent and
// has no state/identity fields; the board needs both). Munder Difflin-style
// board, LogBridge data: no drag-and-drop, no dependency graph — see
// BOARD-KICKOFF.md for what's deliberately not here yet.
export const BoardTask = z.object({
  id: z.string(),
  title: z.string(),
  state: TaskState,
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  costUsd: z.number(),
});

// What the team knows (MEMORY.md). Capped in the view for the same reason
// BoardTask is — CONTRACT.md invariant 1 only stays true if the snapshot
// stays small. The full store is queried by agents, not shipped to browsers.
export const MemoryView = z.object({
  id: z.string(),
  scope: z.enum(["project", "agent"]),
  kind: z.enum(["fact", "preference", "decision", "outcome"]),
  text: z.string(),
  agentName: z.string(),
  createdAt: z.string(),
});

const Point = z.object({ x: z.number(), y: z.number() });

export const HumanView = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.number().int().min(0).max(7),
  presence: z.enum(["online", "away", "offline"]),
  position: Point.nullable(),
  cabin: z.number().int().min(0).max(3).nullable(),
});

export const AgentView = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  machineId: z.string(),
  machineName: z.string(),
  role: AgentRole,
  status: AgentStatus,
  zone: ZoneId,
  slot: z.number().int().nonnegative(),
  zoneAnchor: z.number().int().min(0).max(3).nullable(),
  task: TaskBrief.nullable(),
  waitingOn: z.string().nullable(),
  githubRef: z
    .object({ kind: z.enum(["pr", "issue"]), ref: z.string() })
    .nullable(),
});

export const MachineView = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  online: z.boolean(),
  lastSeen: z.string(),
});

export const Room = z.object({
  id: z.string(),
  name: z.string(),
  callLink: z.string().nullable(),
  layout: z.string(),
  humans: z.array(HumanView),
  agents: z.array(AgentView),
  machines: z.array(MachineView),
  tasks: z.array(BoardTask),
  memories: z.array(MemoryView),
});

export const WorkspaceView = z.object({
  seq: z.number().int().nonnegative(),
  serverTime: z.string(),
  meId: z.string(),
  rooms: z.array(Room),
});

export type TaskBriefT = z.infer<typeof TaskBrief>;
export type BoardTaskT = z.infer<typeof BoardTask>;
export type MemoryViewT = z.infer<typeof MemoryView>;
export type HumanViewT = z.infer<typeof HumanView>;
export type AgentViewT = z.infer<typeof AgentView>;
export type MachineViewT = z.infer<typeof MachineView>;
export type RoomT = z.infer<typeof Room>;
export type WorkspaceViewT = z.infer<typeof WorkspaceView>;

export const ChatMessage = z.object({
  id: z.string(),
  roomId: z.string(),
  from: z.object({ kind: z.enum(["user", "agent"]), id: z.string(), name: z.string() }),
  text: z.string(),
  ts: z.string(),
  ask: z
    .object({
      taskId: z.string(),
      options: z.array(z.enum(["approve", "edit", "reject", "answer"])),
    })
    .nullable(),
});

export type ChatMessageT = z.infer<typeof ChatMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("view"), view: WorkspaceView }),
  z.object({ type: z.literal("chat"), roomId: z.string(), msg: ChatMessage }),
]);

export type ServerMessageT = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("position"), roomId: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("chat"), roomId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("answer"),
    taskId: z.string(),
    choice: z.enum(["approve", "edit", "reject", "answer"]),
    text: z.string().optional(),
  }),
]);

export type ClientMessageT = z.infer<typeof ClientMessage>;

export function zoneFor(a: {
  status: z.infer<typeof AgentStatus>;
  waitingOn: string | null;
  hasLiveDelegation?: boolean;
}): z.infer<typeof ZoneId> {
  if (a.status === "blocked" && a.waitingOn?.includes("@")) return "collaborating";
  if (a.status === "working" && a.hasLiveDelegation) return "collaborating";
  switch (a.status) {
    case "idle":
    case "waiting":
      return "idle";
    case "working":
      return "working";
    case "reviewing":
      return "reviewing";
    case "blocked":
      return "blocked";
    case "needs_input":
      return "needs_human";
    case "completed":
    case "failed":
      return "done";
  }
}
