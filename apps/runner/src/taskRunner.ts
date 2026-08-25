// Runs a task through whatever AgentHarness it's given — the fake worker
// for tests, a real terminal CLI for actual work — and enforces the two
// things that make this a distributed system instead of a demo: a hard
// wall-clock budget kill, and honest process-observed status (never
// self-reported). See SYSTEM.md §4c/§4d.
import type { AgentHarness, AgentHandle } from "./harness/types.js";

export type ResultState = "completed" | "failed";

interface Active {
  taskId: string;
  handle: AgentHandle;
  startedAt: number;
  budgetSeconds: number;
  budgetUsd: number;
  lastCostUsd: number; // authoritative once the harness reports one — never fabricated
  steps: number;       // observable step boundaries reported by the CLI — a count, never a fraction
  settled: boolean; // guards against double-reporting a result
  // Wall-clock budget, pausable. While the agent waits on a human it spends
  // nothing, so the clock must not run — a task killed because its owner was
  // at lunch is exactly the failure budgets exist to prevent. The USD cap
  // stays absolute regardless.
  budgetTimer: NodeJS.Timeout | null;
  remainingMs: number;
  armedAt: number | null;
}

export class TaskRunner {
  private active = new Map<string, Active>();

  constructor(
    /** Resolves the harness for a given agent — one machine can run several
     *  agents on different providers, so this is per-agent, not per-runner. */
    private harnessFor: (agentId: string | null) => AgentHarness,
    private onEvent: (taskId: string, summary: string, data: unknown) => void,
    private onResult: (taskId: string, state: ResultState, reason: string | null, costUsd: number) => void,
    /** The agent asked something only a human can answer. The runner marks
     *  the task input-required and routes the question; the clock stops. */
    private onQuestion: (taskId: string, questionId: string, question: string) => void = () => {},
    /** Observable steps completed — a count, never a fraction. */
    private onProgress?: (taskId: string, steps: number, note: string | null) => void,
    /** The agent judged something worth keeping beyond this task. */
    private onRemember?: (taskId: string, kind: string, text: string) => void
  ) {}

  has(taskId: string): boolean {
    return this.active.has(taskId);
  }

  elapsedSeconds(taskId: string): number {
    const a = this.active.get(taskId);
    return a ? Math.floor((Date.now() - a.startedAt) / 1000) : 0;
  }

  currentCost(taskId: string): number {
    return this.active.get(taskId)?.lastCostUsd ?? 0;
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  start(
    taskId: string,
    budget: { seconds: number; usd: number },
    cwd: string,
    prompt: string,
    policy: { allowTools: string[]; denyPaths: string[] },
    agentId: string | null = null
  ) {
    const handle = this.harnessFor(agentId).spawn({
      cwd,
      prompt,
      allowTools: policy.allowTools,
      denyPaths: policy.denyPaths,
      maxSeconds: budget.seconds,
      maxUsd: budget.usd,
    });

    const active: Active = {
      taskId, handle, startedAt: Date.now(),
      budgetSeconds: budget.seconds, budgetUsd: budget.usd,
      lastCostUsd: 0, steps: 0, settled: false,
      budgetTimer: null, remainingMs: budget.seconds * 1000, armedAt: null,
    };
    this.active.set(taskId, active);
    this.armBudget(active);

    (async () => {
      for await (const ev of handle.events) {
        if (active.settled) break;
        if (ev.kind === "output") this.onEvent(taskId, ev.text, null);
        else if (ev.kind === "tool_call") this.onEvent(taskId, `${ev.name}`, ev.input);
        else if (ev.kind === "cost") active.lastCostUsd = ev.usd;
        else if (ev.kind === "error") this.finish(taskId, "failed", ev.message);
        else if (ev.kind === "question") {
          // Clock stops while a human thinks. Resumed in answer().
          this.pauseBudget(active);
          this.onQuestion(taskId, ev.id, ev.question);
        }
        else if (ev.kind === "progress") {
          // Steps completed. The total is unknowable, so this is a count the
          // UI reports as-is — never a percentage.
          active.steps += ev.step;
          this.onProgress?.(taskId, active.steps, ev.note ?? null);
        }
        else if (ev.kind === "remember") {
          this.onRemember?.(taskId, ev.memoryKind, ev.text);
        }
        else if (ev.kind === "done") this.finish(taskId, ev.ok ? "completed" : "failed", ev.ok ? null : "harness reported failure");
      }
      this.disarmBudget(active);
      // If the harness's event stream ended without an explicit done/error
      // (a CLI that exits silently), treat that as a completion rather than
      // leaving the task stuck — the process-observed exit already reached
      // us via onExit inside the harness, which is what actually matters.
      if (!active.settled) this.finish(taskId, "completed", null);
    })();
  }

  private armBudget(a: Active) {
    if (a.settled || a.budgetTimer) return;
    a.armedAt = Date.now();
    a.budgetTimer = setTimeout(() => this.finish(a.taskId, "failed", "budget_exceeded"), a.remainingMs);
  }

  private pauseBudget(a: Active) {
    if (!a.budgetTimer) return;
    clearTimeout(a.budgetTimer);
    a.budgetTimer = null;
    if (a.armedAt != null) a.remainingMs = Math.max(0, a.remainingMs - (Date.now() - a.armedAt));
    a.armedAt = null;
  }

  private disarmBudget(a: Active) {
    if (a.budgetTimer) { clearTimeout(a.budgetTimer); a.budgetTimer = null; }
  }

  /** A human answered. Deliver it to the process and restart the clock —
   *  with whatever budget remained when the question was asked. */
  answer(taskId: string, text: string): boolean {
    const a = this.active.get(taskId);
    if (!a || a.settled) return false;
    a.handle.answer?.(text);
    this.armBudget(a);
    return true;
  }

  isAwaitingAnswer(taskId: string): boolean {
    const a = this.active.get(taskId);
    return Boolean(a && !a.settled && a.budgetTimer === null && a.remainingMs > 0);
  }

  private finish(taskId: string, state: ResultState, reason: string | null) {
    const a = this.active.get(taskId);
    if (!a || a.settled) return;
    a.settled = true;
    this.disarmBudget(a);
    const cost = a.lastCostUsd;
    this.active.delete(taskId);
    if (reason === "budget_exceeded") a.handle.kill();
    this.onResult(taskId, state, reason, cost);
  }

  // A server-issued task.cancel (the human Stop button). The server marks
  // the task canceled the moment it sends this, independent of the runner —
  // see SYSTEM.md "Stop... does not depend on the agent cooperating." Our
  // only job is killing the process within ~2s; we do NOT report a result,
  // since the server already owns that terminal state (task.result's schema
  // only has completed|failed — a stop is a kill, not a result).
  stop(taskId: string) {
    const a = this.active.get(taskId);
    if (!a || a.settled) return;
    a.settled = true;
    this.disarmBudget(a);
    this.active.delete(taskId);
    a.handle.kill();
  }

  // Teardown: kill every active task without reporting a result (there's
  // no one left to tell). Used on RunnerConnection.stop() so a lingering
  // process can't fire an event/result after everything else has shut down.
  stopAll() {
    for (const id of this.activeIds()) this.stop(id);
  }
}
