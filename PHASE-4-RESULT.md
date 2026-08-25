# Phase 4 — Summon — Result

## What was built

“Call here” makes an idle agent walk to the caller’s current tile and stay until dismissed or it gets work. It exists as a button in the head-anchored popup (`Call here` / `Dismiss`) and in the Command Center header, and it works the same from both. It is a **real event through the server**: `POST /api/summon {agentId, x, y}` stores `summonedBy/At/Pos` on the agent row, appends a `summon` event, and broadcasts a new `WorkspaceView` so every browser sees the agent at the same summoned tile. Dismissing (`POST /api/summon/cancel`) or the agent receiving work (`status → working`, which clears the summon) returns it to its zone. The activity feed shows `called <agent> here` / `dismissed <agent>`. Summoning an offline or busy agent fails with a readable 409 (`machine is offline` / `agent is busy (working)`) rather than silently doing nothing. Work always wins: a summoned agent that is assigned a task snaps to its working pod within one view.

## Method chosen and what was rejected

**Chosen: server-authoritative summon stored on the agent row, rendered via `AgentView.summonedPos`.**

- **DB:** `agents` gains `summoned_by/At/X/Y` (`apps/server/src/db.ts:55`) with `ALTER TABLE` migrations, helpers `summonAgent`/`clearSummon`/`getSummon` (`apps/server/src/db.ts:638`), and `setAgentStatus` now clears summon when `status === 'working'` so work always wins.
- **Protocol:** `AgentView` gains optional `summonedBy/At/Pos` (`packages/protocol/src/view.ts:144`) — optional for the same reason as `provider`: older rows have `null` and a required field would blank the office. `CONTRACT.md` bumped `1.22 → 1.23` with changelog entry for the same.
- **View:** `buildView` (`apps/server/src/view.ts:146`) projects `summoned_*` into `AgentView.summonedPos`; validation still passes (`WorkspaceView.safeParse`). Second-browser determinism follows because summon is part of the shared view.
- **Server:** `POST /api/summon` and `POST /api/summon/cancel` (`apps/server/src/index.ts:155`) validate `agentId` exists, machine `online`, `status === 'idle'|'waiting'` else 409, bounds `0..64,0..46`, then `summonAgent` + `appendEvent(..., "summon", {agentId, agentName, by, x, y})` / `"summon.cancel"` + `broadcastView()`. Activity projection (`apps/server/src/activity.ts:74`) maps those types to `called <agent> here` / `dismissed <agent>`.
- **Client:** `positionForAgentWithRoaming` (`apps/web/index.html:1196`) checks `a.summonedPos` first (while still `idle`) and returns `summonedPos * TILE`; otherwise falls back to roaming/slot. Popup (`apps/web/index.html:610`, `apps/web/index.html:1275`) and Command Center header (`apps/web/index.html:716`) both show `Call here` vs `Dismiss` based on `summonedPos`, and call `doSummon`/`doDismissSummon` (`apps/web/index.html:2820`) which `fetch` the endpoints with `player.x/TILE, player.y/TILE` and surface the 409 error text inline (`#ap-summon-err`, `#cc-summon-err`). The head card’s CSS was switched to `pointer-events:auto` so the button is clickable, but the card stays 12 px above the head so it does not cover the agent’s hit area.

**Rejected:**

- **Local tween only:** animating `entry.target` on the caller’s browser would make the office a non-shared truth (B violation) and would never land in the feed. The “real event” requirement forces a server round-trip.
- **New zone or new map rect for summoned agents:** would need a fresh rect per summon location, which does not exist in `office.json`; an arbitrary `Point` overlay is the minimal honest extension.
- **ClientMessage `summon` over WebSocket:** already only 3 client message types (invariant 5, “everything else a human does goes through HTTP”); adding a socket type would mix concerns and bypass the existing HTTP error handling. HTTP also gives a clear `409` with a readable reason for busy/offline.
- **Clearing summon on any status change:** would lose the summoned position if the agent briefly went `needs_input` or `blocked`; instead only `working` clears, preserving “stay until work”.

## Decisions forced

- **Summon is idle-only.** `waiting` (which still maps to idle zone) is allowed; `working`/`reviewing`/`blocked`/`needs_human`/`done` are rejected with 409. This matches “summoning a busy agent fails” and keeps the “work always wins” invariant simple.
- **Tile coords, not pixels:** the player’s `position` messages are tile coords, and the office measures in tiles (`TILE=32`). Storing tile `x,y` keeps the protocol and DB aligned with existing `HumanView.position`.
- **Activity wording lives server-side** (same as `zone`): `summon` → `called <agent> here`, `summon.cancel` → `dismissed <agent>`; the browser only renders `ActivityItem.summary`.
- **No contract bump for `ClientMessage`:** summon stays on HTTP; the socket stays at 3 types per invariant 5.

