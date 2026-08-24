#!/usr/bin/env node
// CLI entry. `npm run dev` (== `start`) is the only command that matters for
// now — there's no real one-time enrollment flow yet (see DECISIONS.md D23),
// so this generates a stable machine id on first run and reuses it after.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, type AgentDecl } from "./connection.js";
import { fakeHarness } from "./harness/fakeHarness.js";
import { makePtyHarness } from "./harness/ptyHarness.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dataDir = arg("data-dir") ?? join(homedir(), ".logbridge");
mkdirSync(dataDir, { recursive: true });

function stableMachineId(): string {
  const p = join(dataDir, "machine-id.txt");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const id = `node_${crypto.randomUUID().slice(0, 8)}`;
  writeFileSync(p, id);
  return id;
}

const machineId = arg("machine-id") ?? stableMachineId();
const identity = loadOrCreateIdentity(dataDir, machineId);

// Agents are declared by the machine's owner (SYSTEM.md §7). Either inline
// via flags for the single-agent case, or from a JSON file listing several —
// one machine can now run agents on different providers.
function loadAgents(): AgentDecl[] {
  const file = arg("agents-file");
  if (file) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of agents`);
    return parsed.map((a: any, i: number) => {
      if (!a.id || !a.name) throw new Error(`agent #${i} in ${file} needs at least an id and a name`);
      return { role: "developer", capabilities: [], projects: [arg("project") ?? "prj_demo"], ...a };
    });
  }
  return [{
    id: `agt_${machineId}_dev`,
    name: arg("agent-name") ?? "dev-fake",
    role: "developer",
    capabilities: ["fake_work"],
    projects: [arg("project") ?? "prj_demo"],
    provider: arg("provider"),
    model: arg("model") ?? null,
  }];
}

const agents: AgentDecl[] = loadAgents();

// Which harness actually does the work. Defaults to the fake worker —
// spending real money is opt-in, never accidental. See DECISIONS.md D24.
const harnessKind = arg("harness") ?? process.env.AGENT_HARNESS ?? "fake";
const harness = harnessKind === "fake"
  ? fakeHarness
  : makePtyHarness({
      provider: arg("provider"),          // see PROVIDERS.md
      command: arg("cli-command"),        // override the binary if it's not on PATH
      model: arg("model") ?? null,
      // Providers with no enforceable tool policy refuse to run unless the
      // machine's owner explicitly accepts that. See PROVIDERS.md.
      allowUnsandboxed: process.argv.includes("--allow-unsandboxed"),
    });
if (harnessKind !== "fake") {
  console.log(`[runner ${machineId}] using REAL harness: ${harness.name} — see PROVIDERS.md for what's verified`);
}

const conn = new RunnerConnection({
  serverUrl: arg("server") ?? "ws://localhost:8787/node-ws",
  identity,
  machineName: arg("machine-name") ?? machineId,
  ownerId: arg("owner-id") ?? "usr_dev",
  ownerName: arg("owner-name") ?? "dev",
  dataDir,
  agents,
  harness,
  allowUnsandboxed: process.argv.includes("--allow-unsandboxed"),
  // Opt-in, like --accept-delegations: this is what allows a browser to
  // start real CLIs on this machine. Default off. See D1/D3.
  allowAgentCreation:
    process.argv.includes("--allow-agent-creation") ||
    process.env.LOGBRIDGE_ALLOW_AGENT_CREATION === "1",
  log: (msg) => console.log(`[runner ${machineId}] ${msg}`),
});

if (process.argv.includes("--allow-agent-creation") || process.env.LOGBRIDGE_ALLOW_AGENT_CREATION === "1") {
  console.log(`[runner ${machineId}] agent creation from the browser is ENABLED on this machine`);
}

console.log(`[runner ${machineId}] starting, connecting to ${arg("server") ?? "ws://localhost:8787/node-ws"}`);
conn.connect();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    conn.stop();
    process.exit(0);
  });
}
