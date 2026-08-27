# Brief: Stream B — the server (round 3, watching work happen)

**You arrive here from `HANDOFF-SERVER-2.md`. Its Phases 1–3 must be pushed
before you start.** Work Phase 4 → 5 → 6 without stopping, pushing each with
its result file. Then continue to `HANDOFF-SERVER-4.md`.

Everything in §1–§4 of `HANDOFF-SERVER-2.md` still applies unchanged: your
file ownership, the git rules, the process, and the house rules. **Re-read
them if you have compacted since.** The short version:

- You own `apps/server/**`, `packages/protocol/**`, `CONTRACT.md`, and your
  own `SERVER2-PHASE-N-RESULT.md` files. Nothing else.
- Never `git add .`, `stash`, `checkout`, `restore`, `reset`, `pull`, or
  `rebase`. Name every path. If push is rejected, stop and report.
- A test must fail without its fix. Prove it by reverting.
- Baseline test counts must never go down.

---

## Phase 4 — Traces: what an agent is actually doing

The mockup's employee panel has a **TRACES** tab, and it is the honest half of
"watch it work" — no shell, no PTY, no remote execution.

Everything needed is already logged. The runner emits `task.event` rows
carrying tool calls, step boundaries and output lines; `view.ts`'s
`latestProgress` already reads the tail of them for the task card.

- **`GET /api/agents/:id/traces`** — the structured events for that agent's
  recent tasks: tool calls with their arguments, step boundaries, output
  lines, and outcomes. Newest first, paginated
- Group by task so a trace reads as "this task, these steps", not a flat
  firehose
- **Redact before you serve.** Tool arguments contain file paths and file
  contents. A trace is a debugging aid, not an exfiltration endpoint — decide
  what is safe to include and write the decision down. At minimum, do not
  invent new exposure: if a value is not already in the view or the activity
  feed, think before adding it here

**Do not put traces in the workspace view.** `broadcastView` re-sends the
whole view on every position message. Traces are unbounded and belong on their
own endpoint, exactly like history.

**Done when:** a real task's tool calls and steps come back grouped by task;
an agent that has never run returns empty and valid; the response is bounded
however long the agent has lived; the redaction decision is documented.

## Phase 5 — A read-only output stream

Live output, **without a terminal**. The distinction is the whole point of
this phase, so hold it precisely.

The harness already parses each CLI's output into structured events. Stream
**the parsed lines**, never the raw PTY.

- Push `task.event` output lines to subscribed browsers as they arrive, over
  the existing WebSocket
- Scope a subscription to one agent, so watching one agent does not fan every
  agent's output to every browser
- Cap it. A runaway CLI can emit megabytes; the office must not fall over
  because someone opened a tab

**Why not the real terminal:** LogBridge serves a browser over a network and
has no sign-in (D23, trust-on-first-sight). A raw PTY stream is an interactive
shell on somebody's laptop exposed to anything that can reach the URL. The
reference app can do it safely because it is Electron — the shell and the
window are the same machine and the same user. **That difference is the
reason, and it does not go away by being careful.**

**Done when:** output appears in a browser as the agent produces it; two
browsers watching different agents each see only theirs; a flood is truncated
rather than fatal; nothing raw from the PTY is exposed.

## Phase 6 — Git state per agent

The mockup's employee panel has a **GIT** tab. Agents already work in isolated
git worktrees (`apps/runner/src/workspace.ts`), so there is real state to show.

- **`GET /api/agents/:id/git`** — current branch, dirty/clean, ahead/behind,
  recent commits, and changed files for that agent's workspace
- The workspace lives **on the runner's machine, not the server** (D1). The
  server cannot read that directory. This needs a request/response through the
  node gateway, like agent creation — the runner answers, the server relays
- An offline machine returns "unknown", not an error and not stale data
  cached from an hour ago (D28)

**This is the phase most likely to tempt a shortcut.** Reading git state
server-side would work on a single-machine dev setup and be wrong the moment a
second machine joins. Do it through the gateway.

**Done when:** git state for an agent on a live machine is real and current;
an offline machine reports unknown; a non-git workspace says so rather than
erroring; nothing reads the filesystem from the server process.

---

## → Next

Push Phases 4–6 with their result files, then **continue to
`HANDOFF-SERVER-4.md`.** Do not pause for review.
