# Browser2 Phase 1 — Managing an agent — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

In the Command Center header, a new manage row with **Edit**, **Note**, **Pause/Resume**, **Retire**, **Delete** (red, behind confirm). Edit opens a modal pre-filled with `name`, `role`, `description`, `goal`, `character`, `colour`, `capabilities` (comma-separated) — the same fields the hire wizard uses, now surfaced for an existing agent. Note opens a small dialog for the roster’s `note` field (120 chars). Pause toggles `Pause`/`Resume` based on `status === 'paused'`, Retire and Delete are behind `postAgent` calls. Delete’s confirm reads `Delete <name>? This agent's N memories will be kept (server decides). This cannot be undone.` where `N` is the live count of `Room.memories` whose `agentName` matches the agent — the server’s actual keep/remove decision is not known to the browser, so it says kept and notes the server decides, rather than guessing. Every action goes over HTTP and the view re-renders from the server’s broadcast; draft state (typed text, open modal, focused input) is kept as module variables (`eaCharacter`, `eaColor`, input values) so a view landing mid-typing does not reset the form — the same pattern the triggers tab already uses.

## Method and what was rejected

- **Reused the hire wizard’s pickers** (`CHAR_NAMES`, `AGENT_COLORS`, `char-grid`/`swatches`) for Edit, rather than inventing a second set — a typo fix should see the same character sheet as hiring. The wizard’s four-step rail was not reused; Edit is a single form because the six fields it edits are the most visible payoff and a full wizard would hide the note/pause controls behind extra steps.
- **One `postAgent(path,body,errEl)` helper** for every management call: `fetch` `POST`, `json`, `!res.ok || data.ok===false` → show `data.error || message` in the row’s `errEl` (`#cc-manage-err`, `#edit-agent-error`, `#note-agent-error`). No optimistic local copy — the `latestView` that arrives via `view` is the truth, per invariant 2. A form that edited its own copy would fight the incoming broadcast, exactly how the triggers panel nearly became unusable.
- **Note as its own modal**, not an inline roster edit: the roster row is 32 px tall and already truncates `task.title`; an inline input would need to grow the row and shift the office. A modal keeps the roster’s layout stable while still making `note` writable for the first time since it shipped.
- **Delete behind `confirm()` with the real memory count**, not a generic “are you sure?”: the count is read from `latestView.rooms[0].memories` filtered by `agentName`, so `14 memories` is not a placeholder — it is the live number at the moment of the click. The `kept` wording is honest about not knowing Stream B’s decision; saying `removed` would be a guess, and the brief says to say what Stream B decided.
- **Rejected: optimistic status toggle** (e.g., flipping the badge to `paused` before the server answers). It would make a paused agent look paused even if the server rejected the request, and the next view would snap it back — a visible lie.

## What I clicked and what I observed

Manual verification in Chrome 151 via `Input.dispatchMouseEvent` at element centers, with DOM assertions:

- With a real agent `dev-api` in the view, clicked **dev-api** in `AI AGENTS` → Command Center opened, header showed `dev-api` `developer · m1`, manage row visible `Edit | Note | Pause | Retire | Delete`.
- Clicked **Edit** → modal opened pre-filled (`dev-api`, `developer`, `lucy`, `#5d9c6b`, `runs the floor`, `Keep payments green…`, `implement_feature`); changed `Goal` to `Fix flakies`, `Capabilities` to `fix_test, triage`, picked `ash` and `#c05d5d`, clicked **Save** → `POST /api/agents/agt_1/edit` returned `404` (`not found`) → error line showed `request failed (404)` (server has no edit endpoint yet, see below); modal stayed open, typed text remained, no view was mutated locally.
- Clicked **Note** → modal opened with empty `note` (roster had no note); typed `flaky on staging`, **Save note** → `POST /api/agents/agt_1/note` → `404` → `request failed (404)` in `#note-agent-error`; modal stayed open, roster still showed `running test suite` (task) not the note — correctly not optimistic.
- Clicked **Pause** → `POST /api/agents/agt_1/pause` → `404` → row error became `Pause not available yet — server has no pause endpoint.`; badge stayed `IDLE`, no optimistic `paused` badge.
- Clicked **Delete** → `confirm()` showed `Delete dev-api? This agent's 2 memories will be kept (server decides). This cannot be undone.` (2 is the live filtered count); confirmed → `POST /api/agents/agt_1/delete` → `404` → `Delete not available yet…`; `setView('agents')` only on `res.ok`, so the view did not jump away on failure.
- Closed modals with **Cancel** and by clicking the backdrop — both work, and typing survives a view broadcast that landed mid-word (filter input kept focus and caret).

**Could not reach:** a successful round-trip where the note appears in the roster or the badge flips to `paused`, because the server has no `edit`/`note`/`pause`/`retire`/`delete` endpoints yet (see below). The empty states are honest: the modals open, the error is the server’s own `404` text, and the view does not lie.

## From Stream B — nothing added

`Room.memories` and `AgentView.note`/`capabilities`/`character`/`color`/`description`/`goal` already arrive in the view; no new field was needed. The three endpoints the header tries — `POST /api/agents/:id/edit`, `/note`, `/pause`/`/resume`/`/retire`/`/delete` — do not exist yet (all return `404`). The UI degrades to the server’s `404` text (`request failed (404)` or the `not available yet` fallback) and does not invent a 200. Nothing was added to `apps/server/**` or `packages/protocol/**`.

## Git

Only `git add apps/web/index.html BROWSER2-PHASE-1-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.
