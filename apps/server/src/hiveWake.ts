// Waking an agent when a hive message is delivered to it.
//
// THE PROBLEM THIS SOLVES. The commander's prompt promises that dispatch
// "delivers these to recipient inboxes and wakes their terminals to code."
// Only the first half was true: `HiveManager.routeOnce()` moved JSON from
// outbox/ to inbox/ and nothing told the recipient. `hive.ts` contained zero
// occurrences of wake/notify/inject/sendToPty. Agents only ever discovered
// their mail when a human happened to open them — so in a recorded session
// all three agents woke, found empty inboxes, asked the human what to do, and
// the orchestrator did the work itself, which its own protocol forbids.
//
// THE MODEL. These agents are CLI processes, not services. `claude -p` runs a
// turn and exits; nothing sits in a loop checking a mailbox. So a message is
// not something an agent *receives* — a message is a REASON TO RUN an agent.
// There are exactly two ways to reach one:
//
//   inject — a PTY session is already live. Cheap, keeps its context.
//   spawn  — no session. Cold start; the message becomes the prompt.
//
// Everything here is choosing between those two and making sure exactly one
// happens exactly once.
import type { Db } from "./db.js";
import type { HiveMessage } from "./hive.js";
import { submitPromptToAgent } from "./ptyGateway.js";
import { isAlreadyDelivered } from "./hiveDelivery.js";

export type WakeOutcome = "injected" | "spawned" | "undeliverable" | "suppressed" | "duplicate";

export interface WakeResult {
  outcome: WakeOutcome;
  reason?: string;
}

/** Hot-path cache. The router re-scans directories every 1.5s and files
 *  persist, so without this one message would hit the DB on every tick.
 *  The authoritative dedup is the hive_deliveries table — this just avoids
 *  a round-trip for the common case. */
const wokenFor = new Set<string>();

const MAX_REMEMBERED = 5000;

function remember(id: string): void {
  wokenFor.add(id);
  if (wokenFor.size > MAX_REMEMBERED) {
    const oldest = wokenFor.values().next().value;
    if (oldest !== undefined) wokenFor.delete(oldest);
  }
}

/** Exposed for tests and for a clean restart. */
export function resetWakeMemory(): void {
  wokenFor.clear();
}

/**
 * The line a human sees in the room.
 *
 * `say` is written by the agent, because the personality is the product —
 * "i will look on it" is the thing being built. But it is NEVER
 * authoritative: the recipient acts on the typed fields, so a loosely worded
 * sentence can only ever produce a confusing line, never a wrong action.
 * Same split as a git commit — the message describes, the diff is.
 *
 * When an agent omits it we generate one rather than posting nothing. A
 * silent office is the exact failure this design exists to prevent.
 */
export function roomLineFor(msg: HiveMessage, fromName: string, toName: string): string {
  const said = typeof (msg as any).say === "string" ? (msg as any).say.trim() : "";
  if (said) return said.length > 280 ? said.slice(0, 277) + "…" : said;

  const subject = msg.subject?.trim();
  if (subject) return `${subject} (→ ${toName})`;
  return `${fromName} sent ${toName} a ${msg.act ?? "message"}`;
}

/** The short notice injected into a live session. Deliberately terse: the
 *  agent's protocol already tells it to read its inbox, so this only has to
 *  make it look now. */
export function injectionNoticeFor(msg: HiveMessage, fromName: string): string {
  const subject = msg.subject?.trim() || msg.act || "message";
  return `New hive message from ${fromName}: ${subject}. Read your inbox now and act on it.`;
}

export interface WakeDeps {
  db: Db;
  /** Inject into a live PTY. Returns false when no session exists. */
  inject?: (agentId: string, text: string) => boolean;
  /** Start the agent with this message as its prompt. */
  spawn?: (agentId: string, prompt: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * Wake the recipient of a delivered hive message.
 *
 * Order matters and is not arbitrary:
 *
 *  1. Duplicate check first — cheapest, and the router will call us again in
 *     1.5 seconds regardless.
 *  2. Offline check before either verb. D28: an agent on an offline machine is
 *     unreachable, and we record that rather than queueing a promise the
 *     system cannot keep. Silently dropping would be worse; so would spawning
 *     into nothing.
 *  3. Inject before spawn — always prefer keeping an agent's context over
 *     paying for a cold start.
 */
export function wakeRecipient(msg: HiveMessage, toId: string, deps: WakeDeps): WakeResult {
  const log = deps.log ?? (() => {});

  if (!msg?.id) return { outcome: "suppressed", reason: "message has no id" };

  // Two-layer dedup: in-memory cache first (no DB round-trip on every
  // 1.5-second router tick), then the durable table that survives restarts.
  if (wokenFor.has(msg.id)) return { outcome: "duplicate" };
  if (isAlreadyDelivered(deps.db, msg.id)) {
    remember(msg.id); // warm the cache so next tick skips the DB
    return { outcome: "duplicate" };
  }

  const agent = deps.db
    .prepare("SELECT a.id, a.name, a.machine_id, m.online FROM agents a LEFT JOIN machines m ON m.id = a.machine_id WHERE a.id = ?")
    .get(toId) as any;

  if (!agent) {
    // A message addressed to something that is not a registered agent. Not an
    // error worth throwing over — the router keeps running for everyone else.
    return { outcome: "suppressed", reason: `no such agent "${toId}"` };
  }

  // D28 — an agent is only reachable while its owner's machine is online.
  if (agent.machine_id && !agent.online) {
    remember(msg.id);
    log(`hive: ${agent.name} is on an offline machine — message ${msg.id} undeliverable`);
    return { outcome: "undeliverable", reason: "machine offline" };
  }

  const fromName = msg.from ?? "someone";

  if (deps.inject) {
    const injected = deps.inject(toId, injectionNoticeFor(msg, fromName));
    if (injected) {
      remember(msg.id);
      return { outcome: "injected" };
    }
  }

  if (deps.spawn) {
    // No live session: the message body becomes the prompt. This is what
    // "wakes their terminals to code" was always supposed to mean.
    const prompt = [msg.subject, msg.body].filter(Boolean).join("\n\n");
    const started = deps.spawn(toId, prompt);
    if (started) {
      remember(msg.id);
      return { outcome: "spawned" };
    }
    return { outcome: "suppressed", reason: "spawn refused" };
  }

  return { outcome: "suppressed", reason: "no wake mechanism available" };
}

/** The default injector, wired to the real PTY gateway. Split out so tests can
 *  substitute one without a terminal. */
export const defaultInject = (agentId: string, text: string): boolean =>
  submitPromptToAgent(agentId, text);
