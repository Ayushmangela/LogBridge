// Real agent execution: spawn the CLI the machine's owner already has
// installed and authenticated (claude / codex / gemini / ...) as a real
// pseudo-terminal process, rather than talking to a raw API key. This is
// what makes "each agent's model API key comes from its own owner's node"
// true without needing a second, separate credential.
//
// VERIFICATION STATUS (was a stated gap, now partly closed):
//   ✓ flags `-p` and `--output-format stream-json` confirmed against a real
//     claude 2.1.241 install
//   ✓ output shape confirmed and the parser corrected to match — see
//     emitLine's comment for what the earlier guess got wrong, and
//     test-support/claude-stream-json.sample.jsonl for the real capture
//   ✗ NOT yet run against an *authenticated* CLI: the sample was produced
//     by an install with apiKeySource "none", so the only result line seen
//     is the auth-failure one. tool_use blocks in particular are handled
//     from the documented content-block shape, not from an observation.
// Run `claude /login` and repeat the capture to close the rest.
import * as pty from "node-pty";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHarness, AgentHandle, SpawnOptions, AgentEvent } from "./types.js";
import { AsyncEventQueue } from "./asyncQueue.js";

export interface PtyHarnessConfig {
  command?: string; // default "claude"
  buildArgs?: (prompt: string) => string[];
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function defaultArgs(prompt: string): string[] {
  // Claude Code headless/print mode: run once, no REPL, structured events.
  return ["-p", prompt, "--output-format", "stream-json"];
}

// Enforcement for a PTY-wrapped CLI can't hook individual tool calls the
// way the SDK's canUseTool callback can (see DECISIONS.md D24) — so policy
// is expressed the way the CLI itself understands it: a project-scoped
// settings file, written fresh before every spawn from the *current*
// allowTools/denyPaths, never trusted to already be correct on disk.
function writeScopedSettings(cwd: string, allowTools: string[], denyPaths: string[]) {
  const dir = join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  const settings = {
    permissions: {
      allow: allowTools.map((t) => `${t}(*)`),
      deny: denyPaths.map((p) => `Read(${p})`).concat(denyPaths.map((p) => `Write(${p})`)),
    },
  };
  writeFileSync(join(dir, "settings.local.json"), JSON.stringify(settings, null, 2));
}

export function makePtyHarness(config: PtyHarnessConfig = {}): AgentHarness {
  const command = config.command ?? process.env.AGENT_CLI_COMMAND ?? "claude";
  const buildArgs = config.buildArgs ?? defaultArgs;

  return {
    name: `pty:${command}`,
    spawn(opts: SpawnOptions): AgentHandle {
      writeScopedSettings(opts.cwd, opts.allowTools, opts.denyPaths);

      const queue = new AsyncEventQueue<AgentEvent>();
      let settled = false;
      let proc: pty.IPty;

      try {
        proc = pty.spawn(command, buildArgs(opts.prompt), {
          name: "xterm-color",
          cols: 120,
          rows: 30,
          cwd: opts.cwd,
          env: process.env as Record<string, string>,
        });
      } catch (err) {
        // e.g. the binary genuinely isn't installed on this machine
        queue.push({ kind: "error", message: `failed to spawn ${command}: ${(err as Error).message}` });
        queue.close();
        return { events: queue, interrupt: () => {}, kill: () => {} };
      }

      let buf = "";
      // The CLI's own `result` line is the authoritative outcome — it knows
      // whether the run actually succeeded, including the API errors that
      // still exit 0. Process exit is only the fallback for a CLI that dies
      // without one. Without this flag both fire and a run reports twice.
      let sawResult = false;
      const scan = (line: string) => {
        if (line.includes('"type":"result"')) sawResult = true;
        emitLine(queue, line);
      };

      proc.onData((chunk: string) => {
        if (settled) return;
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.replace(ANSI_ESCAPE, "").trim();
          if (!line) continue;
          scan(line);
        }
      });

      proc.onExit(({ exitCode, signal }) => {
        if (settled) return;
        settled = true;
        if (buf.trim()) scan(buf.replace(ANSI_ESCAPE, "").trim());
        if (!sawResult) {
          // Died without reporting — killed, crashed, or interrupted.
          if (exitCode !== 0) {
            queue.push({ kind: "error", message: `${command} exited code=${exitCode} signal=${signal ?? "none"}` });
          } else {
            queue.push({ kind: "done", ok: true });
          }
        }
        queue.close();
      });

      return {
        events: queue,
        interrupt: () => {
          try {
            proc.write("\x03"); // Ctrl-C into the pty — a real interactive interrupt
          } catch {
            /* process may already be gone */
          }
        },
        kill: () => {
          settled = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            /* already dead */
          }
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* already dead */
            }
          }, 2000);
          queue.close();
        },
      };
    },
  };
}

// Parses Claude Code's `--output-format stream-json`, verified against real
// output from claude 2.1.241 (captured in test-support/claude-stream-json.
// sample.jsonl). The earlier version of this function guessed the shape and
// guessed wrong in two of three cases:
//
//   - text is at message.content[].text, NOT a top-level `text` field
//   - tool calls are content blocks {type:"tool_use", name, input} inside
//     that same array, NOT a top-level `tool_name`
//   - total_cost_usd on the final `result` line was the one correct guess
//
// Line types actually observed: system/init, assistant, result.
export function emitLine(queue: AsyncEventQueue<AgentEvent>, line: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON at all — a banner, a warning, an ANSI-stripped fragment.
    // Surface it rather than dropping it; losing a CLI's error text is how
    // "it just did nothing" bugs happen.
    queue.push({ kind: "output", text: line });
    return;
  }

  switch (parsed.type) {
    case "system":
      return; // init/metadata — nothing an operator needs to see

    case "assistant":
    case "user": {
      const content = parsed.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          if (block.text.trim()) queue.push({ kind: "output", text: block.text });
        } else if (block?.type === "tool_use") {
          queue.push({ kind: "tool_call", name: block.name ?? "unknown", input: block.input ?? null });
        }
        // tool_result blocks are the CLI feeding itself; they'd double the
        // log without adding anything an operator hasn't already seen.
      }
      return;
    }

    case "result": {
      if (typeof parsed.total_cost_usd === "number") {
        queue.push({ kind: "cost", usd: parsed.total_cost_usd });
      }
      // `is_error` covers auth failures and API errors, which exit 0 and
      // would otherwise look like a successful empty run.
      if (parsed.is_error) {
        queue.push({ kind: "error", message: String(parsed.result ?? parsed.subtype ?? "the CLI reported an error") });
      } else {
        queue.push({ kind: "done", ok: true, summary: typeof parsed.result === "string" ? parsed.result : undefined });
      }
      return;
    }

    default:
      // An unrecognised line is still information; don't silently swallow it.
      queue.push({ kind: "output", text: line });
  }
}
