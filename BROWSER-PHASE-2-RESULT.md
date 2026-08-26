# Browser Phase 2 — Triggers tab

**Stream A (browser).** One file changed: `apps/web/index.html`. No server,
protocol or doc file touched. Stream B's phases 1–3 (loops, `Room.triggers`
in the view, create/enable/delete endpoints) were already landed when I
started — no gaps to report this time.

## What was built

A fourth **Triggers** tab in the Command Center (HANDOFF-TRIGGERS.md: "the
Command Center design has a `triggers` tab" — room-scoped data, but this is
the panel the design gives it):

- **Create form** covering every field of `TriggerCreate`: name, kind,
  rule, task title/spec/capability, budget seconds/USD. `projectId` comes
  from the live room, `tz` is sent `null` so the server resolves its own
  zone — the browser never guesses a timezone.
- **List** of the room's standing rules: name, kind pill, the rule in mono,
  what it creates (title/capability/budgets), **enabled** as an ON/OFF
  toggle, **last fired** ("never fired" when null), **next fires** (local
  short time; "off" for paused rows, "armed for \<event\>" for event kind —
  a paused trigger's stored slot is stale, so showing it would be a lie).
- **Enable/disable and delete** per row; delete needs a second click
  ("Delete" → "really?"), which survives re-renders.
- **Server errors verbatim**: the red line next to Create shows the
  response's `error` field exactly as it arrived — e.g. the parser's
  `"sprint" is not a weekday. Accepted forms: …`. Failures *before* the
  server (fetch threw, body unreadable) are labelled as such rather than
  dressed up as server rejections. Empty state: "No triggers yet — standing
  rules that create work on their own appear here."

## Method, and what was rejected

- **The server's broadcast is the only thing that updates the list.** The
  browser never edits its own copy: create/toggle/delete POST and the
  resulting `view` re-render does the rest. No optimistic updates.
- **Kind is two visible buttons (Schedule | Event), not a dropdown.** Two
  choices read better as a segmented pair, and — discovered while testing —
  a native `<select>` cannot be driven by real input events in headless
  Chrome at all. The button pair is the honest fix for both.
- **Draft, focus and delete-confirm survive re-renders** for the same
  reason the memory filter does: the panel rebuilds on every websocket
  broadcast, mid-typing included. After a successful create the whole panel
  redraws immediately — otherwise the form keeps its values until the next
  broadcast and reads as "did that even work?".
- **Local checks are layout help only** (blank name/rule get a nudge);
  everything real is decided server-side and shown verbatim. Rejected
  replacing server messages with "invalid input" — the phase forbids it and
  the parser's messages are the feature.
- `textContent` everywhere for wire data; `?? []` degrade if the field is
  ever missing; unknown kind values would render as an unstyled pill rather
  than throw.

## What I clicked, and what I saw

Real Google Chrome (151) driven over CDP with genuine
`Input.dispatchMouseEvent` / key events at element coordinates, DOM
assertions + screenshots inspected by eye. Full suite green **twice in a
row** (24 assertions each):

- Triggers tab on a fresh store → honest empty state.
- Typed *Morning triage* / `every day at 09:00` / task title, clicked
  **Create trigger** → row appeared: rule verbatim, ON, "next 09:00",
  "never fired", form cleared.
- Typed rule `every sprint at 09:00`, created → red line shows the
  server's exact sentence (with the Accepted-forms list); **no row**.
- Clicked ON → OFF: row greys, reads "off", no stale next slot; back to ON.
- Clicked **Event**, rule `task.result`, created → hint text switches to
  event wording; row reads "armed for task.result".
- Created `every 1 minutes` with a 600s budget → **waited ~60–90s: the
  trigger REALLY fired** — "fired 0s ago" appeared, and a real "Minute
  ping" task landed on the Tasks board (screenshot). End to end: browser →
  HTTP → parser → store → fire loop → task → broadcast → board.
- Deleted all three: each Delete first turned into "really?" and only the
  second click removed the row; empty state restored. Zero page exceptions.

**Could not reach:** server-side zod-shape rejections (400 with zod's JSON
message) — the form sends a valid shape, so I only ever saw parser/timezone
rejections, which are the ones a person can trigger from this UI. A bad
`tz` can't be produced either, since the form deliberately sends `tz: null`.

**Harness honesty, two findings:** (1) the sidebar/panel rebuilds on every
broadcast can swallow a click between press and release — my driver retries
like a human and the harness verifies what it typed, fixing truncation; the
underlying rebuild-race is the shell's render model, pre-existing, not this
tab's. (2) An earlier "all green" run of mine was fake: after checking the
board I never navigated back, so the delete clicks fired into a hidden
panel and one assertion was hardcoded true. Caught it on the screenshot,
fixed the harness (real navigation back, no hardcoded pass, clicks now
*throw* if their effect never lands) and re-ran everything for real.

## Environment honesty

- Verified against the real dev server (`npm run dev`, HEAD) and the real
  dev DB. Test triggers and the tasks my test trigger created were deleted
  through the UI / matching `creator_id` afterwards — DB back to **0
  triggers**; the pre-existing task and the append-only event log untouched
  (the log keeps honest "a trigger fired" history, as it should).

## From Stream B — nothing requested

`Room.triggers` and the three endpoints carried everything. One small
observation, not a request: `POST /api/triggers` returns the parser's
message with code 400 and zod's raw `error.issues` JSON for shape
violations — both display fine verbatim.

## Git

Only `git add apps/web/index.html BROWSER-PHASE-2-RESULT.md`, `git commit`,
`git push origin main` — plus read-only `status`/`diff`/`log`/`show`. No
`add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`,
`rm`, `rebase`, `merge`, or `pull` was run at any point.
