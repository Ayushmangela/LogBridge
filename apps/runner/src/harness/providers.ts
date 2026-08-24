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
import type { AgentEvent } from "./types.js";

export interface ProviderSpec {
  id: string;
  label: string;
  command: string;
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
      return []; // init metadata

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

    case "tool": {
      // Not observed in the captured sample (that run used no tools), so this
      // reads defensively across the plausible field names rather than
      // asserting one. See PROVIDERS.md.
      const name = part.tool ?? part.name ?? part.toolName ?? "unknown";
      return [{ kind: "tool_call", name: String(name), input: part.input ?? part.args ?? null }];
    }

    case "step_finish": {
      if (typeof part.cost === "number" && part.cost > 0) out.push({ kind: "cost", usd: part.cost });
      const failed = part.reason && part.reason !== "stop" && part.reason !== "end_turn";
      if (failed) out.push({ kind: "error", message: `opencode stopped: ${trim(part.reason, 120)}` });
      else out.push({ kind: "done", ok: true });
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
    verified: true,
    models: [], // `opencode models` lists them per configured provider
    buildArgs: (prompt, model) => ["run", prompt, "--format", "json", ...(model ? ["-m", model] : [])],
    parseLine: parseOpencode,
  },
  ...UNVERIFIED.map((u) => ({
    id: u.id,
    label: u.label,
    command: u.command,
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
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  return paths.some((dir) => {
    try { return existsSync(join(dir, cmd)); } catch { return false; }
  });
}
