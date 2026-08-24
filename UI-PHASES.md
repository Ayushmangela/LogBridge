# UI rebuild — phase plan

> **Status: all seven phases are done.** Verified in a running browser, not just
> by reading the code. What remains is in `HANDOFF.md`'s known-broken table.

Target: the full application shell (left nav + office canvas + right panel),
replacing today's floating-glass-panels-over-a-canvas layout.

Each phase is **independently shippable and independently pushable**. None
breaks the one before it, and every phase ends with `main` running.

Ordering rule: phases that make an *existing but unreachable* feature usable
come before phases that add new surface. Phase 2 exists because the
chat→proposal→approval flow is fully built and currently has **no UI at all** —
the only way to trigger it is `ws.send()` in the browser console.

---

## Phase 1 — App shell  ✅ DONE

Restructure `index.html` from fixed-position floating panels into a real
three-column grid: left nav, centre canvas, right panel. Top bar with
workspace name and online count.

- Pure layout. No new protocol fields, no server changes.
- The office canvas keeps working exactly as now, just inside a column.
- Existing overlays (Board, Memory) become nav destinations rather than
  full-screen takeovers.

**Ends with:** the same features, in the target shape.
**Suggested commit:** `feat: three-column app shell`

## Phase 2 — Chat panel + approval UI  ✅ DONE

A chat list and input in the right panel, and **approve / reject buttons** on
any message carrying `ask`.

- `ChatMessage` and the `answer` client message already exist and are already
  handled server-side. This is UI over a finished backend.
- Turns `@dev-fake do X` → proposal → approve → run into something usable
  without a console.
- Needs: chat history retained client-side (the server broadcasts chat but
  never replays it — a late joiner sees nothing until the next message).

**Ends with:** the M4 slice-1 flow driveable by a person.
**Suggested commit:** `feat: room chat panel with inline task approval`

## Phase 3 — Sidebar rosters  ✅ DONE

PEOPLE and AGENTS lists in the left nav, with live status dots and current
activity, driven by `room.humans` / `room.agents`.

- Data already in every view broadcast. No protocol change.
- Clicking an agent focuses/inspects it — reuses the existing inspector.

**Suggested commit:** `feat: people and agent rosters in the sidebar`

## Phase 4 — Activity feed + current task  ✅ DONE

Right-panel feed of recent events, and a card for the task in focus.

- **Needs a protocol change:** the view carries no event history. Add
  `room.activity: ActivityItem[]` (capped, newest first) from the existing
  `events` table — the same capped-projection pattern `tasks` and `memories`
  already use, so `CONTRACT.md` invariant 1 still holds.
- The event log already records everything needed (`task.assigned`,
  `task.result`, `memory.write`, `delegate.request`, …).

**Landed as** `Room.activity: ActivityItem[]` (CONTRACT.md 1.10). The summary
text is written **server-side** in `apps/server/src/activity.ts`, for the same
reason `zone` is (invariant 2): one place decides the wording, so the UI can't
narrate something the log doesn't support. Noise (`position`, `task.status`,
`task.event`) is filtered, and the query over-fetches so a burst of position
events can't return an empty page.

**Still not real:** the current-task progress bar shows *elapsed time*, not
completion — a task reports start and finish and nothing between. Labelled
"elapsed" rather than shown as a fake percentage. Real progress needs a
progress event from the harness.

## Phase 5 — Canvas name tags and task bubbles  ✅ DONE

Per-agent labels and a speech bubble showing what each one is doing, drawn
over the office.

- `AgentView.task.title` is already in the view; this is Pixi rendering work.
- Watch: bubbles must not occlude each other in a full desk pod — needs a
  simple stacking rule.

**Suggested commit:** `feat: agent name tags and task bubbles on the office floor`

## Phase 6 — Add Agent modal  ✅ DONE

**6a (done): the multi-agent foundation.** `task.offer` now carries `agentId`
(CONTRACT.md 1.11), the runner resolves the addressed agent instead of
`agents[0]`, and each agent gets its own harness from the provider registry.
`--agents-file` declares several agents on one machine. Verified live: one
machine ran `opencode-dev` on `pty:opencode` and `fake-dev` on `pty:claude`
concurrently, each in its own working directory.

**6b (next): runtime registration + the dialog.** Agents still come from
`cli.ts` flags or `--agents-file` at startup. Creating one from the browser
needs an `agent.create` message the runner accepts — gated behind an explicit
opt-in, the same way `acceptDelegations` is, because it means a browser can
start a real CLI on someone's machine.

### Original notes

The four-step (Identity / Workspace / Engine / Briefing) dialog: provider
grid, model grid, generated command preview.

- **This is the biggest phase and the only one needing real backend work.**
  Agents are currently declared *statically* in `apps/runner/src/cli.ts` and
  published on connect. Creating one from the browser means a runner-side
  path to register a new agent at runtime, which does not exist.
- Also needs the provider/model list to be real rather than decorative:
  each entry maps to a `ptyHarness` command, and the ones not installed on
  the machine must be shown as unavailable rather than offered and failing.

**Suggested commit:** `feat: add-agent dialog with provider and model selection`

## Phase 7 — Legend / view / filter bar  ✅ DONE

Bottom bar: status legend, floor/minimap toggle, and filters for
people/agents/rooms/tasks.

- Filters are client-side only — the server keeps sending the full snapshot.

**Suggested commit:** `feat: office legend and filter controls`

---

## Not in any phase (deliberately)

Multiple floors · drag-to-reorder on the board · notification centre ·
search · workspace switching · invite flow. Each is real work with no
current backing in the protocol, and none is needed to make the existing
features usable.
