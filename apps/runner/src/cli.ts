#!/usr/bin/env node
// CLI entry. `npm run dev` (== `start`) is the only command that matters for
// now — there's no real one-time enrollment flow yet (see DECISIONS.md D23),
// so this generates a stable machine id on first run and reuses it after.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection, type AgentDecl } from "./connection.js";

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

const agents: AgentDecl[] = [
  {
    id: `agt_${machineId}_dev`,
    name: arg("agent-name") ?? "dev-fake",
    role: "developer",
    capabilities: ["fake_work"],
    projects: [arg("project") ?? "prj_demo"],
  },
];

const conn = new RunnerConnection({
  serverUrl: arg("server") ?? "ws://localhost:8787/node-ws",
  identity,
  machineName: arg("machine-name") ?? machineId,
  ownerId: arg("owner-id") ?? "usr_dev",
  ownerName: arg("owner-name") ?? "dev",
  dataDir,
  agents,
  log: (msg) => console.log(`[runner ${machineId}] ${msg}`),
});

console.log(`[runner ${machineId}] starting, connecting to ${arg("server") ?? "ws://localhost:8787/node-ws"}`);
conn.connect();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    conn.stop();
    process.exit(0);
  });
}
