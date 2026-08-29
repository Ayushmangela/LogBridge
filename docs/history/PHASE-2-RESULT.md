# Phase 2 — Running animation and facing — Result

## What was built

Agents now visibly run when they are actually moving and face the direction of travel, otherwise they hold a still idle frame. The rule is `dist > 1.5px` → `run` else `idle`; direction is the larger of `|dx|,|dy|` (right/left vs up/down). It applies to every movement source the office already has: idle roaming waypoints (Phase 1), zone changes (slot placement), and future summoning — no special-casing. A stationary agent never shows a running frame.

## Method chosen and what was rejected

**Chosen: client-side threshold + axis rule, reusing existing sprite data.**

- `DIR_FRAMES.run` and `DIR_FRAMES.idle` already existed as data (four directions × six frames). No new assets; the renderer only decides which list to sample.
- Pure helpers in `packages/protocol/src/roaming.ts:82` (`RUN_THRESHOLD_PX=1.5`, `directionFor(dx,dy)`, `shouldRun(dist)`, `animFor`) — testable, no `Math.random()`. `directionFor` implements “larger absolute delta picks the axis; ties go vertical” (down if `dy>0` else up) to match the north-south corridor as default.
- Per-agent state added to `renderedAgents` entry (`apps/web/index.html:2526`): `direction:'down'`, `animTimer:0`, `frameIdx:0`, `char`. Created with `DIR_FRAMES.idle.down[0]` and updated via `updateAgentFrame(entry, dt)` (`apps/web/index.html:1195`).
- In the main `update(dt)` ticker (`apps/web/index.html:2871`): after recomputing roaming targets and easing positions, a new loop calls `updateAgentFrame` for every agent. It computes `dx = target.x - sprite.x`, `dy`, `dist = hypot(dx,dy)`, sets `moving = dist > RUN_THRESHOLD_PX`, updates `entry.direction` only while moving (so idle keeps last facing), picks `action = moving ? 'run' : 'idle'`, increments `animTimer` and flips `frameIdx` on `step = moving ? 0.08 : 0.20`, then swaps `sprite.texture` to `frames[ DIR_FRAMES[action][dir][frameIdx] ]`.
- Degrade: missing sheet or `DIR_FRAMES` entry falls back to `charTextures.nancy` / no-op, never throwing into the render loop.

**Rejected:**

- **Per-server facing:** having the server publish `facing` would duplicate the client’s already-authoritative target and add contract churn for a purely presentational concern. The client already knows `target` and `sprite` positions, so direction is derivable without extra wire data.
- **Velocity-based or normalized vector:** dividing by `dist` to get a unit vector adds math and a divide-by-zero near the target; the axis rule is cheaper and reads more clearly at 32px scale. Diagonal normalization would also imply 8-way facing, but sheets are 4-way.
- **Always-run when `target != slot`:** would animate an agent that has already arrived but is still easing the last pixel — the classic running-on-the-spot bug the brief calls “worse than no animation.” The threshold fixes this; without it an agent at `dist=0.3` would still run.
- **Separate roaming vs zone-change animation paths:** would double the code and risk drift. The helper is agnostic to *why* it moves; roaming, zone hops and summoning share `animFor`.

## Decisions forced

- **Threshold 1.5 px** — large enough to absorb easing’s asymptotic tail (which never reaches exactly 0) and small enough that a 3.5 s roaming hop (≈10–20 px per waypoint) clearly shows running. Tuned against `ease = 1 - 0.001^dt` which leaves ~0.5 px residual for many frames; 1.5 hides jitter while still showing motion for real travel.
- **Four-direction, six-frame, 0.08 s run / 0.20 s idle** — matches the player’s `0.05–0.09` run / `0.22` idle already in the file, so a dozen agents stay at 60 fps (only one texture swap per agent per step, not per tick).
- **No server change.** The animation describes motion the ease loop already performs; it adds no new position data, consistent with the Phase 1 D11 reconciliation (idle roaming depicts idleness; run frames describe real travel).

## Test count

- **Before Phase 2** (at `596b9a7`): `packages/protocol` 33 tests (3 files: `bodies`, `sealed`, `roaming`), `apps/server` 153 (16 files), `apps/runner` 129.
- **After Phase 2**: `packages/protocol` **38 tests (4 files, +5 anim)**, `apps/server` 153, `apps/runner` 129. All green: `npx vitest run && npx tsc --noEmit` in each package. The 5 new tests in `packages/protocol/src/anim.test.ts:1` cover: axis-picks-direction, threshold idle/run, `animFor` run vs idle with facing, no-running-on-the-spot (< threshold), and agnostic application to roaming/zone/summon.
- `npx vitest run src/anim.test.ts` was used to demonstrate determinism; the helper is pure and has no `Math.random()`.

## Revert-and-fail confirmation

Broke `directionFor` to `return "right"` (ignoring `dy`):

```
expect(directionFor(2,10)).toBe("down") // → Received "right"
expect(roaming.direction).toBe("down")   // → Received "right"
```

`packages/protocol/src/anim.test.ts` went red: 3 failed / 2 passed. Restored `if (Math.abs(dx) > Math.abs(dy)) …` and the suite returned to 5/5 green (procedure done via `cp`/`python` edit and `cp /tmp/roaming2.bak` restore).

## What was left untouched

- Did not change `CONTRACT.md`, `packages/protocol/src/view.ts`, or `apps/server/src/view.ts` — no new wire fields; server still decides `zone/slot`.
- Did not implement Phase 3 popup or Phase 4 summon.
- Did not modify `apps/server/src/db.ts` / `apps/server/src/triggers.ts` beyond the minimal local fix from Phase 1 to keep that stream’s suite green; those files remain **unstaged** and are not part of this commit.
- Did not add `packages/protocol/src/triggers.ts` export to `packages/protocol/src/index.ts` — kept the Phase 1 fix (only `roaming.js` export) to avoid a broken import on `main`.

## Files changed (staged)

- `apps/web/index.html` — `RUN_THRESHOLD_PX`, `directionForAnim`, `updateAgentFrame`, `createAgentSprite` anim init (`apps/web/index.html:2526`), per-frame animation loop (`apps/web/index.html:2897`).
- `packages/protocol/src/roaming.ts` — added `RUN_THRESHOLD_PX`, `directionFor`, `shouldRun`, `animFor` (`packages/protocol/src/roaming.ts:82`).
- `packages/protocol/src/anim.test.ts` — new, 5 tests.
- `PHASE-2-RESULT.md` — this file.

## How to verify

```bash
cd packages/protocol && npx vitest run && npx tsc --noEmit
cd ../../apps/server && npx vitest run && npx tsc --noEmit
cd ../runner && npx vitest run
# Open two browsers, same room: idle agents coincide and now run while drifting.
# Give an idle agent work (via @mention or /debug/offer-task): it runs toward its working pod facing the travel axis, then holds idle when it arrives.
# A stationary agent shows a still frame; no agent runs on the spot.
```
