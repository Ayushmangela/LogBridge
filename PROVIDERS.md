# Agent CLI providers

LogBridge runs the coding CLI you already have installed and signed in
(D1: the model credential belongs to the machine's owner, never to the
server). Each CLI needs two things, and they differ per provider:

1. **How to invoke it** — flags, subcommand, model syntax
2. **How to read it** — every CLI streams a different event format

`apps/runner/src/harness/providers.ts` holds both. `ptyHarness.ts` is now
only the PTY mechanics.

## Status

| Provider | Command | Invocation | Output format | Status |
|---|---|---|---|---|
| **Claude Code** | `claude` | `-p <prompt> --output-format stream-json --verbose` | verified | ✅ **verified** |
| **OpenCode** | `opencode` | `run <prompt> --format json [-m provider/model]` | verified | ✅ **verified** |
| Codex · GPT | `codex` | `exec <prompt>` | — | ⚠️ plain text |
| Gemini | `gemini` | `-p <prompt>` | — | ⚠️ plain text |
| Qwen | `qwen` | `-p <prompt>` | — | ⚠️ plain text |
| Crush · Charm | `crush` | `run <prompt>` | — | ⚠️ plain text |
| Copilot | `copilot` | `-p <prompt>` | — | ⚠️ plain text |
| Grok · xAI | `grok` | `-p <prompt>` | — | ⚠️ plain text |
| Kimi Code | `kimi` | `-p <prompt>` | — | ⚠️ plain text |

**Verified** means a parser was written against real captured output from a
real run, stored in `apps/runner/test-support/`. Not from documentation.

That distinction has already paid for itself: the first Claude parser was
written from docs and got **two of three cases wrong** — text is a nested
content block (`message.content[].text`), not a top-level `text` field, and
tool calls are `{type:"tool_use"}` blocks in that same array, not a top-level
`tool_name`. A fixture written to match the code would have passed happily.

## Plain text is a real mode, not a stub

An unverified provider still **runs**. Its output is streamed line by line and
its exit code decides success. What you lose is structure: no `tool_call`
events, so the office can't show which tool an agent is using.

This is deliberate. Inventing a parser for a format nobody here has observed
is how you get a harness that looks supported and silently drops half of what
the CLI says.

## Adding a verified provider

```bash
# 1. capture real output
<cli> <its prompt flags> > apps/runner/test-support/<id>.sample.jsonl

# 2. read what's actually in there before writing any parser
node -e 'require("fs").readFileSync("<file>","utf8").trim().split("\n")
  .forEach(l=>{const o=JSON.parse(l);console.log(o.type, Object.keys(o))})'
```

3. Add a `parseLine` to `providers.ts`, flip `verified: true`
4. Add the id to the `verified` list in `providers.test.ts` — that test exists
   specifically to stop "verified" drifting into a claim nobody checked
5. Test against the capture, never against a hand-written fixture

## Cost

Best-effort only. Where a CLI reports cost for free (Claude's `total_cost_usd`,
OpenCode's `part.cost`) it's passed through, and a zero is dropped rather than
emitted as noise. It is **not** something a provider must supply — people run
these on their own subscriptions.

`budget_usd` still exists in the task schema and the wall-clock budget kill in
`taskRunner.ts` is unaffected: that one is a real safety mechanism and is
time-based, not cost-based.

## Selecting one

```bash
AGENT_HARNESS=real AGENT_PROVIDER=opencode npx tsx src/cli.ts start
# or
npx tsx src/cli.ts start --harness real --provider claude --model claude-opus-5
```

`detectInstalled()` reports which commands are actually on `PATH`, so a UI can
show what's available rather than offering a provider that isn't there.

## What's still missing

**There is no Add Agent UI.** Agents are declared statically in
`apps/runner/src/cli.ts` and published when the machine connects. Choosing a
provider from the browser needs a runner-side path to register an agent at
runtime, which doesn't exist. That's Phase 6 in `UI-PHASES.md` and the
registry here is its foundation.
