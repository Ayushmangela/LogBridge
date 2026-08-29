import type { Db } from "../db.js";
import { createTask, appendEvent } from "../db.js";
import { parsePlan } from "../plan.js";

/**
 * Turn a finished planning task into a proposal in the room.
 *
 * The agent's words arrive as task.event rows, so the plan is reassembled
 * from the log — no extra protocol, and it survives a reconnect because the
 * log does. Nothing is created until a human approves: a bad decomposition
 * silently spawning six tasks is worse than no planning at all.
 */
export function proposePlanFromOutput(db: Db, task: any, onChat?: (c: any) => void) {
  const rows = db
    .prepare("SELECT body FROM events WHERE task_id = ? AND type = 'task.event' ORDER BY seq")
    .all(task.id) as any[];
  const output = rows
    .map((r) => { try { return JSON.parse(r.body)?.summary ?? ""; } catch { return ""; } })
    .join("\n");

  const tasks = parsePlan(output);
  const planId = `pln_${crypto.randomUUID()}`;
  appendEvent(db, task.project_id, task.id, "plan.proposed", { planId, tasks, goal: task.title });

  const say = (text: string, ask: any = null) => {
    const chat = {
      id: crypto.randomUUID(), roomId: task.project_id,
      from: { kind: "agent", id: "system", name: "office" },
      text, ts: new Date().toISOString(), ask,
    };
    appendEvent(db, task.project_id, task.id, "chat", chat);
    onChat?.(chat);
  };

  if (tasks.length === 0) {
    say(`I couldn't turn “${task.title.replace(/^Plan: /, "")}” into tasks — the agent didn't return a usable list. Try rewording the goal.`);
    return;
  }

  const list = tasks
    .map((t, i) => `${i + 1}. ${t.title}${t.capability ? `  (${t.capability})` : ""}`)
    .join("\n");
  say(
    `Plan for “${task.title.replace(/^Plan: /, "")}” — ${tasks.length} tasks:\n\n${list}\n\nCreate them?`,
    { taskId: planId, options: ["approve", "reject"] }
  );
}

/** Create the tasks a plan proposed. Returns how many were created. */
export function acceptPlan(db: Db, planId: string): number {
  const row = db
    .prepare("SELECT project_id, body FROM events WHERE type = 'plan.proposed' ORDER BY seq DESC")
    .all()
    .map((r: any) => ({ projectId: r.project_id, body: JSON.parse(r.body) }))
    .find((r: any) => r.body?.planId === planId);
  if (!row) return 0;

  const already = db
    .prepare("SELECT body FROM events WHERE type = 'plan.accepted'")
    .all()
    .some((r: any) => { try { return JSON.parse(r.body)?.planId === planId; } catch { return false; } });
  if (already) return 0;

  let created = 0;
  for (const t of row.body.tasks ?? []) {
    createTask(db, {
      projectId: row.projectId,
      title: t.title,
      creatorId: "plan",
      agentId: null,
      requiredCapability: t.capability ?? null,
    });
    created++;
  }
  appendEvent(db, row.projectId, null, "plan.accepted", { planId, created });
  return created;
}
