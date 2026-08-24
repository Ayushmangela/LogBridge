// The agent-CLI registry (PROVIDERS.md).
//
// Every CLI has a different invocation AND a different event format, so a
// provider is both: how to start it, and how to read what it says.
//
//   claude:   claude -p "<prompt>" --output-format stream-json
//   opencode: opencode run "<prompt>" --format json -m <provider/model>
//
// Those two are VERIFIED — their parsers were written against real captured
// output in test-support/, not from documentation. Everything else in this
// file is marked `verified: false` and runs through the plain-text reader:
// it genuinely works (you see the CLI's output and its exit status), it just
// can't structure tool calls. That is deliberately better than inventing a
// parser for a format nobody here has observed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "./types.js";

/**
 * How a provider's tool policy is enforced, if at all.
 *
 *  "claude-settings" — a project-scoped .claude/settings.local.json the CLI
 *                      reads and obeys.
 *  "none"            — no known mechanism. allowTools/denyPaths CANNOT be
 *                      enforced; the CLI runs with its own defaults.
 *
 * This is not cosmetic. D3 puts policy in the runner precisely so a model
 * can't reach past it, and writing a settings file the CLI ignores is worse
 * than no policy at all — it looks enforced. Providers marked "none" are
 * refused unless the operator explicitly opts in.
 */
export type PolicyMode = "claude-settings" | "none";

export interface ProviderSpec {
  id: string;
  label: string;
  command: string;
  policy: PolicyMode;
  /** Has this provider's output format been observed, or is it assumed? */
  verified: boolean;
  /** Model ids offered in the UI. Empty = the CLI picks, or it's configured elsewhere. */
  models: string[];
  buildArgs(prompt: string, model?: string | null): string[];
  /** Pure: one line in, zero or more events out. */
  parseLine(line: string): AgentEvent[];
}

function json(line: string): any | null {
  try { return JSON.parse(line); } catch { return null; }
}

function trim(s: unknown, n = 2000): string {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// ---------------------------------------------------------------- claude
// Verified against claude 2.1.241 — test-support/claude-stream-json.sample.jsonl.
// The shape that matters: text and tool calls are CONTENT BLOCKS inside
// message.content[], not top-level fields. Guessing that wrong is exactly
// the bug this registry's verified/unverified split exists to prevent.
function parseClaude(line: string): AgentEvent[] {
  const p = json(line);
  if (!p) return [{ kind: "output", text: line }];
  const out: AgentEvent[] = [];

  switch (p.type) {
    case "system":
    case "rate_limit_event":
      // Metadata, not activity. rate_limit_event only showed up once a real
      // authenticated run was captured — before that it fell through to the
      // default branch and dumped a whole JSON line into the office feed.
      return [];

    case "assistant":
    case "user": {
      const content = p.message?.content;
      if (!Array.isArray(content)) return [];
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") {
          if (b.text.trim()) out.push({ kind: "output", text: trim(b.text) });
        } else if (b?.type === "tool_use") {
          out.push({ kind: "tool_call", name: b.name ?? "unknown", input: b.input ?? null });
        }
        // tool_result blocks are the CLI feeding itself — not activity.
      }
      return out;
    }

    case "result": {
      if (typeof p.total_cost_usd === "number") out.push({ kind: "cost", usd: p.total_cost_usd });
      // is_error covers auth and API failures, which still exit 0 and would
      // otherwise look like a successful empty run.
      if (p.is_error) out.push({ kind: "error", message: trim(p.result ?? p.subtype ?? "the CLI reported an error", 300) });
      else out.push({ kind: "done", ok: true, summary: typeof p.result === "string" ? trim(p.result, 300) : undefined });
      return out;
    }

    default:
      return [{ kind: "output", text: line }];
  }
}

// opencode step_finish reasons. A step ending is not the run ending.
const CONTINUES = new Set(["tool-calls", "tool_calls", "tool-call", "length"]);
const TERMINAL_OK = new Set(["stop", "end_turn", "end-turn", "complete", "completed"]);

