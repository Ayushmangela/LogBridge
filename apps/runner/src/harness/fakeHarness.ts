// The controllable fake worker, wearing the real AgentHarness interface.
// This is what the Wi-Fi-drop test exercises — proving the mechanics
// (leases, reconnect, budget-kill) without needing a real model call.
// See SYSTEM.md §3e.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentHarness, AgentHandle, SpawnOptions, AgentEvent } from "./types.js";
import { AsyncEventQueue } from "./asyncQueue.js";

const FAKE_WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "fakeWorker.mjs");
const FAKE_COST_PER_SECOND = 0.01;

// Test-only control channel: if the prompt is `{"durationSeconds": N}` JSON,
// use that; otherwise (a real task title/spec in prompt form) default short.
// A real harness never does this — it just sends the prompt to a real CLI.
function workSecondsFromPrompt(prompt: string, maxSeconds: number): number {
  try {
    const parsed = JSON.parse(prompt);
    if (typeof parsed.durationSeconds === "number") return parsed.durationSeconds;
  } catch {
    /* not JSON — a real prompt string */
  }
  return Math.max(1, Math.min(maxSeconds - 1, 5));
}

export const fakeHarness: AgentHarness = {
  name: "fake-worker",
  spawn(opts: SpawnOptions): AgentHandle {
    const workSeconds = workSecondsFromPrompt(opts.prompt, opts.maxSeconds);
    const child = spawn(process.execPath, [FAKE_WORKER, "--duration", String(workSeconds)], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    const queue = new AsyncEventQueue<AgentEvent>();
    let buf = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.done) {
            queue.push({ kind: "done", ok: true });
          } else {
            queue.push({ kind: "output", text: parsed.note ?? line });
            queue.push({ kind: "cost", usd: Number(((parsed.elapsed ?? 0) * FAKE_COST_PER_SECOND).toFixed(4)) });
          }
        } catch {
          queue.push({ kind: "output", text: line });
        }
      }
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) queue.push({ kind: "error", message: `exit code=${code} signal=${signal ?? "none"}` });
      queue.close();
    });

    return {
      events: queue,
      interrupt: () => child.kill("SIGTERM"),
      kill: () => {
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000);
        queue.close();
      },
    };
  },
};
