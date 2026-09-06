// Pause, resume, retire, unretire and delete, applied on the machine that
// actually runs the agent.
//
// These five envelope types were in the protocol with no handler at all, so
// every one of them stopped at the server's database. That is invisible while
// all your agents are local — Delete kills the PTY directly, and Pause works
// because the orchestrator filters paused agents out when picking a candidate.
// It stops being invisible the moment an agent lives on a friend's laptop:
//
//   * Pause held back new offers, but their runner never heard, so an agent
//     already mid-task carried on.
//   * Delete removed the row on the server and left their CLI running, with
//     no roster entry, no terminal panel and no way to stop it short of
//     finding the process by hand — still spending.
//
// WHAT EACH ONE MEANS HERE
//
//   pause / retire      stop taking NEW work. Work in flight is left alone:
//                       the database's own note for `paused` is "visible but
//                       never routed work", and a human who wants to stop a
//                       running task has Cancel for that. Killing it here
//                       would discard a run that cost real money on a verb
//                       that does not promise to.
//   resume / unretire   take work again.
//   delete              the one that must reach into a running process: stop
//                       the task, forget the agent, persist the forgetting.
import type { EnvelopeT } from "@logbridge/protocol";
import { saveCreatedAgents } from "../createdAgents.js";
import type { AgentDecl, RunnerOptions } from "./types.js";

/** Agents this machine has been told not to accept work for. Kept in memory
 *  only: the server holds the durable flag and re-sends it on reconnect, and a
 *  runner that persisted "paused" could strand an agent nobody can un-pause if
 *  the two ever disagreed. */
const halted = new Set<string>();

/** Should this machine refuse an offer for this agent? Consulted by the
 *  task.offer handler, which is the only place it can actually be enforced. */
export function isHalted(agentId: string | null | undefined): boolean {
  return Boolean(agentId && halted.has(agentId));
}

/** Test seam, and the right thing on a fresh connection. */
export function resetHalted(): void {
  halted.clear();
}

export interface LifecycleHelpers {
  log: (msg: string) => void;
  agentById: (id: string | null | undefined) => AgentDecl | undefined;
  /** Stop a running task. Returns the ids it stopped. */
  stopTasksFor: (agentId: string) => string[];
  /** Drop the agent from this machine's live roster. */
  forget: (agentId: string) => void;
}

export function handleAgentLifecycle(
  opts: RunnerOptions,
  createdAgents: AgentDecl[],
  env: EnvelopeT,
  body: any,
  helpers: LifecycleHelpers
): void {
  const agentId = body?.agentId;
  if (!agentId) return;

  const agent = helpers.agentById(agentId);
  // Not an error worth shouting about: the server addresses a machine, and a
  // machine legitimately does not hold every agent in a project.
  if (!agent && env.type !== "agent.delete") return;

  const name = agent?.name ?? agentId;

  switch (env.type) {
    case "agent.pause":
    case "agent.retire": {
      halted.add(agentId);
      const verb = env.type === "agent.pause" ? "paused" : "retired";
      helpers.log(`${name} ${verb} — no new work will be accepted here`);
      return;
    }

    case "agent.resume":
    case "agent.unretire": {
      halted.delete(agentId);
      helpers.log(`${name} is available again`);
      return;
    }

    case "agent.delete": {
      halted.delete(agentId);
      // Stop the work FIRST. Forgetting the agent while its CLI is still
      // running is exactly the orphan this handler exists to prevent — the
      // process would outlive every record of what it was.
      const stopped = helpers.stopTasksFor(agentId);
      helpers.forget(agentId);

      const idx = createdAgents.findIndex((a) => a.id === agentId);
      if (idx >= 0) {
        createdAgents.splice(idx, 1);
        // Only runtime-created agents live in that file. A DECLARED agent
        // comes from the owner's own CLI flags and returns on restart; the
        // server deleting it must not silently rewrite their configuration.
        saveCreatedAgents(opts.dataDir, createdAgents, helpers.log);
      }

      helpers.log(
        `${name} deleted${stopped.length ? ` — stopped ${stopped.length} running task(s)` : ""}` +
          (idx < 0 ? " (declared locally, so it returns on restart)" : "")
      );
      return;
    }
  }
}