// -------------------------------------------------------------- opencode
// Verified against a real run — test-support/opencode-json.sample.jsonl.
// Everything hangs off `part`, and the envelope's `type` is snake_case while
// `part.type` is kebab-case ("step_finish" vs "step-finish"). Both are real.
function parseOpencode(line: string): AgentEvent[] {
  const p = json(line);
  if (!p) return [{ kind: "output", text: line }];
  const part = p.part ?? {};
  const out: AgentEvent[] = [];

  switch (p.type) {
    case "step_start":
      return [];

    case "text":
      return part.text && String(part.text).trim()
        ? [{ kind: "output", text: trim(part.text) }]
        : [];

    // Verified against test-support/opencode-tools.sample.jsonl. Note the
    // envelope type is "tool_use" while part.type is "tool" — keying on
    // "tool" (the obvious guess) matched nothing, so a real run wrote a file
    // and reported zero tool calls.
    case "tool_use": {
      const name = String(part.tool ?? part.name ?? "unknown");
      // The arguments live under state.input, not at the top of part.
      const input = part.state?.input ?? part.input ?? null;
      return [{ kind: "tool_call", name, input }];
    }

    case "step_finish": {
      if (typeof part.cost === "number" && part.cost > 0) out.push({ kind: "cost", usd: part.cost });
      const reason = String(part.reason ?? "stop");
      // opencode finishes a STEP, not the run. "tool-calls" means the model
      // paused to use tools and more steps follow — treating it as terminal
      // killed a real task mid-work the first time this ran for real.
      if (CONTINUES.has(reason)) return out;
      if (TERMINAL_OK.has(reason)) { out.push({ kind: "done", ok: true }); return out; }
      out.push({ kind: "error", message: `opencode stopped: ${trim(reason, 120)}` });
      return out;
    }

    case "error":
      return [{ kind: "error", message: trim(p.message ?? part.message ?? "opencode reported an error", 300) }];

    default:
      return [];  // opencode emits a lot of envelope chatter; don't echo it all
  }
}

// --------------------------------------------------------- plain text
// For CLIs whose structured format hasn't been observed here. Every line is
// output; completion comes from the process exit code, which ptyHarness
// already handles. Honest and useful — just not structured.
function parsePlain(line: string): AgentEvent[] {
  return line.trim() ? [{ kind: "output", text: trim(line) }] : [];
}

const UNVERIFIED: Array<{ id: string; label: string; command: string; models: string[]; args: (p: string, m?: string | null) => string[] }> = [
  { id: "codex",    label: "Codex · GPT",         command: "codex",   models: [], args: (p) => ["exec", p] },
  { id: "gemini",   label: "Gemini",              command: "gemini",  models: [], args: (p) => ["-p", p] },
  { id: "qwen",     label: "Qwen",                command: "qwen",    models: [], args: (p) => ["-p", p] },
  { id: "crush",    label: "Crush · Charm",       command: "crush",   models: [], args: (p) => ["run", p] },
  { id: "copilot",  label: "Copilot",             command: "copilot", models: [], args: (p) => ["-p", p] },
  { id: "grok",     label: "Grok · xAI",          command: "grok",    models: [], args: (p) => ["-p", p] },
  { id: "kimi",     label: "Kimi Code",           command: "kimi",    models: [], args: (p) => ["-p", p] },
];

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    policy: "claude-settings",
    verified: true,
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    buildArgs: (prompt, model) => [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",                       // stream-json needs it for the event stream
      ...(model ? ["--model", model] : []),
    ],
    parseLine: parseClaude,
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    // opencode has its own permission config, but nothing here has verified
    // how to scope it per-run — so it is honestly "none" rather than assumed.
    policy: "none",
    verified: true,
    models: [], // `opencode models` lists them per configured provider
    buildArgs: (prompt, model) => ["run", prompt, "--format", "json", ...(model ? ["-m", model] : [])],
    parseLine: parseOpencode,
  },
  ...UNVERIFIED.map((u) => ({
    id: u.id,
    label: u.label,
    command: u.command,
    policy: "none" as const,
    verified: false,
    models: u.models,
    buildArgs: u.args,
    parseLine: parsePlain,
  })),
];

export function providerById(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Which providers are actually on this machine's PATH. */
export function detectInstalled(
  lookup: (cmd: string) => boolean = defaultLookup
): Array<ProviderSpec & { installed: boolean }> {
  return PROVIDERS.map((p) => ({ ...p, installed: lookup(p.command) }));
}

function defaultLookup(cmd: string): boolean {
  // Resolved via PATH rather than `which`, so this stays synchronous and
  // doesn't spawn a shell per provider on every call.
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  return paths.some((dir) => {
    try { return existsSync(join(dir, cmd)); } catch { return false; }
  });
}
