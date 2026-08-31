// Apply a server-side agent edit to this machine's own copy.
//
// The runner is the ENFORCER of tool policy — ptyHarness writes allowTools /
// denyPaths into the scoped settings file before every spawn, and
// delegation-handler passes them to the harness. So an edit made in the
// browser that never reaches here changes what the office DISPLAYS without
// changing what the agent may actually do, which is the worst possible split:
// a permissions UI that lies.
//
// The in-memory list and created-agents.json are both updated, because the
// former decides the next spawn and the latter decides what survives a runner
// restart. Updating one without the other just moves the drift.
import type { EnvelopeT } from "@logbridge/protocol";
import { saveCreatedAgents } from "../createdAgents.js";
import type { AgentDecl, RunnerOptions } from "./types.js";

export function handleAgentPatch(
  opts: RunnerOptions,
  createdAgents: AgentDecl[],
  _env: EnvelopeT,
  body: any,
  helpers: {
    log: (msg: string) => void;
    agentById: (id: string | null | undefined) => AgentDecl | undefined;
    publishCard: (a: AgentDecl) => void;
  }
): void {
  const agent = helpers.agentById(body?.agentId);
  if (!agent) {
    // Not an error worth shouting about: the server addresses the machine, and
    // a machine legitimately does not hold every agent in a project.
    return;
  }

  // A field that is absent means "unchanged". Only null and arrays are
  // instructions — null clears the policy back to the runner's defaults, an
  // array (including an empty one) sets it. Treating absent as null would let
  // a patch about a colour wipe an agent's permissions.
  const changed: string[] = [];
  for (const key of ["allowTools", "denyPaths"] as const) {
    if (body?.[key] === undefined) continue;
    const value = body[key];
    if (value === null) {
      delete (agent as any)[key];
    } else if (Array.isArray(value)) {
      (agent as any)[key] = value.filter((t: unknown) => typeof t === "string");
    } else {
      continue;
    }
    changed.push(key);
  }
  if (changed.length === 0) return;

  helpers.log(`agent.patch ${agent.name}: ${changed.join(", ")} updated`);

  // Only agents created at runtime live in that file; a declared agent's
  // policy comes from the owner's own CLI flags and this must not overwrite
  // it on disk. The in-memory change above still applies for this session,
  // and the declared value returns on restart — which is the right precedence
  // (createdAgents.ts: "declared agents stay the source of truth").
  if (createdAgents.some((a) => a.id === agent.id)) {
    saveCreatedAgents(opts.dataDir, createdAgents, helpers.log);
  }
  helpers.publishCard(agent);
}
