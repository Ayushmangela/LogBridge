// Phase 2: which CLI an agent runs, on which model, with which command.
//
// The security-relevant part is the permission bypass. The mockup made
// `--permission-mode bypassPermissions` the default AUTO MODE command, which
// would have turned off the one tool policy this project actually enforces
// for every agent created from a browser. It is an explicit opt-in instead,
// and the machine — not the browser — decides whether to honour it.
import { describe, expect, test } from "vitest";
import {
  commandPreview,
  detectInstalled,
  MODEL_PLACEHOLDER,
  PROVIDERS,
  providerById,
  TASK_PLACEHOLDER,
} from "./harness/providers.js";
import { makePtyHarness } from "./harness/ptyHarness.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claude = () => providerById("claude")!;

describe("the provider registry", () => {
  test("every CLI in the design is present", () => {
    const ids = PROVIDERS.map((p) => p.id);
    for (const want of [
      "claude", "codex", "grok", "kimi", "antigravity",
      "qwen", "opencode", "crush", "pi", "copilot",
    ]) {
      expect(ids, `${want} missing from the registry`).toContain(want);
    }
  });

  test("only the two with captured output claim to be verified", () => {
    // The rule that caught three opencode bugs: a parser written from
    // documentation looks right and silently drops tool calls.
    expect(PROVIDERS.filter((p) => p.verified).map((p) => p.id)).toEqual(["claude", "opencode"]);
  });

  test("only claude claims to enforce a tool policy", () => {
    expect(PROVIDERS.filter((p) => p.policy !== "none").map((p) => p.id)).toEqual(["claude"]);
  });

  test("a new provider ships with no model list rather than invented ids", () => {
    // A wrong model id fails at spawn time, long after the person picked it.
    for (const id of ["antigravity", "pi"]) {
      expect(providerById(id)!.models).toEqual([]);
    }
  });

  test("claude's models are ones the installed CLI documents", () => {
    // `claude --help`: aliases fable/opus/sonnet, full names like
    // "claude-fable-5". Captured, not transcribed from a mockup.
    expect(claude().models).toContain("claude-fable-5");
    for (const m of claude().models) expect(m).toMatch(/^claude-/);
  });
});

describe("the command preview", () => {
  test("is built from the same buildArgs the harness spawns", () => {
    // Not a re-implementation: if buildArgs changes, this changes with it.
    const spec = claude();
    const argv = [spec.command, ...spec.buildArgs(TASK_PLACEHOLDER, "claude-opus-5")];
    expect(commandPreview(spec, "claude-opus-5")).toBe(
      argv.map((a) => (/[\s"']/.test(a) ? `"${a}"` : a)).join(" ")
    );
  });

  test("carries no permission flag by default — the settings file governs", () => {
    expect(commandPreview(claude(), "claude-opus-5")).not.toContain("permission-mode");
  });

  test("adds the bypass flag only when asked", () => {
    const withBypass = commandPreview(claude(), "claude-opus-5", { bypassPermissions: true });
    expect(withBypass).toContain("--permission-mode bypassPermissions");
  });

  test("the model placeholder is substitutable, and omitting a model is not the same as empty", () => {
    expect(commandPreview(claude(), MODEL_PLACEHOLDER)).toContain(MODEL_PLACEHOLDER);
    // No model at all must drop the flag entirely, not pass --model ""
    expect(commandPreview(claude(), null)).not.toContain("--model");
  });

  test("a provider with no bypass mode advertises none", () => {
    expect(claude().bypassFlag).toBe("--permission-mode bypassPermissions");
    expect(providerById("opencode")!.bypassFlag ?? null).toBeNull();
  });
});

describe("the machine has the final say on bypassing permissions", () => {
  // Asserting on the harness object would prove nothing — the gate lives
  // between buildArgs and pty.spawn. So the "CLI" here is a real script that
  // records the argv it was handed, and the provider's own buildArgs runs
  // untouched. This is the argv the machine would actually execute.
  function recordingCli(): { command: string; readArgv: () => string[]; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "argv-"));
    const out = join(dir, "argv.txt");
    const script = join(dir, "cli.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\n`, { mode: 0o755 });
    return {
      command: script, dir,
      readArgv: () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : []),
    };
  }

  async function argvFor(opts: { bypassPermissions: boolean; allowUnsandboxed: boolean }) {
    const cli = recordingCli();
    const h = makePtyHarness({
      provider: "claude", model: "claude-opus-5", command: cli.command, ...opts,
    });
    const handle = h.spawn({ prompt: "do the thing", cwd: cli.dir, allowTools: [], denyPaths: [], maxSeconds: 10, maxUsd: 0 });
    for await (const _ of handle.events) { /* drain until the script exits */ }
    const argv = cli.readArgv();
    rmSync(cli.dir, { recursive: true, force: true });
    return argv;
  }

  test("a machine that never opted in does NOT get the bypass flag", async () => {
    const argv = await argvFor({ bypassPermissions: true, allowUnsandboxed: false });
    expect(argv.length, "the stub CLI should have recorded its argv").toBeGreaterThan(0);
    expect(argv).not.toContain("bypassPermissions");
    expect(argv).not.toContain("--permission-mode");
  });

  test("a machine that DID opt in gets it", async () => {
    const argv = await argvFor({ bypassPermissions: true, allowUnsandboxed: true });
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("bypassPermissions");
  });

  test("it downgrades rather than refusing — the task still runs", async () => {
    // Failing would be the wrong direction: the person asked for FEWER
    // restrictions, and quietly giving them more is the safe way to fail.
    const argv = await argvFor({ bypassPermissions: true, allowUnsandboxed: false });
    expect(argv, "the CLI still ran, just under policy").toContain("do the thing");
  });
});

describe("detectInstalled", () => {
  test("reports what is on PATH, not the whole registry", () => {
    const only = detectInstalled((cmd) => cmd === "claude");
    expect(only.filter((p) => p.installed).map((p) => p.id)).toEqual(["claude"]);
    expect(only.length).toBe(PROVIDERS.length);
  });
});
