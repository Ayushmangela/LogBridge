// Projects the append-only event log into "what just happened" lines.
//
// The wording lives here, server-side, for the same reason `zone` does
// (CONTRACT.md invariant 2): one place decides, and the UI cannot invent a
// story the log doesn't support. A browser that had to interpret raw event
// bodies would be free to describe an event however it liked.
import type { ActivityItemT } from "@logbridge/protocol";
import type { Db } from "./db.js";

// Excluded on purpose. These are either per-frame noise (position), a
// heartbeat (task.status), or a firehose of intra-task progress
// (task.event) — including them would bury the handful of things a person
// actually wants to notice.
const NOISE = new Set(["position", "task.status", "task.event"]);

function short(s: unknown, n = 70): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * Turn one event row into a line, or null to drop it.
 * `titleOf` resolves a task id to its title — passed in so this stays a
 * pure function of its inputs and is trivially testable.
 */
export function describeEvent(
  ev: { seq: number; type: string; task_id: string | null; body: string | null; ts: string },
  titleOf: (taskId: string | null) => string | null
): ActivityItemT | null {
  if (NOISE.has(ev.type)) return null;

  let body: any = {};
  try {
    body = ev.body ? JSON.parse(ev.body) : {};
  } catch {
    body = {};
  }

  const title = titleOf(ev.task_id);
  const base = { seq: ev.seq, type: ev.type, taskId: ev.task_id, ts: ev.ts };

  switch (ev.type) {
    case "task.assigned":
      return { ...base, actor: body.agentName ?? null, summary: `was assigned “${short(title ?? "a task")}”` };

    case "task.accept":
      return { ...base, actor: null, summary: `started “${short(title ?? "a task")}”` };

    case "task.result": {
      const ok = body.state === "completed";
      const why = body.reason ? ` — ${short(body.reason, 40)}` : "";
      return { ...base, actor: null, summary: `${ok ? "finished" : "failed"} “${short(title ?? "a task")}”${ok ? "" : why}` };
    }

    case "task.late_result":
      return { ...base, actor: null, summary: `reported “${short(title ?? "a task")}” late — it had already been marked failed` };

    case "task.result.rejected":
      return { ...base, actor: null, summary: `sent a result for “${short(title ?? "a task")}” that the state machine refused` };

    case "lease.expired":
      return { ...base, actor: null, summary: `went silent during “${short(title ?? "a task")}” — the lease expired` };

    case "task.cancel":
      return { ...base, actor: null, summary: `cancelled “${short(title ?? "a task")}”${body.reason ? ` — ${short(body.reason, 40)}` : ""}` };

    case "task.edit":
      return { ...base, actor: body.by ?? "You", summary: `revised “${short(body.from, 40)}” → “${short(body.to, 40)}”` };

    case "task.edit.refused":
      return { ...base, actor: null, summary: `an edit arrived too late for “${short(title ?? "a task")}” — ${short(body.reason, 50)}` };

    case "memory.write":
      return { ...base, actor: body.agentName ?? null, summary: `learned: ${short(body.text, 60)}` };

    case "memory.write.duplicate":
      return null; // re-learning a known fact isn't news

    case "human.answer":
      return { ...base, actor: "You", summary: `${body.choice === "approve" ? "approved" : body.choice ?? "answered"} a proposed task` };

    case "chat": {
      if (body?.ask) return { ...base, actor: body.from?.name ?? null, summary: `proposed “${short(body.ask ? title ?? body.text : body.text, 55)}”` };
      return { ...base, actor: body.from?.name ?? null, summary: short(body.text, 70) };
    }

    case "delegate.request":
      return { ...base, actor: body.from ?? null, summary: `delegated ${short(body.capability, 40)} to another machine` };

    case "delegate.result":
      return { ...base, actor: body.from ?? null, summary: `returned a delegated ${short(body.capability ?? "task", 40)} — ${body.state ?? "done"}` };

    case "delegate.request.undeliverable":
    case "delegate.result.undeliverable":
      return { ...base, actor: null, summary: `could not deliver a cross-machine message — ${short(body.reason, 40)}` };

    case "github.push": {
      const n = Number(body.count ?? 1);
      // "pushed a commit" reads better than "pushed 1 commits", and the
      // headline is worth more than the count when there's only one.
      const what = n === 1 ? "pushed a commit" : `pushed ${n} commits`;
      const head = body.headline ? ` — ${short(body.headline, 50)}` : "";
      return { ...base, actor: body.author ?? null, summary: `${what} to ${short(body.repo, 30)}${head}` };
    }

    case "github.pull":
      return { ...base, actor: body.author ?? null, summary: `${body.verb} “${short(body.title, 50)}” (${body.repo}#${body.number})` };

    case "github.ci_failed":
      return { ...base, actor: null, summary: `CI went red on ${body.repo}#${body.number} — ${short(body.title, 45)}` };

    case "github.ci_passed":
      return { ...base, actor: null, summary: `CI green on ${body.repo}#${body.number}` };

    case "github.issue_task":
      return { ...base, actor: body.author ?? null, summary: `opened an issue that became queued work: ${short(body.title, 50)}` };

    case "github.issue_closed":
      return { ...base, actor: null, summary: `${body.repo}#${body.number} closed upstream — its work item was retired` };

    case "github.room_linked":
      return { ...base, actor: null, summary: `linked repository ${short(body.repo, 50)} to this room` };

    default:
      // Unknown types still show up rather than vanishing: a silent feed
      // during a new feature is worse than an ugly line.
      return { ...base, actor: null, summary: ev.type.replace(/\./g, " ") };
  }
}

/** The most recent activity in a project, newest first. */
export function recentActivity(db: Db, projectId: string, limit = 30): ActivityItemT[] {
  // Over-fetch, because filtering happens after the query — a burst of
  // position events would otherwise return an empty feed.
  const rows = db
    .prepare(
      `SELECT seq, type, task_id, body, ts FROM events
       WHERE project_id = ? AND type NOT IN ('position','task.status','task.event')
       ORDER BY seq DESC LIMIT ?`
    )
    .all(projectId, limit * 3) as any[];

  const titles = new Map<string, string>();
  const titleOf = (taskId: string | null) => {
    if (!taskId) return null;
    if (!titles.has(taskId)) {
      const row = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as any;
      titles.set(taskId, row?.title ?? "");
    }
    return titles.get(taskId) || null;
  };

  const out: ActivityItemT[] = [];
  for (const r of rows) {
    const item = describeEvent(r, titleOf);
    if (item) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
