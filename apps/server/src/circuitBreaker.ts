// The circuit breaker the agents were already told about.
//
// Every employee prompt ends with:
//
//   "A circuit breaker watches the floor. If you receive
//    'Circuit breaker: steer/constrain' you are looping or overspending:
//    stop repeating, summarise what you tried, and follow the instruction."
//
// Nothing sent that string. Six agents were told a supervisor existed that
// did not, which is worse than having no breaker at all: an agent that has
// been promised an external stop has less reason to impose its own.
//
// WHAT IT IS NOT. Not a sandbox and not a kill switch — the runner's harness
// already enforces hard per-task budgets (maxSeconds, maxUsd) and will halt a
// task outright. This sits below that: it notices a run going wrong while it
// is still recoverable and tells the agent, in the exact words its prompt
// taught it to recognise, so the agent can correct itself and keep its
// context. Halting is the last resort; steering is the cheap one.
import type { Db } from "./db.js";
import { appendEvent } from "./db.js";

/** How close to the budget counts as overspending. Not 1.0: at the point the
 *  budget is gone there is nothing left to steer WITH, and the harness's own
 *  hard stop is about to fire anyway. */
export const SPEND_TRIP_FRACTION = 0.8;

/** How many identical progress lines in a row count as a loop. Two can be a
 *  coincidence of phrasing; four is an agent going in circles. */
export const REPEAT_TRIP_COUNT = 4;

/** How many recent events to look at per task. */
const EVENT_WINDOW = 8;

export type TripKind = "constrain" | "steer";

export interface Trip {
  kind: TripKind;
  taskId: string;
  agentId: string;
  projectId: string;
  /** The exact text handed to the agent. Begins with the phrase its own
   *  prompt tells it to recognise. */
  message: string;
  /** For the office chat and the event log — what a human needs to see. */
  reason: string;
}

/**
 * The wording matters more than it looks. The prompt trained the agent on the
 * literal prefix "Circuit breaker:", so that prefix is the contract; the rest
 * says what to do instead of merely what is wrong. An instruction an agent
 * cannot act on ("you are overspending") burns a turn producing an apology.
 */
function constrainMessage(spent: number, budget: number): string {
  return (
    `Circuit breaker: constrain. You have used $${spent.toFixed(2)} of a $${budget.toFixed(2)} budget on this task. ` +
    `Stop opening new lines of investigation. Finish or hand back what you already have: ` +
    `write your current state to $AGENT_DIR/memory.md, report what you did and what is left, and end your turn.`
  );
}

function steerMessage(repeated: string): string {
  return (
    `Circuit breaker: steer. You have reported the same step ${REPEAT_TRIP_COUNT} times in a row ("${repeated.slice(0, 80)}"). ` +
    `You are looping. Do not retry it again. Summarise what you tried and why it failed, ` +
    `then either take a different approach or send a message to "god" asking how to proceed.`
  );
}

/** Tasks that are actually running and can still be steered. */
function liveTasks(db: Db): any[] {
  return db
    .prepare(
      `SELECT id, project_id, agent_id, cost_usd, budget_usd, title
         FROM tasks
        WHERE state IN ('submitted', 'running', 'in_progress')
          AND agent_id IS NOT NULL`
    )
    .all() as any[];
}

/** The most recent progress lines for a task, newest first. */
function recentSummaries(db: Db, taskId: string): string[] {
  const rows = db
    .prepare(
      `SELECT json_extract(body, '$.summary') AS s
         FROM events
        WHERE task_id = ? AND type = 'task.event' AND json_valid(body)
          AND json_extract(body, '$.summary') IS NOT NULL
        ORDER BY seq DESC LIMIT ?`
    )
    .all(taskId, EVENT_WINDOW) as any[];
  return rows.map((r) => String(r.s ?? "").trim()).filter(Boolean);
}

/**
 * Which live tasks are in trouble right now.
 *
 * Pure: it reads, it decides, it returns. Nothing is injected, recorded or
 * broadcast here — that is `tripBreakers`. Splitting them is what makes the
 * thresholds testable without a PTY.
 */
export function evaluateBreakers(db: Db): Trip[] {
  const trips: Trip[] = [];

  for (const t of liveTasks(db)) {
    const budget = Number(t.budget_usd ?? 0);
    const spent = Number(t.cost_usd ?? 0);

    if (budget > 0 && spent >= budget * SPEND_TRIP_FRACTION) {
      trips.push({
        kind: "constrain",
        taskId: t.id,
        agentId: t.agent_id,
        projectId: t.project_id,
        message: constrainMessage(spent, budget),
        reason: `spent $${spent.toFixed(2)} of $${budget.toFixed(2)}`,
      });
      // One trip per task per pass. An agent told to both wrap up and change
      // approach in the same breath will do neither well.
      continue;
    }

    const summaries = recentSummaries(db, t.id);
    if (summaries.length >= REPEAT_TRIP_COUNT) {
      const newest = summaries[0];
      const identical = summaries.slice(0, REPEAT_TRIP_COUNT).every((s) => s === newest);
      if (identical) {
        trips.push({
          kind: "steer",
          taskId: t.id,
          agentId: t.agent_id,
          projectId: t.project_id,
          message: steerMessage(newest),
          reason: `repeated "${newest.slice(0, 60)}" ${REPEAT_TRIP_COUNT}×`,
        });
      }
    }
  }

  return trips;
}

export interface BreakerDeps {
  db: Db;
  /** Write into the agent's live PTY. False when it has no session. */
  inject: (agentId: string, text: string) => boolean;
  postChat?: (projectId: string, text: string) => void;
  log?: (msg: string) => void;
}

/**
 * A breaker fires ONCE per task per kind.
 *
 * Re-sending on every tick would be its own runaway: the agent gets "stop
 * looping" four times a minute, which is itself a loop, and each copy pushes
 * the real work further back in its context. The record lives in the event
 * log rather than memory so it survives a restart.
 */
function alreadyTripped(db: Db, taskId: string, kind: TripKind): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM events
        WHERE task_id = ? AND type = 'circuit.tripped' AND json_valid(body)
          AND json_extract(body, '$.kind') = ?
        LIMIT 1`
    )
    .get(taskId, kind);
  return Boolean(row);
}

export function tripBreakers(deps: BreakerDeps): Trip[] {
  const { db, inject, postChat, log } = deps;
  const fired: Trip[] = [];

  for (const trip of evaluateBreakers(db)) {
    if (alreadyTripped(db, trip.taskId, trip.kind)) continue;

    // An agent with no live session cannot be steered — and spawning one just
    // to deliver a warning would spend money to say "stop spending money".
    // Record it either way so the office can show it and a human can act.
    const delivered = inject(trip.agentId, trip.message);

    appendEvent(db, trip.projectId, trip.taskId, "circuit.tripped", {
      kind: trip.kind,
      agentId: trip.agentId,
      reason: trip.reason,
      delivered,
    });

    const agent = db.prepare("SELECT name FROM agents WHERE id = ?").get(trip.agentId) as any;
    const who = agent?.name ?? trip.agentId;
    log?.(`circuit breaker (${trip.kind}) on ${who}: ${trip.reason}${delivered ? "" : " — no live session"}`);
    postChat?.(
      trip.projectId,
      delivered
        ? `Circuit breaker: told ${who} to ${trip.kind === "constrain" ? "wrap up" : "stop repeating"} — ${trip.reason}.`
        : `Circuit breaker: ${who} ${trip.reason}, but has no live terminal to steer. Open it or pause the task.`
    );

    fired.push(trip);
  }

  return fired;
}
