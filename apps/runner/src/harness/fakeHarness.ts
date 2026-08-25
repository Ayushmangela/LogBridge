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
  const p = promptJson(prompt);
  return typeof p?.durationSeconds === "number" ? p.durationSeconds : Math.max(1, Math.min(maxSeconds - 1, 5));
}

// Same channel, for the question flow: {"askAfter": N} makes the worker ask
// a question N seconds in and wait on stdin for the answer.
function askAfterFromPrompt(prompt: string): number | null {
  const p = promptJson(prompt);
  return typeof p?.askAfter === "number" ? p.askAfter : null;
}

// The test control channel has to survive prompt decoration. withMemories()
// prepends recalled context and puts the real task under a "Task:" heading,
// so once a project has ANY memory the whole prompt stops being valid JSON —
// which silently reverted duration to the default and made `askAfter` never
// fire. Parse the task section, not the envelope around it.
function promptJson(prompt: string): any | null {
  // The prompt gets decorated from BOTH ends: withMemories() prepends recalled
  // context under a "Task:" heading, and the REMEMBER convention is appended
  // after it. Neither is JSON, so anything that requires the whole string (or
  // a whole suffix) to parse breaks the moment either is present — which has
  // now happened twice. Find the embedded object instead.
  const direct = tryParse(prompt);
  if (direct) return direct;

  const idx = prompt.lastIndexOf("\nTask:\n");
  const region = idx === -1 ? prompt : prompt.slice(idx + "\nTask:\n".length);

  const start = region.indexOf("{");
  if (start === -1) return null;
  // Scan outward for the matching brace rather than regexing, so a nested
  // object in the control payload doesn't truncate it.
  let depth = 0;
  for (let i = start; i < region.length; i++) {
    if (region[i] === "{") depth++;
    else if (region[i] === "}") {
      depth--;
      if (depth === 0) return tryParse(region.slice(start, i + 1));
    }
  }
  return null;
}

function tryParse(s: string): any | null {
  try {
    const v = JSON.parse(s.trim());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export const fakeHarness: AgentHarness = {
  name: "fake-worker",
  spawn(opts: SpawnOptions): AgentHandle {
    const workSeconds = workSecondsFromPrompt(opts.prompt, opts.maxSeconds);
    const askAfter = askAfterFromPrompt(opts.prompt);
    const child = spawn(process.execPath, [
      FAKE_WORKER,
      "--duration", String(workSeconds),
      ...(askAfter != null ? ["--ask-after", String(askAfter)] : []),
    ], {
      stdio: ["pipe", "pipe", "pipe"],
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
          } else if (parsed.question) {
            queue.push({ kind: "question", id: `q_${parsed.elapsed ?? 0}`, question: parsed.question });
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
      // The worker is blocked reading stdin while its question is pending —
      // the answer line is what unblocks it.
      answer: (text) => {
        try { child.stdin?.write(text + "\n"); } catch { /* already gone */ }
      },
    };
  },
};
