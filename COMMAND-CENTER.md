# Command Center — plan

The mockups describe two surfaces: an **ADD AGENT** wizard (identity ·
workspace · engine · briefing) and a per-agent **COMMAND CENTER** with ten
tabs. This is a plan, not a spec handed down — where a mockup conflicts with
something the system already decided, that is called out rather than quietly
built.

Scope honesty up front: the four images contain more surface than the whole of
M4 and M5 combined. Most of it is an *expansion* of screens that already exist
(the roster, memory, tasks, activity), which is what makes it tractable. Two
items are genuinely new systems and are deliberately **not** in the first six
phases — see "Deferred".

---

## Two things to decide before building

**1. `--permission-mode bypassPermissions` as the AUTO MODE default.**

The mockup's command preview reads:

```
claude --model claude-fable-5 --permission-mode bypassPermissions
```

That flag disables tool permission prompts entirely. Today `claude` is the one
provider that *enforces* a tool policy (`policy: "claude-settings"`, a per-run
settings file), and the runner already gates unsandboxed execution behind
`RunnerOptions.allowUnsandboxed`. Shipping the mockup as drawn makes "no policy
at all" the default for every agent spawned from the browser.

Proposed instead: AUTO MODE generates the **policy-respecting** command, and
`bypassPermissions` is a visible, explicit toggle that is disabled unless the
machine set `allowUnsandboxed`. The dialog says plainly what it turns off. Same
command preview, same one-click ergonomics, opt-in rather than opt-out.

**DECIDED (repo owner): safer default, explicit opt-in.** AUTO MODE generates
the policy-respecting command. `bypassPermissions` is a visible toggle,
disabled unless the machine set `allowUnsandboxed`, and the dialog states
plainly what it turns off.

**2. The `terminal` tab is a remote shell.**

Streaming a live PTY to the browser means anyone who can reach the office URL
gets an interactive shell on the machine running the runner. There is no
sign-in yet (D23 — still trust-on-first-sight). This is not a tab; it is an
authentication prerequisite wearing a tab's clothing. It is deferred below with
its reasoning, not forgotten.

---

## Phases

### Phase 1 — Identity and the roster

The agent record has no room for any of this yet:

```sql
CREATE TABLE agents (id, machine_id, owner_id, project_id, name, role,
                     capabilities, concurrency, status, current_task,
                     zone_anchor, waiting_on, github_ref);
```

- `agents` gains `character`, `color`, `folder`, `note`, `briefing`, `tagline`
- `AgentView` in the protocol gains the same — the office renders what the
  server projects (invariant 2), so the browser never picks a sprite itself
- ADD AGENT steps **1 IDENTITY** (name · character · color) and **4 BRIEFING**
  (description · goal)

  **DECIDED (repo owner): build the picker against the 4 sprite atlases that
  exist** — `nancy`, `adam`, `ash`, `lucy` (`assets/characters/*.json|png`,
  loaded in `index.html` via `CHAR_NAMES`). The mockup shows nine; adding more
  later is dropping a `.png` + `.json` pair into `assets/characters` and
  extending `CHAR_NAMES`, with no other code change. The picker is built to
  read that list rather than hardcoding four slots.
- Sidebar: agents grouped under folder headings, status pill, `no note` line

First because every later phase writes to this record, and the schema is
cheapest to change once, early. D7 applies — no migration framework, so the
`ALTER TABLE` guard in `db.ts` is the pattern to follow.

**Done when:** an agent created in the browser shows the chosen sprite and
colour in the office and in the roster, under its folder, after a runner
restart.

### Phase 2 — Engine

Registry today: `claude` and `opencode` verified against captured output;
`codex`, `gemini`, `qwen`, `crush`, `copilot`, `grok`, `kimi` present but
running through the plain-text reader and labelled "(unverified parser)".

- Add the mockup's missing entries: **Kimi Code**, **Antigravity · Gemini**,
  **Pi**, **Crush · Charm**, **Custom**
- Per-provider model lists (the mockup shows eight for Claude Code)
- Live command preview + AUTO MODE, built from provider + model + policy
- The `bypassPermissions` gate from the decision above

**The rule that does not bend:** a new provider ships `verified: false` and
`parsePlain` until someone captures its real output. Writing a parser from
documentation is what produced three wrong guesses for `opencode` — including
a run that wrote a file and reported zero tool calls.

**Done when:** every provider in the mockup is selectable, the preview matches
what the runner actually spawns, and unverified ones say so in the UI.

### Phase 3 — Workspace

Consumes `apps/runner/src/workspace.ts`, built in parallel (see
`HANDOFF-WORKSPACE.md`). This phase is only the UI and the plumbing:

- **folder** picker → the repo path the agent works in
- **isolation** → `shared` | `worktree` | `copy`
- **resume** → whether the agent continues its prior session

Blocked on the parallel work landing. Everything in Phases 1, 2 and 4 can
proceed without it.

### Phase 4 — Command Center shell + Commands tab

- Agent detail view: portrait, name, status, tagline, `auto` toggle, `IDE`
- Tab bar (tabs land progressively; unbuilt ones are not shown)
- **Commands tab** — the catalog from the mockup: SESSION (`/clear`,
  `/resume`, `/rewind`, `/compact`, `claude -c`, `claude -r`,
  `claude --fork-session`), CONTEXT & MEMORY (`/context`, `/memory`, `/init`,
  `#`), each with SLASH/CLI badge, description, example, copy button

The catalog belongs in `apps/server/src/commands.ts` and reaches the browser
through the view, not hardcoded in `index.html` — same reason `activity.ts`
exists server-side. It is static data, which makes this the highest-value,
lowest-risk tab to build first.

### Phase 5 — Memory tab

- Per-agent memory file view and editor
- **Text search** across board / tasks / memory — FTS5 already backs this
- **Semantic search** is *blocked*, not pending: recall is BM25 because no
  embedding model is available. It renders as an explicitly-labelled text
  search rather than a box that quietly does something else

### Phase 6 — Import hire

- `.json` manifest → fills every field for review; **nothing spawns until
  `spawn` is pressed**, exactly as the mockup's own caption promises
- Manifest validated with Zod in `packages/protocol` — an imported file is
  untrusted input
- "generate one with AI…" reuses the `/plan` shape: an agent produces the
  manifest, a human approves it before anything is created

---

## Deferred, with reasons

| | Why not now |
|---|---|
| **terminal** tab | A remote shell with no sign-in. Needs D23 (enrolment) first — this is the gate, not the tab |
| **monitor**, **graph**, **workers** | Undefined in the mockups beyond a tab label. Needs a spec before an estimate |
| **triggers** | Real feature (scheduled/event-driven tasks) but a new subsystem: table, scheduler, wire messages. Deserves its own milestone |
| **ask me** | Overlaps the existing mid-task question flow — likely a re-skin of what M4 built, worth checking before rebuilding |
| **Slack inbox** (image 4) | New external integration. D9/D10 (read-only, polled) would apply |
| **clone ↔ clone E2E** (image 4) | Already built and sealed end-to-end (M5) — the diagram describes shipped behaviour |

---

## Parallel work

`HANDOFF-WORKSPACE.md` is a self-contained brief for a second AI building
git-worktree isolation at the same time. The file-ownership split that keeps
the two streams from colliding is in that document, and is binding on both
sides.
