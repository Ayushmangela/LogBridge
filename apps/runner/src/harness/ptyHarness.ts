// Real agent execution: spawn the CLI the machine's owner already has
// installed and authenticated (claude / codex / gemini / ...) as a real
// pseudo-terminal process, rather than talking to a raw API key. This is
// what makes "each agent's model API key comes from its own owner's node"
// true without needing a second, separate credential.
//
// Which CLI to run and how to read it lives in providers.ts; this file is
// only the PTY mechanics — spawn, stream, interrupt, kill, and the tool
// policy file written before each spawn.
//
// VERIFICATION STATUS per provider (see PROVIDERS.md):
//   claude   — flags and event shape verified against a real 2.1.241 install.
//              The capture was UNAUTHENTICATED, so the tool_use branch is
//              written from the documented content-block shape, not observed.
//   opencode — verified against a real authenticated run that returned an
//              actual answer. Its `tool` event was not exercised by that run.
//   others   — command and args only; they run through the plain-text reader
//              until someone captures their real output.
import * as pty from "node-pty";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHarness, AgentHandle, SpawnOptions, AgentEvent } from "./types.js";
import { AsyncEventQueue } from "./asyncQueue.js";
import { providerById } from "./providers.js";

export interface PtyHarnessConfig {
  /** Provider id from the registry — see providers.ts. Default "claude". */
  provider?: string;
  /** Override the binary (a custom install path, or a test double). */
  command?: string;
  /** Model passed through to the provider's arg builder. */
  model?: string | null;
  /** Escape hatch for a CLI the registry doesn't know. */
  buildArgs?: (prompt: string) => string[];
  /**
   * Run a provider whose tool policy CANNOT be enforced (policy: "none").
   * Off by default: silently running a model unrestricted while the caller
   * passed denyPaths would make the policy decorative, and D3 exists
   * precisely so it isn't. Opting in is a deliberate act by the operator.
   */
  allowUnsandboxed?: boolean;
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;



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
  const providerId = config.provider ?? process.env.AGENT_PROVIDER ?? "claude";
  const provider = providerById(providerId);
  if (!provider) throw new Error(`unknown provider "${providerId}" — see providers.ts`);

  const command = config.command ?? process.env.AGENT_CLI_COMMAND ?? provider.command;
  const model = config.model ?? process.env.AGENT_MODEL ?? null;
  const buildArgs = config.buildArgs ?? ((prompt: string) => provider.buildArgs(prompt, model));
  // Each provider reads its own format; a mismatch here is what made the
  // harness silently useless against anything but Claude Code before.
  // Returns true when the provider reported a terminal outcome of its own.
  const readLine = (queue: AsyncEventQueue<AgentEvent>, line: string): boolean => {
    let terminal = false;
    for (const ev of provider.parseLine(line)) {
      if (ev.kind === "done" || ev.kind === "error") terminal = true;
      queue.push(ev);
    }
    return terminal;
  };

  const allowUnsandboxed = config.allowUnsandboxed ?? process.env.AGENT_ALLOW_UNSANDBOXED === "1";

  return {
    name: `pty:${provider.id}`,
    spawn(opts: SpawnOptions): AgentHandle {
      // Refuse before spawning anything if the caller asked for restrictions
      // this provider cannot actually apply. Failing the task is the correct
      // outcome — the alternative is a model running with more access than
      // whoever queued the work believed it had.
      const wantsPolicy = opts.allowTools.length > 0 || opts.denyPaths.length > 0;
      if (provider.policy === "none" && wantsPolicy && !allowUnsandboxed) {
        const q = new AsyncEventQueue<AgentEvent>();
        q.push({
          kind: "error",
          message:
            `${provider.id} has no tool-policy mechanism this runner can enforce, ` +
            `but a policy was requested (allow=[${opts.allowTools.join(",")}] ` +
            `deny=[${opts.denyPaths.join(",")}]). Refusing to run it unrestricted. ` +
            `Pass --allow-unsandboxed (or AGENT_ALLOW_UNSANDBOXED=1) to accept that risk. See PROVIDERS.md.`,
        });
        q.close();
        return { events: q, interrupt: () => {}, kill: () => {} };
      }
      // Only meaningful for providers that actually read it.
      if (provider.policy === "claude-settings") {
        writeScopedSettings(opts.cwd, opts.allowTools, opts.denyPaths);
      }

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
      // Ask the parser rather than string-matching the wire format: only the
      // provider knows which of its lines are actually terminal. Matching on
      // '"type":"step_finish"' latched on opencode's INTERMEDIATE steps.
      const scan = (line: string) => {
        if (readLine(queue, line)) sawResult = true;
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
        answer: (text) => {
          // A pty CAN inject stdin mid-run — that's what makes questions
          // deliverable at all. Whether the CLI listens is its own business:
          // today's verified CLIs are one-shot and never emit a question, so
          // this path exists for interactive harnesses and costs nothing
          // otherwise. No pretending it works where it can't be observed.
          try { proc.write(text + "\n"); } catch { /* process may be gone */ }
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
