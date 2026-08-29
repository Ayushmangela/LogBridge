# Server Phase 2 — Triggers in the view — Result

## What was built

`Room` now carries the standing rules that create tasks. `packages/protocol/src/view.ts:201` adds `triggers: z.array(TriggerView)` to `Room`, `apps/server/src/view.ts:146` projects it from `triggers` table (ordered by `created_at`, mapped to `TriggerViewT`), and `CONTRACT.md` is bumped `1.23 → 1.24` with a changelog row. `packages/protocol/src/index.ts:6` now re-exports `triggers.js` so the view import resolves and `WorkspaceView.safeParse` sees the new shape. A database with no triggers still validates — the projection returns `[]` — and a database with triggers round-trips through `WorkspaceView` without the gateway dropping the view.

## Method chosen and what was rejected

**Chosen: required `triggers: TriggerView[]` always present, projected as `[]` when empty.**

- `Room.triggers` is `z.array(TriggerView)` (not `.optional()`). `buildView` (`apps/server/src/view.ts:146`) does `SELECT * FROM triggers WHERE project_id = ? ORDER BY created_at` and maps every row to `TriggerView` fields (`id`/`projectId`/`name`/`enabled`/`kind`/`rule`/`taskTitle`/`taskSpec`/`taskCapability`/`budgetSeconds`/`budgetUsd`/`tz`/`createdAt`/`lastFiredAt`/`nextFireAt`/`lastEvtSeq`). When the table is empty the array is `[]`, so a DB written before triggers existed (pre-1.24) still has a value for the new field — no `undefined` ever reaches the gateway’s `ServerMessage.safeParse`, which would otherwise drop the *entire* `view` and blank every office.
- `TriggerView` itself lives in `packages/protocol/src/triggers.ts:10` and the view imports it as `import { TriggerView } from "./triggers.js"` (`packages/protocol/src/view.ts:2`), avoiding a circular via `index.ts`. `packages/protocol/src/index.ts` now `export * from "./triggers.js"` so both `view.ts` and `triggers.ts` consumers resolve.

**Rejected:**

- **`triggers?: TriggerView[]` optional:** would let `buildView` omit the field for old DBs, but then a viewer that expects `room.triggers` would need a fallback, and a missing field would be indistinguishable from a valid empty list. The gateway’s “send nothing on failure” rule makes a missing required field catastrophic, but a missing *optional* field is also a failure if the client assumes it is present. Always sending `[]` is the honest default.
- **`triggers: TriggerView[] | null`:** same problem — `null` would need a branch in every browser, and the server can always produce `[]` cheaply. No need for `null`.
- **Separate `GET /api/triggers` polling:** would make Stream A poll for triggers out-of-band from the view, duplicating the full-snapshot invariant (1). The view already pushes on every trigger mutation (`create`/`enable`/`delete` and both loops call `broadcastView`), so the view *is* the trigger list.

## Decisions forced

- **View push on every trigger write is now load-bearing for Stream A.** Phase 1’s `broadcastView` on `create`/`enable`/`delete` already ensured a task created by a trigger appears, but now the trigger *itself* must appear. The same `broadcastView` calls guarantee the `Room.triggers` array updates without a separate fetch.
- **No migration for the new field:** `Room.triggers` is not a column, it is a projection. Old DBs with a `triggers` table that predates `lastEvtSeq` or `tz` still map with `??` fallbacks (`lastEvtSeq: r.last_evt_seq ?? 0`, `tz: r.tz ?? null`), so no backfill is needed. This is why the field can stay required — the server fills it.
- **CONTRACT.md is the single source of wire truth:** bumped `1.24` and added `TriggerView` definition (`CONTRACT.md:49`) plus `Room.triggers` and a changelog row in the same commit as the code, so a reader who only has the contract still knows the shape.

## Test count

- **Before** (at `c24a98e`): `apps/server` 160 (17 files), `packages/protocol` 42 (5 files).
- **After**: `apps/server` **160 (17, unchanged)** — `view.test.ts`’s `WorkspaceView.safeParse(buildView(...))` still passes with `triggers: []` and with a DB that has triggers; a temporary revert (commenting out `triggers: roomTriggers,` in `view.ts`) made `view.test.ts` fail with `Required` on `triggers` (2 failed / 5 passed), restoring it returned to 7/7.
- `packages/protocol` **42 (5, unchanged)** — `view.ts`’s new import and `Room.triggers` are type-checked (`npx tsc --noEmit` green) and `Room`’s `TriggerView` is the already-tested `TriggerView` (23 trigger-parser tests present in the tree but not counted in the 42). The “no triggers yet” case was verified by building a view on a fresh `:memory:` DB and asserting `view.rooms[0].triggers.length === 0` and `WorkspaceView.safeParse` success, and by building a view after `createTrigger(..., every day at 09:00)` and asserting `length === 1`.

## Revert-proof

Broke `apps/server/src/view.ts:256` to `// triggers: roomTriggers,` (no `triggers` in the returned `Room`). `npx vitest run src/view.test.ts` went red:

```
ZodError: [{code:"invalid_type", expected:"array", received:"undefined", path:["rooms",0,"triggers"], message:"Required"}]
```

`view.test.ts:7` `2 failed`. Restored the `triggers: roomTriggers,` line and the suite returned to `7 passed`.

## Shape for Stream A

Phase 2’s wire that Stream A should build against is `Room.triggers` in `packages/protocol/src/view.ts:201`:

```ts
triggers: z.array(TriggerView)
```

where `TriggerView` (`packages/protocol/src/triggers.ts:10`) is:

```ts
{ id:string, projectId:string, name:string, enabled:boolean,
  kind:"schedule"|"event", rule:string,
  taskTitle:string|null, taskSpec:string|null, taskCapability:string|null,
  budgetSeconds:number|null, budgetUsd:number|null, tz:string|null,
  createdAt:string, lastFiredAt:string|null, nextFireAt:string|null,
  lastEvtSeq:number }
```

The view already pushes on `create`/`enable`/`delete` and on both firing loops, so no polling is needed. An empty `triggers` table yields `[]`, which is valid. Stream A’s list UI should read `room.triggers` directly.

## Git

No forbidden command was run. Staged explicitly:

```
git add packages/protocol/src/view.ts packages/protocol/src/index.ts packages/protocol/src/triggers.ts apps/server/src/view.ts CONTRACT.md SERVER-PHASE-2-RESULT.md
```

(Only the view, the protocol re-export, the trigger list helper, and the contract were touched.)

## How to verify

```bash
cd packages/protocol && npx vitest run && npx tsc --noEmit
cd ../../apps/server && npx vitest run && npx tsc --noEmit
# No triggers yet → view still valid:
# openDb(":memory:") → buildView → view.rooms[0].triggers === [] && WorkspaceView.safeParse ok
# With trigger:
# createTrigger(db, {projectId, name, kind:"schedule", rule:"every day at 09:00", template:{title:"do"}, tz:"UTC"})
# → buildView → room.triggers.length === 1 && room.triggers[0].rule === "every day at 09:00"
```
