# Browser Phase 3 — Import hire

**Stream A (browser).** One file changed: `apps/web/index.html`. No server,
protocol or doc file touched.

## What was built

The import path the Add Agent dialog's caption now states plainly:
**"Import hire…"** (dialog footer, left of Cancel) opens a `.json` manifest
and fills the wizard with it for review.

- **Every `TriggerCreate`-equivalent dialog field** lands in the form:
  name, role, machine (by name or `machineId`), project (by name or id),
  character sprite, colour, folder, isolation, provider, model,
  capabilities, cwd, allowTools, denyPaths, bypassPermissions,
  description, goal. Character/colour go through the real pickers; the
  command preview re-renders.
- **Nothing is created by importing** — the manifest is only a prefilled
  draft. The one path to a real agent stays the Create button's POST, the
  same as hand-typing. The import code contains no fetch at all.
- **A malformed manifest explains itself and changes nothing**: bad JSON
  quotes the parser's message; wrong-typed fields list *every* problem at
  once ("name" should be text…, "role" is "boss" — expected one of…, etc.)
  in the red block headed "Import failed — nothing was changed."
- **Unknown fields are ignored and named** ("ignored field this version
  doesn't know: fromSomeFutureVersion") — a manifest from a newer version
  still imports.
- **Review notes, not refusals, for context mismatches**: a machine or
  project the room doesn't have, a provider the machine doesn't run, a
  model the provider doesn't offer, an unknown sprite or off-palette
  colour — each becomes a bullet in the blue note; everything else still
  fills. The human decides.
- The caption now promises exactly what happens: *"Import hire… fills this
  dialog with it for review — nothing is created until you press Create
  agent."*

## Method, and what was rejected

- **The manifest is untrusted input and is treated as such**: parsed,
  type-checked field by field (strings, string lists, enums, boolean),
  unknown keys collected, all problems reported together — and on any
  problem the form is untouched, because the person may have half-filled it
  by hand first. Rejected fail-on-first-error (a human fixes everything at
  once, not one field per attempt).
- **Validation lives in the browser, not packages/protocol.**
  COMMAND-CENTER.md Phase 6 wants Zod-in-protocol; `packages/protocol/**`
  is another stream's file, so the equivalent checks are hand-rolled here
  (the page has no zod anyway). Flagged below for the reviewer.
- **Machine/provider/model suggestions yield to what the room actually
  has.** The dialog offers what the view carries; a manifest asking for
  something else is a note, never a silent substitution or a crash.
- `esc()` (textContent round-trip) on every manifest-derived string that
  reaches the note; the note is the only `innerHTML` site and never sees
  raw manifest text.

## What I clicked, and what I saw

Real Chrome (152, headless via CDP), genuine mouse/keyboard events; the
file was put on the real hidden `<input type="file">` via CDP's
`DOM.setFileInputFiles`, so the page ran its own change handler exactly as
after a native pick. **42 assertions, fully green twice in a row.** To make
spawn real, two minimal fake runners connect through the genuine TOFU
handshake (`hello` → `challenge` → Ed25519 `challenge-response`): one
`--allow-agent-creation` machine, one without.

- Good manifest (17 fields + one future-version field): import → blue note
  "Imported good.json — review every field. Nothing is created until you
  press Create agent." + the ignored-field note; every field verified
  filled (including lucy sprite, #8a63c9 swatch, provider opencode, model
  sonnet, live command preview). Agent count unchanged. Clicked **Create
  agent** → dialog closed, `imported-review` joined the roster — created
  ONLY on spawn.
- Broken JSON → red block: "Import failed — nothing was changed." + the
  JSON parser's own message; form still empty.
- Wrong types (`name: 42`, `role: "boss"`, `isolation: "quantum"`,
  `capabilities: 7`, `bypassPermissions: "yes"`, `goal: [...]`) → all six
  problems listed in one block; form still empty; no agent.
- Manifest naming `locked-box` (online, creation off): fills, machine
  selected, dialog shows its creation-off note; Create → the server's
  existing refusal verbatim: `"locked-box" has not enabled agent creation
  — start its runner with --allow-agent-creation`. No agent.
- Manifest naming `ghost-machine` (not in the room): blue note "machine
  ghost-machine is not in this room right now — pick one", the rest of the
  manifest still filled. No crash.
- Zero page exceptions in any session. Screenshots inspected by eye at
  every stage.

**Could not reach:** a server-side zod shape rejection (400) — the dialog
always sends a valid shape, so only parser/timezone-class refusals are
reachable from this UI.

## Environment honesty

- Verified against the real dev server (HEAD) and the real dev DB. The two
  fake machines and every agent my run created were removed afterwards —
  DB back to as-found (4 agents, 2 machines, 0 triggers, 0 memories). The
  append-only event log keeps the honest history.
- Harness note: background helper processes started from earlier tool calls
  died unpredictably between calls, so the verification script now spawns
  and reaps its own runners — runs are self-contained and repeatable.

## For the reviewer

- **Two server-side observations (not touched, not blocking):**
  1. `POST /api/agents` returns **500** when a machine row says `online`
     but no runner socket exists (stale flag — e.g. the server was killed
     while a runner was connected). `requestAgentCreate` trusts the column
     and then calls `.send` on a missing socket. Reproduced once; worked
     around in verification by correcting the row.
  2. The Command Center's machine list only includes machines that already
     have an agent in the room (view.ts scopes by `machineIdsInRoom`) — so
     a manifest naming a *brand-new* online machine is unselectable even
     though the machine exists. The import handles it as a review note;
     flagging only so the scoping is a known decision.
- **Zod-in-protocol** (COMMAND-CENTER.md Phase 6) remains unbuilt — the
  manifest schema lives in `apps/web/index.html` for now. If Stream B adds
  `AgentManifest` to the protocol, the browser validator should defer to it.

## Git

Only `git add apps/web/index.html BROWSER-PHASE-3-RESULT.md`, `git commit`,
`git push origin main` — plus read-only `status`/`diff`/`log`/`show`. No
`add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`,
`rm`, `rebase`, `merge`, or `pull` was run at any point.
