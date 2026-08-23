// Runs the fake worker as a real child process and enforces the two things
// that make this a distributed system instead of a demo: a hard wall-clock
// budget kill, and honest process-observed status (never self-reported).
// See SYSTEM.md §4c/§4d.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FAKE_WORKER = join(dirname(fileURLToPath(import.meta.url)), "fakeWorker.mjs");
const FAKE_COST_PER_SECOND = 0.01; // simulated spend, for the budget_usd check

export type ResultState = "completed" | "failed";

interface Active {
  taskId: string;
  child: ChildProcess;
  startedAt: number;
  budgetSeconds: number;
  budgetUsd: number;
  settled: boolean; // guards against double-reporting a result
}

export class TaskRunner {
  private active = new Map<string, Active>();

  constructor(
    private onEvent: (taskId: string, summary: string, data: unknown) => void,
    private onResult: (taskId: string, state: ResultState, reason: string | null, costUsd: number) => void
  ) {}

  has(taskId: string): boolean {
    return this.active.has(taskId);
  }

  elapsedSeconds(taskId: string): number {
    const a = this.active.get(taskId);
    return a ? Math.floor((Date.now() - a.startedAt) / 1000) : 0;
  }

  currentCost(taskId: string): number {
    return Number((this.elapsedSeconds(taskId) * FAKE_COST_PER_SECOND).toFixed(4));
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  // Teardown: kill every active child without reporting a result (there's
  // no one left to tell). Used on RunnerConnection.stop() so a lingering
  // process can't fire an event/result after everything else has shut down.
  stopAll() {
    for (const id of this.activeIds()) this.stop(id);
  }

  // `workSeconds` is how long the fake work item itself takes — deliberately
  // independent of `budget`. If workSeconds exceeds budget.seconds, the
  // budget timer kills it first; that's the case the budget-cap test exercises.
  start(taskId: string, budget: { seconds: number; usd: number }, workSeconds = 5) {
    const args = [FAKE_WORKER, "--duration", String(workSeconds)];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    const active: Active = { taskId, child, startedAt: Date.now(), budgetSeconds: budget.seconds, budgetUsd: budget.usd, settled: false };
    this.active.set(taskId, active);

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      // Signal delivery is async: kill() can return before the process
      // actually dies, and already-buffered stdout still flushes through
      // in the meantime. Once settled, this task is done reporting — full
      // stop, or a trailing chunk after teardown tries to write to state
      // that may no longer exist.
      if (active.settled) return;
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (!parsed.done) this.onEvent(taskId, parsed.note ?? "progress", parsed);
        } catch {
          this.onEvent(taskId, line, null);
        }
      }
    });

    child.on("exit", (code, signal) => {
      if (active.settled) return; // already reported (budget kill / stop)
      active.settled = true;
      const cost = this.currentCost(taskId);
      this.active.delete(taskId);
      if (code === 0) this.onResult(taskId, "completed", null, cost);
      else this.onResult(taskId, "failed", `exit code=${code} signal=${signal ?? "none"}`, cost);
    });

    // Hard budget wall-clock kill — non-negotiable. See PLAN.md D-risk #1.
    const budgetTimer = setTimeout(() => {
      if (active.settled) return;
      active.settled = true;
      const cost = this.currentCost(taskId);
      this.active.delete(taskId);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
      this.onResult(taskId, "failed", "budget_exceeded", cost);
    }, budget.seconds * 1000);
    child.on("exit", () => clearTimeout(budgetTimer));
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
    this.active.delete(taskId);
    a.child.kill("SIGTERM");
    setTimeout(() => {
      if (!a.child.killed) a.child.kill("SIGKILL");
    }, 2000);
  }
}
