# Browser Phase 1 — Memory tab

**Stream A (browser).** One file changed: `apps/web/index.html`. No other
file touched, no server change made or needed.

## What was built

A third **Memory** tab in the Command Center, beside Commands and Activity,
showing what the viewed agent can see of shared team memory:

- Newest-first list; each row shows a **scope pill** (`project` / `agent`),
  a **kind pill** (`fact` / `preference` / `decision` / `outcome`), the
  **text**, and **who formed it** plus relative time.
- A **text filter** over data already in the view (matches text, kind or
  forming-agent, case-insensitive), with an `N of M match` counter.
- Rows the viewed agent itself formed get an **accent left border** and
  "*dev-api* formed it · 2h ago" wording; switching agents visibly moves
  which rows are "its" learnings.
- Two honest empty states: *no memories yet* (room has none) vs *nothing
  matches "<query>"* (filter too narrow). The counter hides when empty.

No semantic-search box — recall is BM25 (MEMORY.md) and a box labelled
"semantic" that does something else would be a lie in the UI.

## Method, and what was rejected

- **Rendered strictly from `room.memories`**, re-sorted newest-first
  client-side (the server already sends descending; the sort is defensive,
  not deciding). `textContent` everywhere; `innerHTML` never touches wire
  data. Missing field degrades via `?? []`.
- **The panel rebuilds on every websocket broadcast** (`renderCurrentView`
  runs on each `view` message), so filter text and focus are module state:
  typing survives a mid-word broadcast instead of resetting. On re-render
  only the list redraws per keystroke — redrawing the input would fight the
  caret.
- **Per-agent visibility**: rejected *grouping by agent* — the phase says
  newest first, and grouping would break that ordering. Rejected *hiding
  other agents' memories* — project scope is team-visible by definition
  (MEMORY.md: every agent in the room recalls it). Chose the accent +
  "formed it" marker: the list stays one honest newest-first set while
  still answering "which of these did *this* agent learn?".
- Scope/kind pills render whatever value arrives; an unknown future value
  gets an unstyled-but-honest pill rather than an exception.

## What I clicked, and what I saw

Driven in real Google Chrome (151, headless via CDP) using genuine
`Input.dispatchMouseEvent` / key events at element coordinates — not
console calls — with DOM assertions and screenshots inspected by eye:

With 5 real memories in the dev store (see "Environment honesty"):
- Clicked **dev-api** in the AI AGENTS roster → Command Center opened;
  tabs read **Commands · Activity · Memory**.
- Clicked **Memory** → 5 rows, newest first (35m-old pnpm preference on
  top, 50m-old billing failure second, then 2h, 1d, 3d); every row showed
  `PROJECT` + kind pill; dev-api's own 2 rows accented as "formed it".
- Clicked the filter, typed `pnpm` → narrowed to 1 row, counter read
  `1 of 5 match`; typed `outcome` → 2 rows (kind match works); typed
  `quantum-unicorns` → *"Nothing matches “quantum-unicorns”."*; cleared →
  all 5 back.
- Clicked **← All agents**, then **qa-api** → Memory tab still active,
  highlight moved to qa-api's own 2 rows ("qa-api formed it"), dev-api's
  rows plain. Same check for **docs** (1 own learning).
- Regression: **Commands** and **Activity** tabs still render; room-wide
  Team Memory nav view unaffected. Zero page exceptions during sessions.
- Full suite green twice in a row (21 assertions each).

Empty state (memories removed again): clicked dev-api → Memory → *"No
memories yet — they form as agents finish tasks…"*, no blank panel;
typing in the filter on an empty list stays honest; switching to qa-api
keeps the tab and the empty state.

**Could not reach:** an `agent`-scope pill from live data — see below.
Also unreached: >30 memories (view cap) and malformed timestamps
(they'd fall back to "—" / sort last; not producible from the real store).

**Pre-existing flake found, not fixed (not my layer):** the sidebar roster
rebuilds on every broadcast, so a click can be swallowed if a view lands
between mouse-down and mouse-up. My driver retried like a human would;
flagging it for whoever owns the shell.

## Environment honesty

- **HEAD's server did not boot when I started**: `apps/server/src/index.ts`
  imports `TriggerCreate/TriggerEnable/TriggerDelete` from
  `@logbridge/protocol`, but `packages/protocol/src/index.ts` doesn't
  re-export `./triggers.js`. Both files are Stream B's; I did not touch
  them and am not requesting a change — reporting per §2. To verify my
  work I bundled commit `c24a98e~1`'s `index.ts` (pre-trigger-wiring;
  triggers are irrelevant to Phase 1) into `/tmp` with esbuild against the
  otherwise-current working tree, and served the **real**
  `apps/web/index.html`, assets and dev DB on :8787. No repo file was
  modified to do this.
- The dev DB had zero memories, so I seeded 5 realistic ones straight into
  `apps/server/data.db` using `writeMemory`'s exact column shape (the FTS
  trigger fired as it does for server writes) and exercised the real
  pipeline: SQLite → buildView → socket → browser. Afterwards I deleted
  those 5 rows — **DB restored to 0 memories, as found**.

## From Stream B — nothing requested

`Room.memories` carries everything Phase 1 needs. One fact worth the
reviewer's attention, not a request: the view ships **project-scoped
memories only** (`apps/server/src/view.ts` filters agent scope out, which
MEMORY.md documents as deliberate). Consequence in the browser: every live
row reads `PROJECT`, the `agent`-scope style ships but is untestable
against real traffic, and "switching agents switches the list" holds via
header/highlight/wording while the row *set* is necessarily identical
across agents. If team-visible per-agent memory is ever wanted, that is a
contract decision, not a browser one.

## Git

Only `git add apps/web/index.html BROWSER-PHASE-1-RESULT.md`, `git commit`,
`git push origin main` — plus read-only `status`/`diff`/`log`/`show`. No
`add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`,
`rm`, `rebase`, `merge`, or `pull` was run at any point.