## Test count

- **Before Phase 4** (at `17c7f91`): `packages/protocol` 42 tests (5 files), `apps/server` 153 (16 files), `apps/runner` 129.
- **After Phase 4**: `packages/protocol` **42** (unchanged — view fields are optional and `roaming.test.ts`/`anim.test.ts`/`popup.test.ts` still pass), `apps/server` **160 tests (17 files, +7 summon)**. All green: `packages/protocol: npx vitest run && npx tsc --noEmit`, `apps/server: npx vitest run && npx tsc --noEmit`, `apps/runner: npx vitest run`. New suite `apps/server/src/summon.test.ts:1` covers: summonedPos in view and second-browser visibility + contract validation, dismiss clears, work clears (zone → `working`), activity feed for `summon`/`summon.cancel`, endpoint 409 for busy/offline and for dismiss-when-not-summoned, and summon-stays-until-work-or-dismiss.
- `RUN_THRESHOLD_PX` / `directionFor` / `clampPopupPosition` remain 42 protocol tests; summon adds no new protocol tests beyond view validation.

## Revert-and-fail confirmation

Broke `buildView` to always `summonedPos: null` (ignoring the row):

```
expect(ag.summonedPos).toEqual({x:10,y:20}) // → Received null
```

`apps/server/src/summon.test.ts:1` went red: 1 failed / 6 skipped. Restored the `a.summoned_x != null ? {x:...,y:...} : null` mapping and the suite returned to 7/7 green (via `cp /tmp/view4.bak` restore).

## What was left untouched

- Did not change roaming or popup phases beyond the `summonedPos` precedence in `positionForAgentWithRoaming` and the `pointer-events` tweak for the button.
- Did not add a new `ZoneId` — summon is a position override, not a zone.
- Did not modify `apps/server/src/db.ts` trigger/migration infrastructure beyond the 4 summon columns; did not stage the other stream’s `apps/server/src/db.ts` trigger idempotency change or `apps/server/src/triggers.ts` event loop — those remain **unstaged**.
- Did not stage `packages/protocol/src/triggers.ts` (other stream) — still untracked.

## Files changed (staged)

- `apps/server/src/db.ts` — `agents` columns `summoned_by/At/X/Y`, alters, `summonAgent`/`clearSummon`/`getSummon`, `setAgentStatus` clears on `working` (`apps/server/src/db.ts:55`, `apps/server/src/db.ts:638`).
- `packages/protocol/src/view.ts` — `AgentView.summonedBy/At/Pos` optional (`packages/protocol/src/view.ts:144`).
- `apps/server/src/view.ts` — projects summon into `AgentView` (`apps/server/src/view.ts:146`).
- `apps/server/src/activity.ts` — `summon` / `summon.cancel` summaries (`apps/server/src/activity.ts:74`).
- `apps/server/src/index.ts` — `POST /api/summon` and `POST /api/summon/cancel` with 409 readable reasons and `appendEvent` + `broadcastView` (`apps/server/src/index.ts:155`).
- `CONTRACT.md` — version `1.22 → 1.23` and changelog for summon (`CONTRACT.md:4`).
- `apps/web/index.html` — `positionForAgentWithRoaming` summon precedence (`apps/web/index.html:1196`), popup summon row + CSS (`apps/web/index.html:497`, `apps/web/index.html:630`), `doSummon`/`doDismissSummon` (`apps/web/index.html:2820`), popup and CC header summon button wiring (`apps/web/index.html:1275`, `apps/web/index.html:1845`), `pointer-events:auto` for the card.
- `apps/server/src/summon.test.ts` — new, 7 tests.
- `PHASE-4-RESULT.md` — this file.

## How to verify

```bash
cd packages/protocol && npx vitest run && npx tsc --noEmit
cd ../../apps/server && npx vitest run && npx tsc --noEmit
# Two browsers, same idle agent: click agent → head card shows “Call here”, click it → agent walks to your tile in both browsers, card flips to “Dismiss”, feed shows “called <agent> here”.
# Assign it work (/debug/offer-task or orchestrator) → it snaps to working pod, summon cleared, view no longer has summonedPos.
# Dismiss → returns to roaming/idle zone.
# Try “Call here” on a working or offline agent → 409 with “busy”/“offline” shown inline in the card/CC header.
```
