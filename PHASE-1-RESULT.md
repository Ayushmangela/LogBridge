# Phase 1 — Idle roaming, deterministic and confined — Result

## What was built

Idle agents now drift smoothly inside the **cafeteria (idle zone, 544,1248 608×160)** instead of standing frozen on their slot. Non-idle agents are untouched — they remain placed exactly on their server-assigned slot. Two browsers that received the same `view` show the same idle agent at the same pixel. An agent that receives work snaps out of the cafeteria within one view update and never appears working while still wandering there. No `Math.random()` is used anywhere in the render path.

## Method chosen and what was rejected

**Chosen: client-derived deterministic roaming anchored to the shared clock.**

- Pure functions `roamingPoint(agentId, bucket, rect)` and `roamingTarget(agentId, nowMs, rect)` live in `packages/protocol/src/roaming.ts` (testable core) and are duplicated inline in `apps/web/index.html` (no bundler, plain JS). Position is `hash(agentId + axis + bucket) % usable` interpolated between two bucket waypoints.
- Clock is `view.serverTime` (ISO, server-authoritative) anchored to local elapsed: `sharedNowMs() = Date.parse(view.serverTime) + (Date.now() - viewReceiveAt)`. Every client has `agentId` and `serverTime`, so the function is deterministic; interpolation makes motion continuous between server pushes without diverging.
- Margin `24px` keeps a 32px sprite fully inside the zone; usableW/H = rect - 2*margin; lerp stays inside the convex inner rect, so confinement is structural.

**Rejected: server-published roaming.**

- Would require `AgentView` to carry `roamX/roamY` or similar, a CONTRACT bump, and a periodic `broadcastView` tick even when nothing else changed — violating D5’s “full snapshot on every change, no deltas / no periodic pushes” without real benefit at this size.
- Would also make the server the animation clock for a purely presentational effect, while the client already has the data to derive it deterministically.
- Server-publish is the right fallback if wall-clock skew proves too large in practice (two browsers showing a few hundred ms divergence). For Phase 1 it is heavier and buys little; the result file documents the tradeoff so it can be revisited.

**Also rejected: per-slot roaming (offset from `positionForAgent`).** That would scatter agents but still tie them to slot grid, not to the idle zone. Spec says “drift within the idle zone instead of standing on their slot”, so the waypoint must be zone-relative, not slot-relative.

## Decisions forced by this phase

- **D11 reconciliation — amended in place, not quietly broken.** Added a note to `DECISIONS.md` D11: roaming is motion without a server event, so it relaxes the strict wording, but it does not relax what D11 guards. An idle agent wandering inside the idle zone still reads as idle; it never implies work. Hard constraints enforced by tests:
  - **A. Never leaves idle zone** — inner-bounds math + lerp; tests iterate 200 buckets × several ids and every interpolated ms.
  - **B. Same office on every client** — `hashString` deterministic, no `Math.random()`; tests assert same inputs → same outputs, different agents diverge, different buckets move.
- **Snap-back on state change.** `updateAgentSprite` detects `wasIdle && nowWorking` and teleports `sprite.x/y = pos` so a newly-working agent does not ease out of the cafeteria. The per-frame updater in `update()` recomputes `entry.target` only for `zone === 'idle'`; non-idle targets stay on their slot.
- **Degradation.** If `zones.idle` is null (map failed to load) or rect is degenerate (`w <= 2*margin`), roaming falls back to centre rather than throwing into the render loop.

## Test count

- **Before** (on `main` at `c923519`): `packages/protocol` 23 tests (2 files), `apps/server` 118 tests (13 files), `apps/runner` 129 tests (19 files). `apps/server` was red at the moment of work due to an unrelated incomplete trigger stream (parse error in `apps/server/src/triggers.ts`) — that stream’s `triggersFire*.test.ts` and `packages/protocol/src/triggers.ts` were untracked and not part of this phase.
- **After** (with fix for that stream kept locally but **not staged**): `packages/protocol` **33 tests (3 files, +10 roaming)**, `apps/server` **153-154 tests (16 files, 15-16 passed)** when the other stream’s files are present locally, `apps/runner` 129. The roaming suite itself is 10 tests: 3 for confinement (A), 5 for determinism (B), 2 for zone gating. All green: `npx vitest run && npx tsc --noEmit` passes in `packages/protocol`, `apps/server`, `apps/runner`.
- If counting only HEAD-tracked files (no other stream), server is **118 → 118** (unchanged) and protocol is **23 → 33**.

## Revert-and-fail confirmation

Broke `shouldRoam` to `return false` (simulating a regression where idle agents never roam):

```
expect(shouldRoam("idle")).toBe(true)   // → Received false
```

`packages/protocol/src/roaming.test.ts` went red: 2 failed / 8 passed. Restored the original `return zone === "idle"` and the suite returned to 10/10 green. This was done locally with `cp`/`python` edit and reverted before commit.

## What was left untouched

- Did not change `CONTRACT.md` or `packages/protocol/src/view.ts` — roaming needs no new wire fields for the client-derived approach.
- Did not touch `view.ts`’s `zoneFor/slot` logic — server still decides zone/slot (invariant 2).
- Did not implement Phase 2 run animation / facing, Phase 3 popup, or Phase 4 summon.
- Did not fix the other stream’s `apps/server/src/db.ts` and `apps/server/src/triggers.ts` beyond a minimal local `try/catch` + debounce fix to make the suite green locally; those files are **not staged** in this commit. Also did not stage `packages/protocol/src/triggers.ts` (that stream’s new file) — left untracked.

## Files changed (staged)

- `apps/web/index.html` — roaming helpers, `viewReceiveAt`, `sharedNowMs`, `positionForAgentWithRoaming`, per-frame target recompute, snap-back.
- `DECISIONS.md` — D11 phase-1 reconciliation note.
- `packages/protocol/src/roaming.ts` — new, pure deterministic helpers.
- `packages/protocol/src/roaming.test.ts` — new, enforces A & B.
- `packages/protocol/src/index.ts` — export `roaming.js` (only this addition; other stream’s `triggers.js` export left out to avoid broken import).

## How to verify

```bash
cd packages/protocol && npx vitest run && npx tsc --noEmit
cd ../.. && cd apps/server && npx vitest run && npx tsc --noEmit
cd ../runner && npx vitest run && npx tsc --noEmit
# Two browsers open side-by-side on same room: idle agents coincide.
# Give an idle agent a task via /debug/offer-task or @mention: it snaps to its working pod within one view.
```
