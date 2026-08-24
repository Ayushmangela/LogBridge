// Real agent execution: spawn the CLI the machine's owner already has
// installed and authenticated (claude / codex / gemini / ...) as a real
// pseudo-terminal process — Munder Difflin's approach, not a raw API key.
// This is what makes "each agent's model API key comes from its own
// owner's node" true without needing a second, separate credential.
//
// ⚠ VERIFICATION GAP, stated plainly: the exact CLI flags below (`-p`,
// `--output-format stream-json`) match Claude Code's documented headless
// mode as of this writing, but this harness has never been run against a
// real `claude` binary — this dev machine has neither the CLI nor an API
// key installed. Structurally sound, typechecked, and unit-tested against
// a fake PTY process (see ptyHarness.test.ts) — NOT live-verified. Point
// AGENT_CLI_COMMAND at whatever's actually installed and confirm the flags
// still match before trusting this with real budget.
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
      proc.onData((chunk: string) => {
        if (settled) return;
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.replace(ANSI_ESCAPE, "").trim();
          if (!line) continue;
          emitLine(queue, line);
        }
      });

      proc.onExit(({ exitCode, signal }) => {
        if (settled) return;
        settled = true;
        if (buf.trim()) emitLine(queue, buf.replace(ANSI_ESCAPE, "").trim());
        if (exitCode !== 0) {
          queue.push({ kind: "error", message: `${command} exited code=${exitCode} signal=${signal ?? "none"}` });
        } else {
          queue.push({ kind: "done", ok: true });
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

function emitLine(queue: AsyncEventQueue<AgentEvent>, line: string) {
  try {
    const parsed = JSON.parse(line);
    // Best-effort field detection across plausible stream-json shapes —
    // NOT verified against a real CLI response. See the module header.
    if (typeof parsed.total_cost_usd === "number") {
      queue.push({ kind: "cost", usd: parsed.total_cost_usd });
    }
    if (parsed.type === "tool_use" || parsed.tool_name) {
      queue.push({ kind: "tool_call", name: parsed.tool_name ?? parsed.name ?? "unknown", input: parsed.input ?? parsed });
      return;
    }
    if (typeof parsed.text === "string") {
      queue.push({ kind: "output", text: parsed.text });
      return;
    }
    queue.push({ kind: "output", text: line });
  } catch {
    queue.push({ kind: "output", text: line });
  }
}
