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

// One open/recent pull request, mirrored read-only from GitHub (M6, D10).
// CI state comes from commit statuses; null = none published yet. Capped in
// the view like everything else on Room.
export const PullView = z.object({
  id: z.string(),              // "pr_acme_api#212"
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  ci: z.enum(["pending", "success", "failure"]).nullable(),
  author: z.string().nullable(),
  updatedAt: z.string(),
});
export type PullViewT = z.infer<typeof PullView>;

export const TaskBrief = z.object({
  id: z.string(),
  title: z.string(),
  elapsedSec: z.number().int().nonnegative(),
  costUsd: z.number(),
  /** The agent's most recent line of work — what it is doing right now. */
  note: z.string().nullable(),
  /** Step boundaries the CLI has reported so far. A COUNT, deliberately not
   *  a fraction: providers expose when a step happens, never how many are
   *  left, so any percentage would be invented. 0 = none reported yet. */
  steps: z.number().int().nonnegative(),
});

// The Kanban board's row shape — every task in the room, not just an
// agent's *current* one (TaskBrief above is scoped to a single agent and
// has no state/identity fields; the board needs both). Deliberately not
// here yet: drag-to-reorder and task dependencies, both of which need
// write-paths the protocol doesn't have.
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
export const MemoryView = z.object({  id: z.string(),
  scope: z.enum(["project", "agent"]),
  kind: z.enum(["fact", "preference", "decision", "outcome"]),
  text: z.string(),
  agentName: z.string(),
  createdAt: z.string(),
});

// One line of "what just happened", projected server-side from the event
// log so the wording lives in exactly one place. Capped in the view like
// tasks and memories — CONTRACT.md invariant 1 only holds while the
// snapshot stays small.
export const ActivityItem = z.object({
  seq: z.number().int().nonnegative(),   // event log sequence — stable ordering
  type: z.string(),                      // the raw event type, for filtering
  actor: z.string().nullable(),          // agent/human name, null for the system
  summary: z.string(),                   // already human-readable
  taskId: z.string().nullable(),
  ts: z.string(),
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

  // ★ 1.20 — who this agent IS, as opposed to what it is doing.
  //
  // All nullable: every agent that existed before this shipped has none of
  // it, and an agent is perfectly usable without any. The office falls back
  // to a deterministic sprite rather than refusing to draw one, so a null
  // here is a missing preference and never a missing agent.
  /** Sprite the office draws. One of the renderer's CHAR_NAMES. */
  character: z.string().nullable(),
  /** Accent colour as a hex string, e.g. "#c05d5d". */
  color: z.string().nullable(),
  /** The repo or folder this agent works in — also how the roster groups. */
  folder: z.string().nullable(),
  /** How its workspace is isolated. See WORKSPACE.md. */
  isolation: z.enum(["shared", "worktree", "copy"]).nullable(),
  /** A human's scratch note, shown under the agent in the roster. */
  note: z.string().nullable(),
  /** One line: what this agent is. Shown as the header tagline. */
  description: z.string().nullable(),
  /** Its standing objective, from the briefing step. */
  goal: z.string().nullable(),
  /** Which agent CLI this runs (PROVIDERS.md). Null = the machine's default
   *  harness. Optional for the same reason ProviderInfo.command is: agents
   *  registered before this existed have no value, and a required field here
   *  would drop the whole view. */
  provider: z.string().nullable().optional(),

  // ★ 1.23 — summon: "come here" is a real event (HANDOFF-PRESENCE Phase 4).
  // The agent walks to the caller's position and stays until dismissed or it
  // gets work (work always wins). Stored on the agent row; cleared on dismiss
  // or on status → working. Optional for the same reason as provider: older
  // rows have no value and a required field would blank the office.
  summonedBy: z.string().nullable().optional(),
  summonedAt: z.string().nullable().optional(),
  summonedPos: Point.nullable().optional(),
});

// What a machine reports about the CLIs it actually has installed — computed
// by the runner from its own provider registry at connect time. The browser
// renders this; it never guesses what a machine can run.
export const ProviderInfo = z.object({
  id: z.string(),
  label: z.string(),
  policy: z.enum(["claude-settings", "none"]),
  verified: z.boolean(),
  models: z.array(z.string()),

  // ★ 1.21 — what this provider will actually run.
  //
  // Generated on the machine from the SAME buildArgs the harness spawns, so
  // the preview cannot drift from reality. A preview written by hand in the
  // browser would stay convincing while quietly becoming wrong, and it would
  // also have to guess flags for CLIs the browser has never seen.
  //
  // OPTIONAL, and that is load-bearing. `providers` is JSON stored at a
  // machine's last handshake, so every machine that connected before this
  // field existed has rows without it. The gateway validates the whole view
  // before sending and drops it entirely on failure — so making this
  // required blanked the office for EVERY room until each runner happened to
  // reconnect. Any field added here has the same shape of risk: stored
  // producer data cannot be made required retroactively.
  command: z.object({
    /** Contains the literal "<model>" for the browser to substitute. */
    withModel: z.string(),
    /** Used when no model is selected — not the same as substituting "". */
    noModel: z.string(),
    /** Flags that disable this CLI's permission prompts, or null when it has
     *  no such mode. Shown verbatim so the toggle is never a mystery. */
    bypassFlag: z.string().nullable(),
  }).optional(),
});

export type ProviderInfoT = z.infer<typeof ProviderInfo>;

export const MachineView = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  online: z.boolean(),
  lastSeen: z.string(),
  // Installed providers (only ones actually on that machine's PATH).
  providers: z.array(ProviderInfo),
  // Gates, reported by the machine itself and enforced by it too — the UI
  // greys things out, but the runner is what refuses.
  allowAgentCreation: z.boolean(),
  allowUnsandboxed: z.boolean(),
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
  // True only when two or more DISTINCT owners have a machine online. Two
  // machines belonging to one person is not collaboration, and the office
  // shouldn't advertise a meeting room nobody can be in.
  collaborationAvailable: z.boolean(),
  pulls: z.array(PullView),
  memories: z.array(MemoryView),
  activity: z.array(ActivityItem),
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

// One open/recent pull request, mirrored read-only from GitHub (M6, D10).
// CI state comes from commit statuses; null = none published yet. Capped in
// the view like everything else on Room.
export type ActivityItemT = z.infer<typeof ActivityItem>;
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
  // Which room this browser is looking at. Until it arrives the server has
  // no way to scope anything per-room — membership was previously only
  // implied by `position`, which doesn't exist until the player moves.
  // Sent on first view and whenever the viewer switches rooms.
  z.object({ type: z.literal("join"), roomId: z.string() }),
  z.object({ type: z.literal("position"), roomId: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("chat"), roomId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("answer"),
    taskId: z.string(),
    choice: z.enum(["approve", "edit", "reject", "answer"]),
    // edit: `text` replaces the title, `spec` (when given) the instructions.
    // answer: `text` is what the human said. Others ignore both.
    text: z.string().optional(),
    spec: z.string().optional(),
    // Delegation consent only: approve can mean once or forever. Ignored by
    // every other handler. See the grants table and SEALED.md.
    mode: z.enum(["once", "always", "never"]).optional(),
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
