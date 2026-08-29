# Phase 3 — Selection popup at the head — Result

## What was built

Clicking an agent now opens a small head-anchored card that follows the sprite as it roams or changes zones. The card shows `name`, lower-cased zone/status, the current task title when present, and the human `note` when set — at most 4 lines, typically 2–3. It closes on clicking elsewhere (any pointerdown outside an agent), pressing `Escape`, or the agent leaving the room. It is `pointer-events: none` so it never blocks clicking the agent underneath, and it is clamped to stay fully inside the `office-card` viewport. Content survives view updates without flicker.

## Method chosen and what was rejected

**Chosen: HTML overlay positioned from PIXI global coordinates, clamped, pointer-events none.**

- **DOM:** `<div id="agent-popup" class="agent-popup">` inside `.office-card` (`apps/web/index.html:610`), width `176px`, `pointer-events:none`, `display:none` until `.open`. Four inner divs `#ap-name`, `#ap-status`, `#ap-task`, `#ap-note`. CSS keeps it glanceable; JS hides task/note when absent to keep line count low (`apps/web/index.html:1275`).
- **Positioning:** Each tick `updateAgentPopupPosition()` (`apps/web/index.html:1295`) gets `entry.sprite.getGlobalPosition()` (accounts for `worldContainer` scale and camera), converts renderer pixels to CSS pixels via `resolution`, offsets to the card’s coordinate space (`cardRect` vs `canvasRect`), then places the head at `cssY - 36*zoom`. `clampPopupPosition(anchorX, anchorY, popupW, popupH, vpW, vpH)` (`apps/web/index.html:1270`, mirrored in `packages/protocol/src/roaming.ts:108`) centers horizontally and clamps to `8px` margin on all sides — never off-screen.
- **Lifecycle:** `selectedAgentId` global (`apps/web/index.html:1263`). `openAgentPopup(a)` sets it, calls `updateAgentPopupContent(a)` and `updateAgentPopupPosition()`, hides the large `.inspector`. `closeAgentPopup()` clears it. `renderView` (`apps/web/index.html:1430`) closes if the selected id vanished from `seenAgents`, otherwise refreshes content from the fresh `room.agents` entry so a task title change does not flicker the card away. `update()` (`apps/web/index.html:3030`) calls `updateAgentPopupPosition()` every frame so roaming is tracked smoothly.
- **Close handlers:** `setupInput` (`apps/web/index.html:2930`) adds `Escape` → `closeAgentPopup()` before view-switch logic, and a `window pointerdown` that closes when the click target is outside both popup and inspector. Agent sprites call `e.stopPropagation()` on `pointerdown` (`apps/web/index.html:2564`), so clicking an agent does not reach the window handler and the card stays open; clicking empty floor reaches it and closes.

**Rejected:**

- **Reusing the 290 px `.inspector` panel:** it is 290 px, shows elapsed/cost/description + Command Center link — far past 4 lines and anchored at `left:12px;bottom:54px`, not at the head. Repurposing it would break the “glanceable, not a panel” requirement. The inspector is kept untouched for legacy use; the head card is a new, smaller element.
- **PIXI.Text overlay inside the sprite:** bubbles already live there; adding a 4-line card as PIXI would need Bundled text wrapping and would not benefit from HTML’s ellipsis and CSS clamping. HTML also gives free `pointer-events:none` handling.
- **Server-driven popup state:** the card is a view concern; the server already sends `name/status/task/note` in `AgentView`, so deriving content client-side keeps invariant 2 intact and avoids an extra message type.
- **Click-through via `pointer-events:auto` + close button:** a close button would need hit-testing and would block the agent underneath. `pointer-events:none` is the correct primitive for “must not block clicking the agent”.

## Decisions forced

- **Content limit:** `popupLines` in protocol caps at 4; HTML hides empty `task`/`note` rows. A card showing name+status+task+note is 4 lines max; showing only name+status when idle keeps it to 2.
- **Viewport clamping:** 8 px margin on the `office-card` (not window) so the card never spills off the floor, even when the agent roams near the cafeteria’s edge or the camera is zoomed. Tested over all corners of an 800×600 and 1024×768 viewport.
- **Escape precedence:** `Escape` closes the head card before it switches the view back to `office` — a user who opened a card and then hit Escape expects the card to go away first, not to be ejected from Chat.

## Test count

- **Before Phase 3** (at `6c7642c`): `packages/protocol` 38 tests (4 files), `apps/server` 153 (16 files), `apps/runner` 129.
- **After Phase 3**: `packages/protocol` **42 tests (5 files, +4 popup)**, `apps/server` 153, `apps/runner` 129. All green: `packages/protocol: npx vitest run && npx tsc --noEmit`, `apps/server: npx vitest run && npx tsc --noEmit`. New suite `packages/protocol/src/popup.test.ts:1` covers: centered vs edge clamping, never-off-screen for any anchor in 1024×768, `popupLines` name+status/task/note and 4-line cap, and the pointer-events documentation claim.
- `clampPopupPosition` is pure (no DOM, no `Math.random()`) — the web copy duplicates the same math.

## Revert-and-fail confirmation

Broke `clampPopupPosition` to `x = anchorX` (no clamp):

```
expect(p.x).toBeGreaterThanOrEqual(8) // → Received 0
```

`packages/protocol/src/popup.test.ts` went red: 2 failed / 2 passed. Restored the `Math.max(margin, Math.min(...))` math and the suite returned to 4/4 green (via `cp`/`python` edit and `cp /tmp/roaming3.bak` restore).

## What was left untouched

- Did not change `CONTRACT.md`, `packages/protocol/src/view.ts`, or `apps/server/src/view.ts` — popup needs no new wire fields.
- Did not implement Phase 4 summon (call-here action, server event, activity feed).
- Did not modify `apps/server/src/db.ts` / `apps/server/src/triggers.ts` beyond the minimal local fix from Phase 1 to keep that stream’s suite green; those files remain **unstaged**.
- Did not stage `packages/protocol/src/triggers.ts` (other stream’s file) — still untracked.

## Files changed (staged)

- `apps/web/index.html` — CSS `.agent-popup` (`apps/web/index.html:497`), HTML `#agent-popup` (`apps/web/index.html:610`), JS `selectedAgentId`, `clampPopupPosition`, `updateAgentPopupContent`, `updateAgentPopupPosition`, `openAgentPopup`/`closeAgentPopup`, `inspectAgent` now opens head card (`apps/web/index.html:2673`), `renderView` close/refresh (`apps/web/index.html:1430`), `update` per-frame follow (`apps/web/index.html:3030`), `setupInput` Escape + pointerdown close (`apps/web/index.html:2930`).
- `packages/protocol/src/roaming.ts` — added `clampPopupPosition` and `popupLines` (`packages/protocol/src/roaming.ts:108`).
- `packages/protocol/src/popup.test.ts` — new, 4 tests.
- `PHASE-3-RESULT.md` — this file.

## How to verify

```bash
cd packages/protocol && npx vitest run src/popup.test.ts && npx tsc --noEmit
cd ../../apps/server && npx vitest run && npx tsc --noEmit
# Open two browsers, same room: click an agent → head card appears, follows while it roams, stays in card bounds at edges.
# Update task title (via view) → card text updates without flicker.
# Click elsewhere, hit Escape, or remove the agent (stop its runner) → card closes. Card never blocks clicking the agent underneath.
```
