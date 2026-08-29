// Phase 1 — delivery guarantees for hive messages.
//
// THE LIFECYCLE. A message starts as "delivered" when wakeRecipient()
// succeeds (Phase 0). It becomes "handled" when the agent moves its file
// from inbox/ to inbox/.done/ — the protocol's existing ack. If the agent
// never does that, a timeout fires and redelivers (up to N times). After N
// failures the message is dead-lettered: moved to a dead-letter/ directory,
// recorded, and surfaced in the office so the human can see it.
//
// WHY A TABLE, NOT THE IN-MEMORY SET. Phase 0's `wokenFor` Set works within
// a single process lifetime. A server restart zeroes it, which means a
// message whose agent crashed is retried from attempt 0 — exactly the
// redelivery storm the brief warns about. The table survives restarts.
//
// WHY NOT mtime. The brief says "do not use file mtime for timeouts; a synced
// folder or a restore will lie to you." So we record an explicit delivered_at.

import type { Db } from "./db.js";
import type { HiveMessage } from "./hive.js";
import type { WakeResult, WakeDeps } from "./hiveWake.js";
import { wakeRecipient } from "./hiveWake.js";
import { appendEvent } from "./db.js";
import { existsSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Configuration ────────────────────────────────────────────────────

/** How long to wait before considering a delivery stale. Agents doing real
 *  work can take many minutes; the failure this guards against is "the agent
 *  died", not "the agent is slow". */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** How many times to redeliver before dead-lettering. */
export const DEFAULT_MAX_ATTEMPTS = 3;

// ── Types ────────────────────────────────────────────────────────────

export type DeliveryState = "delivered" | "handled" | "dead";

export interface HiveDelivery {
  messageId: string;
  toAgentId: string;
  fromAgentId: string | null;
  projectId: string | null;
  subject: string | null;
  bodyPreview: string | null;
  deliveredAt: string;
  handledAt: string | null;
  deadAt: string | null;
  attempts: number;
  lastWakeOutcome: string | null;
  lastAttemptAt: string;
  state: DeliveryState;
}

// ── Recording a delivery ─────────────────────────────────────────────

/** Called after wakeRecipient() succeeds. Creates the durable delivery
 *  record that replaces the in-memory wokenFor Set. */
export function recordDelivery(
  db: Db,
  msg: HiveMessage,
  toId: string,
  projectId: string | null,
  outcome: WakeResult
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hive_deliveries
       (message_id, to_agent_id, from_agent_id, project_id, subject, body_preview,
        delivered_at, last_wake_outcome, last_attempt_at, attempts, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'delivered')
     ON CONFLICT (message_id) DO NOTHING`
  ).run(
    msg.id,
    toId,
    msg.from ?? null,
    projectId,
    msg.subject ?? null,
    (msg.body ?? "").slice(0, 200) || null,
    now,
    outcome.outcome,
    now
  );
}

// ── Dedup check (replaces in-memory Set) ─────────────────────────────

/** Returns true if this message has already been delivered (or handled, or
 *  dead-lettered). Used by wakeRecipient for dedup instead of the old
 *  in-memory Set. */
export function isAlreadyDelivered(db: Db, messageId: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM hive_deliveries WHERE message_id = ?"
  ).get(messageId);
  return row !== undefined;
}

// ── Ack scanning ─────────────────────────────────────────────────────

/** Scans each agent's inbox/.done/ for message files that match a row in
 *  hive_deliveries still in "delivered" state. When found, marks them as
 *  "handled" — the agent did its job. */
export function checkForAcks(db: Db, hiveRoots: string[]): number {
  let acked = 0;

  // All message_ids currently in "delivered" state
  const pending = db.prepare(
    "SELECT message_id, to_agent_id FROM hive_deliveries WHERE state = 'delivered'"
  ).all() as { message_id: string; to_agent_id: string }[];

  if (pending.length === 0) return 0;

  // Index by message_id for O(1) lookup
  const pendingIds = new Set(pending.map((r) => r.message_id));

  for (const root of hiveRoots) {
    const agentsDir = join(root, "agents");
    if (!existsSync(agentsDir)) continue;

    let agentFolders: string[];
    try {
      agentFolders = readdirSync(agentsDir);
    } catch {
      continue;
    }

    for (const agentId of agentFolders) {
      const doneDir = join(agentsDir, agentId, "inbox", ".done");
      if (!existsSync(doneDir)) continue;

      let files: string[];
      try {
        files = readdirSync(doneDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }

      for (const file of files) {
        // The filename is typically <message_id>.json
        const msgId = file.replace(/\.json$/, "");
        if (pendingIds.has(msgId)) {
          const now = new Date().toISOString();
          db.prepare(
            "UPDATE hive_deliveries SET state = 'handled', handled_at = ? WHERE message_id = ? AND state = 'delivered'"
          ).run(now, msgId);
          pendingIds.delete(msgId);
          acked++;
        }
      }
    }
  }

  return acked;
}

// ── Timeout + redelivery ─────────────────────────────────────────────

export interface SweepDeps extends WakeDeps {
  hiveRoots: string[];
  timeoutMs?: number;
  maxAttempts?: number;
  now?: Date;
  emitEvent?: (projectId: string, msgId: string, type: string, body: unknown) => void;
  postChat?: (projectId: string, text: string) => void;
}

export interface SweepResult {
  redelivered: number;
  deadLettered: number;
}

/** Finds messages stuck in "delivered" past the timeout. Redelivers or
 *  dead-letters based on attempt count. Skips agents currently working —
 *  the brief says not to interrupt them. */
export function sweepDeliveries(deps: SweepDeps): SweepResult {
  const { db, hiveRoots, now: nowDate } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = nowDate ?? new Date();
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();

  const result: SweepResult = { redelivered: 0, deadLettered: 0 };

  // Find stale deliveries
  const stale = db.prepare(
    `SELECT * FROM hive_deliveries
     WHERE state = 'delivered' AND last_attempt_at < ?
     ORDER BY last_attempt_at ASC`
  ).all(cutoff) as any[];

  for (const row of stale) {
    // Check if agent is currently working — don't interrupt
    const agent = db.prepare(
      "SELECT status FROM agents WHERE id = ?"
    ).get(row.to_agent_id) as { status: string } | undefined;

    if (agent?.status === "working") {
      // The agent is mid-task. The brief says: "Do not redeliver while the
      // agent is working — check status first." Skip and let the next sweep
      // pick it up (the timeout will have grown, but that is better than
      // doubling work).
      continue;
    }

    if (row.attempts >= maxAttempts) {
      // Dead-letter: this message has been tried enough times.
      deadLetterMessage(db, row, hiveRoots, deps);
      result.deadLettered++;
    } else {
      // Redeliver: bump attempt count and wake again.
      redeliverMessage(db, row, deps, now);
      result.redelivered++;
    }
  }

  return result;
}

/** Redeliver a stale message by waking the agent again. */
function redeliverMessage(
  db: Db,
  row: any,
  deps: SweepDeps,
  now: Date
): void {
  const msg: HiveMessage = {
    id: row.message_id,
    from: row.from_agent_id ?? "unknown",
    to: row.to_agent_id,
    act: "request",
    subject: row.subject ?? "Redelivered message",
    body: row.body_preview ?? "",
    conversation: "",
    in_reply_to: null,
    hops: 0,
    requires_reply: false,
    needs_human: false,
    created_at: row.delivered_at,
  };

  const wake = wakeRecipient(msg, row.to_agent_id, deps);
  const nowIso = now.toISOString();

  db.prepare(
    `UPDATE hive_deliveries
     SET attempts = attempts + 1, last_attempt_at = ?, last_wake_outcome = ?
     WHERE message_id = ?`
  ).run(nowIso, wake.outcome, row.message_id);

  deps.log?.(`hive-delivery: redelivered ${row.message_id} to ${row.to_agent_id} (attempt ${row.attempts + 1}, outcome: ${wake.outcome})`);
}

/** Move a message to dead-letter: it has been tried enough. */
function deadLetterMessage(
  db: Db,
  row: any,
  hiveRoots: string[],
  deps: SweepDeps
): void {
  const nowIso = new Date().toISOString();

  // Update DB state
  db.prepare(
    `UPDATE hive_deliveries SET state = 'dead', dead_at = ? WHERE message_id = ?`
  ).run(nowIso, row.message_id);

  // Move file on disk to dead-letter/ directory if it still exists in inbox
  for (const root of hiveRoots) {
    const inboxDir = join(root, "agents", row.to_agent_id, "inbox");
    const filePath = join(inboxDir, `${row.message_id}.json`);
    if (existsSync(filePath)) {
      const deadDir = join(inboxDir, "dead-letter");
      mkdirSync(deadDir, { recursive: true });
      try {
        renameSync(filePath, join(deadDir, `${row.message_id}.json`));
      } catch {
        // File disappeared between check and rename — ack race. The brief
        // says: "Handle a missing file as 'handled', not as an error."
      }
    }
  }

  // Emit event so the office can show it
  const projectId = row.project_id ?? "prj_main";
  deps.emitEvent?.(projectId, row.message_id, "hive_message.dead_lettered", {
    messageId: row.message_id,
    toAgentId: row.to_agent_id,
    fromAgentId: row.from_agent_id,
    subject: row.subject,
    attempts: row.attempts,
  });

  // Post to chat so the human sees it
  deps.postChat?.(projectId,
    `⚠️ Dead-lettered: message "${row.subject ?? row.message_id}" to ${row.to_agent_id} failed after ${row.attempts} attempts`
  );

  deps.log?.(`hive-delivery: dead-lettered ${row.message_id} to ${row.to_agent_id} after ${row.attempts} attempts`);
}

// ── Query helpers ────────────────────────────────────────────────────

export function getDeliveries(
  db: Db,
  opts?: { agentId?: string; state?: DeliveryState }
): HiveDelivery[] {
  let sql = "SELECT * FROM hive_deliveries WHERE 1=1";
  const params: any[] = [];

  if (opts?.agentId) {
    sql += " AND to_agent_id = ?";
    params.push(opts.agentId);
  }
  if (opts?.state) {
    sql += " AND state = ?";
    params.push(opts.state);
  }
  sql += " ORDER BY delivered_at DESC";

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    messageId: r.message_id,
    toAgentId: r.to_agent_id,
    fromAgentId: r.from_agent_id,
    projectId: r.project_id,
    subject: r.subject,
    bodyPreview: r.body_preview,
    deliveredAt: r.delivered_at,
    handledAt: r.handled_at,
    deadAt: r.dead_at,
    attempts: r.attempts,
    lastWakeOutcome: r.last_wake_outcome,
    lastAttemptAt: r.last_attempt_at,
    state: r.state as DeliveryState,
  }));
}

/** Count deliveries by state — for the metrics endpoint. */
export function deliveryCounts(db: Db): Record<DeliveryState, number> {
  const rows = db.prepare(
    "SELECT state, COUNT(*) as c FROM hive_deliveries GROUP BY state"
  ).all() as { state: string; c: number }[];
  const counts: Record<string, number> = { delivered: 0, handled: 0, dead: 0 };
  for (const r of rows) counts[r.state] = r.c;
  return counts as Record<DeliveryState, number>;
}
