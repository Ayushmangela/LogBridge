# Brief: Stream A — the browser (round 3, two surfaces)

**You arrive here from `HANDOFF-BROWSER-2.md`. Its Phases 1–3 must be pushed
before you start.** Work Phase 4 → 5 → 6 without stopping, pushing each with
its result file. Then continue to `HANDOFF-BROWSER-4.md`.

Everything in §1–§4 of `HANDOFF-BROWSER-2.md` still applies: you own
`apps/web/index.html` and your own result files, nothing else; never
`git add .` / `stash` / `checkout` / `restore` / `reset` / `pull`; **verify by
clicking, not by calling.** Re-read it if you have compacted.

---

## Phase 4 — Split the orchestrator from the employees

`FEATURE-INVENTORY.md` §3 describes the shape the design actually uses, and
it is not the one we have. The reference gives:

- **the orchestrator** — a ten-tab floor console: terminal, monitor, tasks,
  ask me, triggers, memory, graph, activity, commands, workers
- **an employee agent** — a small panel: terminal · git · messages · traces,
  plus **pause · halt · steer**

We give **every** agent the same tabs, which means most agents show tabs that
are meaningless for them and the useful per-agent controls have nowhere to go.

- Decide what marks an agent as the orchestrator. There is no `role: "god"`
  today; `AgentRole` already has `planner`, and `agents.role` is stored — the
  cheapest honest option is probably an existing role rather than a new column
  you cannot set. **Do not add a server field — that is Stream B's.** If you
  genuinely need one, say so in your result file and build the split on what
  exists
- Employee panel: the agent's own tabs plus the controls
- Orchestrator panel: the floor-wide tabs

**Do not delete anything that works.** Memory, triggers, commands and activity
all function today. This is about *which surface shows which*, not a rewrite.
If the split turns out worse than what we have, **say that in your result file
and leave it alone** — that is a legitimate outcome and better than shipping a
worse layout because a document asked for it.

**Done when:** an employee agent shows a panel scoped to it; the orchestrator
shows the floor console; nothing that worked before is unreachable; you can
say which agent is which and why.

## Phase 5 — Monitor tab

Depends on Stream B Phase 7 (context usage, tool-call counts, engine change).

- Per agent: **context used vs limit** with a bar, **tool calls** this task,
  its working directory, and its current engine
- A **dispatch** box that creates work, using the existing task-creation path
- An engine picker per agent — provider and model — which **restarts that
  agent's harness**. Say so on the button. A control that silently restarts a
  running agent is a trap

**The bar here is honest, unlike a progress bar.** Context used vs its limit
has a real denominator the runner reports. Do not reuse it for progress:
progress has no total and never will (no CLI reports how many steps remain),
which is why the task card shows *elapsed* and a step *count*.

**Done when:** context bars reflect real usage and move as work runs; dispatch
creates a real task; changing an engine visibly warns about the restart; an
agent whose machine is offline shows unknown rather than stale numbers.

## Phase 6 — Git tab

Depends on Stream B Phase 6.

- For the selected agent's workspace: branch, clean/dirty, ahead/behind,
  changed files, recent commits
- An **offline machine shows "unknown"** — not an error, and never numbers
  cached from earlier. D28: an agent on an offline machine is unreachable, and
  the UI must not imply otherwise
- A **shared-isolation** agent has no branch of its own; say that plainly
  rather than rendering an empty branch name

**Done when:** git state is real for an agent on a live machine; offline says
unknown; a non-git or shared workspace is explained rather than blank.

---

## → Next

Push Phases 4–6 with their result files, then **continue to
`HANDOFF-BROWSER-4.md`.** Do not pause for review.
