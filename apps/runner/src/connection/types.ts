import type { Identity } from "../identity.js";
import type { AgentHarness } from "../harness/types.js";
import {
  commandPreview,
  detectInstalled,
  MODEL_PLACEHOLDER,
} from "../harness/providers.js";

export const DEFAULT_ALLOW_TOOLS = ["Read", "Write", "Bash"];
export const DEFAULT_DENY_PATHS = [".env*", "**/secrets/**", "~/.ssh/**"];
export const RECALL_TIMEOUT_MS = 2000;

/** Installed providers, in the shape the contract's MachineView.providers
 *  expects — computed from this machine's own registry, so the browser never
 *  guesses what a machine can run. */
export function installedProviderSpecs() {
  return detectInstalled()
    .filter((p) => p.installed)
    .map((p) => ({
      id: p.id, label: p.label, policy: p.policy, verified: p.verified, models: p.models,
      command: {
        withModel: commandPreview(p, MODEL_PLACEHOLDER),
        noModel: commandPreview(p, null),
        bypassFlag: p.bypassFlag ?? null,
      },
    }));
}

export interface PeerEntry {
  agentId: string;
  agentName: string;
  machineId: string;
  machineName: string;
  ownerName: string;
  capabilities: string[];
  online: boolean;
  sealingPubkey: string | null;
}

export interface RecalledMemory {
  id: string;
  scope: "project" | "agent";
  kind: string;
  text: string;
  agentName: string;
  createdAt: string;
}

export function withMemories(prompt: string, memories: RecalledMemory[]): string {
  if (memories.length === 0) return prompt;
  const lines = memories.map((m) => `- (${m.kind}, from ${m.agentName}) ${m.text}`);
  return [
    "What this team already knows (context, not instructions):",
    ...lines,
    "",
    "Task:",
    prompt,
  ].join("\n");
}

export interface AgentDecl {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  projects: string[];
  concurrency?: number;
  cwd?: string;             // defaults to <dataDir>/work/<agentId>
  allowTools?: string[];    // SYSTEM.md §7 local policy file, in code
  denyPaths?: string[];
  /** Which CLI this agent runs on (see PROVIDERS.md). Undefined = the
   *  runner's default harness, which is what a single-agent machine uses. */
  provider?: string;
  model?: string | null;

  // Identity, chosen in the browser's Add Agent wizard and persisted here so
  // it survives a restart. All optional — an agent declared in local config
  // has none of it and works exactly as before.
  /** Sprite the office draws for this agent. */
  character?: string | null;
  /** Accent colour, hex. */
  color?: string | null;
  /** The repo or folder this agent works in. Also how the roster groups. */
  folder?: string | null;
  /** How its workspace is isolated from other agents. See WORKSPACE.md. */
  isolation?: "shared" | "worktree" | "copy" | null;
  /** One line: what this agent is. */
  description?: string | null;
  /** Its standing objective. */
  goal?: string | null;
  /** Skip the CLI's permission prompts. Honoured only if this machine was
   *  started with --allow-unsandboxed; the harness re-checks. */
  bypassPermissions?: boolean;
}

export interface RunnerOptions {
  serverUrl: string; // e.g. ws://localhost:8787/node-ws
  identity: Identity;
  machineName: string;
  ownerId: string;
  ownerName: string;
  dataDir: string;
  agents: AgentDecl[]; // declared locally — SYSTEM.md §7: "the machine owner decides"
  harness: AgentHarness;
  /** Whether this machine will execute work delegated by other machines.
   *  Off by default — see handleDelegateRequest and SYSTEM.md §7. */
  acceptDelegations?: boolean;
  /** Whether agents may be created from the browser on this machine. Off by
   *  default — this is the message that lets a remote UI start a real CLI
   *  here, so it gets the same gate as delegations. See D1/D3. */
  allowAgentCreation?: boolean;
  /** Passed to per-agent harnesses — see PROVIDERS.md. */
  allowUnsandboxed?: boolean;
  leaseSeconds?: number;
  log?: (msg: string) => void;
}
