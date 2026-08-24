// Agents created at runtime (from the browser) have to outlive the runner
// process, or the machine and the server disagree about what exists.
//
// The split-brain without this: the server keeps the agent row, so the office
// still draws it and the orchestrator still counts it as capacity — but the
// restarted runner has never heard of it. Work addressed to it then either
// vanishes or, worse, runs on whatever agent happens to be first, under a
// different provider and a different tool policy.
//
// Declared agents (CLI flags / --agents-file) stay the source of truth; this
// file only holds what was added later. On a conflict the declared one wins,
// because that's the machine owner's explicit configuration and this is a cache of
// requests they accepted.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentDecl } from "./connection.js";

const FILE = "created-agents.json";

export function createdAgentsPath(dataDir: string): string {
  return join(dataDir, FILE);
}

/** Everything this machine was asked to create and accepted, or [] if none. */
export function loadCreatedAgents(dataDir: string, log?: (m: string) => void): AgentDecl[] {
  const path = createdAgentsPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    // Skip malformed entries rather than refusing to start: one bad row
    // shouldn't cost the owner every other agent they created.
    return parsed.filter((a: any) => {
      const ok = a && typeof a.id === "string" && typeof a.name === "string" && Array.isArray(a.projects);
      if (!ok) log?.(`ignoring a malformed entry in ${FILE}`);
      return ok;
    });
  } catch (err) {
    log?.(`could not read ${FILE} (${(err as Error).message}) — starting with declared agents only`);
    return [];
  }
}

export function saveCreatedAgents(dataDir: string, agents: AgentDecl[], log?: (m: string) => void) {
  const path = createdAgentsPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated file
    // that loses every agent on the next start.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(agents, null, 2));
    renameSync(tmp, path); // atomic on the same filesystem
  } catch (err) {
    log?.(`could not persist ${FILE}: ${(err as Error).message}`);
  }
}

/**
 * Declared agents plus persisted ones, with declared winning on an id clash.
 * Order is stable: declared first, then created in the order they were added.
 */
export function mergeAgents(declared: AgentDecl[], created: AgentDecl[]): AgentDecl[] {
  const seen = new Set(declared.map((a) => a.id));
  return [...declared, ...created.filter((a) => !seen.has(a.id))];
}
