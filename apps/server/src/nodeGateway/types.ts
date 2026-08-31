import type { WebSocket } from "ws";
import type { ChatMessageT, EnvelopeT } from "@logbridge/protocol";

export type NodeSockets = Map<string, WebSocket>; // machineId -> socket, only while authenticated

export interface NodeGatewayOptions {
  leaseSeconds?: number;
  sweepIntervalMs?: number;
  /** Broadcast a chat message to every browser — the question inbox lives
   *  in the room, not in a private channel. See PLAN.md §8. */
  onChat?: (chat: ChatMessageT) => void;
  /** How long a delegation may sit awaiting its owner's consent before the
   *  requester gets "denied (no answer)". Tests shorten this. */
  consentTimeoutMs?: number;
}

export interface AgentCreateRequest {
  machineId: string;
  projectId: string;
  name: string;
  role: string;
  /** Role DEFINITION name (roles/loader.ts), e.g. "security-auditor". Stored
   *  on the agent row only — deliberately NOT sent to the runner, because the
   *  prompt is built server-side and the runner has no use for it. */
  roleId?: string | null;
  provider?: string | null;
  model?: string | null;
  capabilities?: string[];
  cwd?: string | null;
  allowTools?: string[];
  denyPaths?: string[];
  /** Identity from the Add Agent wizard — all optional. */
  character?: string | null;
  color?: string | null;
  folder?: string | null;
  isolation?: "shared" | "worktree" | "copy" | null;
  description?: string | null;
  goal?: string | null;
  /** Requested only — the machine decides. See ptyHarness. */
  bypassPermissions?: boolean;
}

export interface HeldDelegation {
  env: EnvelopeT;
  targetMachineId: string;
  requesterAgentId: string;
  capability: string;
  projectId: string | null;
  timer: NodeJS.Timeout;
}
