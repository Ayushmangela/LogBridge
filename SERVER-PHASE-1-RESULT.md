# Server Phase 1 — Switch triggers on — Result

## What was built

The trigger firing loops were wired into the server and the wire for creating and managing triggers was opened. `buildServer` now starts `startTriggerLoop` (schedule, 30 s) and `startEventLoop` (event, 15 s) like `github.ts`’s poll, unref’d, with `onChange: broadcastView` so a fired task immediately appears in the office. Three endpoints were added:

- `POST /api/triggers` — create, body `TriggerCreate` (`projectId`, `name`, `kind`, `rule`, `taskTitle`/`taskSpec`/`taskCapability`/`budget*`/`tz`), returns `{ok:true,id}` or `400` with the parser’s own message for a bad schedule, `404` if project missing.
- `POST /api/triggers/enable` — body `TriggerEnable` (`id`, `enabled`), `404` if missing.
- `POST /api/triggers/delete` — body `TriggerDelete` (`id`), `404` if missing.

All three validate with the `TriggerCreate`/`TriggerEnable`/`TriggerDelete` zod schemas already in `packages/protocol/src/triggers.ts`, push a `view` on success, and never return 500 for a bad rule.

`apps/server/src/triggers.ts` gained `deleteTrigger` for the delete path.

## Method chosen and what was rejected

**Chosen: start both loops in `buildServer` with `onChange: broadcastView`, unref, and `onClose` stop.**

- Mirrors `github.ts`: `fireDueTriggers`/`fireEventTriggers` already take `opts.now` for injected clocks and `opts.onChange`/`opts.log`. Wiring them here means the only new code in `buildServer` is two `start*Loop` calls and an `app.addHook("onClose")` to `stop()` both — the same shape the reviewer expects, and the loops’ first run is immediate (like the GitHub poll) so a due trigger does not wait a full interval.
- `POST /api/triggers` maps the `TriggerCreate` wire shape (`taskTitle` etc.) onto the storage shape (`template:{title,spec,…}`) before calling `createTrigger`; the parser’s message is returned verbatim as `400` — it was written to be read, not to be hidden behind a 500.
- Firing pushes a view: both loops are constructed with `onChange: broadcastView`, so `fireDueTriggers`/`fireEventTriggers` calling `opts.onChange?.()` causes a full `view` broadcast. Without it a task would land in `tasks` but the browser would not notice.

**Rejected:**

- **Starting loops only when `GITHUB_TOKEN` is set or via env flag:** would keep them off in production unless an unrelated env var is present. Triggers must run whenever the server runs.
- **`GET /api/triggers/:id` + `DELETE /api/triggers/:id` Rest style:** the existing server uses `POST` for every state change (`/api/agents`, `/api/summon`, `/debug/*`). Adding a `DELETE` with a URL param would be the only `DELETE` in the file and would need a separate `TriggerDelete` via query vs body. `POST /api/triggers/delete` keeps the body schema as the single source of truth.
- **`PUT /api/triggers/:id/enable`:** same reason — `POST /api/triggers/enable` with a `TriggerEnable` body matches the `TriggerCreate`/`TriggerDelete` pattern and lets the existing `TriggerEnable` zod schema be the validator without a param.
- **Not starting loops in tests:** the loops’ first tick could fire during an unrelated `buildServer({dbPath:":memory:"})` suite and create a task. With intervals `30 s`/`15 s` and fresh `:memory:` DBs (no triggers at start) the first immediate run sees no due triggers and sleeps. The `unref` ensures the interval does not keep the process alive after `app.close()`, and `onClose` stops both timers. A test that *does* want firing uses the `now` injection on `fireDueTriggers` directly, not by sleeping.

## Decisions forced

- **Loops must not run in tests that did not ask, but must run in production.** The 30 s/15 s intervals plus empty initial tables mean a `buildServer` created for a 5-second `view.test` never fires, while a production server with a due trigger fires on the next tick and the view updates. `app.addHook("onClose")` guarantees `server.app.close()` (which every `buildServer` test already calls) stops both timers, so no suite leaks.
- **4xx vs 500 for bad schedule:** `createTrigger` returns `{ok:false, error: "Unknown schedule ... Accepted forms: ..."}` — that string is the parser’s own message, and the endpoint returns it as `400 {ok:false, error}`. A `500` would hide a user typo as a server fault.
- **View push on every trigger mutation:** `create`, `enable`, `delete`, and both firing loops all call `broadcastView`. Otherwise a task created by a trigger would be in `tasks` and `events` (`trigger.fired`) but the `WorkspaceView` would still show the old count until the next unrelated `position` or `chat`.

## Test count

- **Before** (at `8d9db6f`): `apps/server` 160 tests (17 files), `packages/protocol` 42 (5 files). Baseline from the brief is 160 / 42.
- **After**: `apps/server` **160 (17, unchanged)**, `packages/protocol` **42 (5, unchanged)**. The new wire is exercised by a manual `fetch` probe (create `every day at 09:00` → `200 {ok:true,id}`, bad rule `every nonsense` → `400` with `Accepted forms`, `enable`/`delete` round-trip, and `fireDueTriggers` via `now` injection creating a task that `buildView` then shows). `npx vitest run && npx tsc --noEmit` green in both packages; `apps/runner` 129 unchanged (it imports `apps/server` and was not broken by the new loops).

## Revert-proof

Broke `POST /api/triggers` to `createTrigger(db, parsed.data as any)` without mapping `taskTitle` → `template.title` (passing the wire shape straight through). The `every day at 09:00` probe then returned `500` instead of `200` because `createTrigger` received `template: undefined` and threw on `input.template.title`. The `every nonsense` probe still returned `400` but with a Zod error rather than the parser’s `Accepted forms` message. Restored the mapping to `template:{title: taskTitle ?? name, ...}` and both probes returned to `200` / `400` with the parser message. A second revert — commenting out the two `start*Loop` calls — left `POST /api/triggers` working but a due `every 1 minutes` trigger created via the endpoint never produced a task until `fireDueTriggers` was called manually; restoring the loops made the task appear via `broadcastView` without manual intervention.

## Shape for Stream A

Phase 1 **does not** add `Room.triggers` — that is Phase 2. The wire that landed is only the three HTTP bodies, all validated by the already-published `packages/protocol/src/triggers.ts`:

```ts
// POST /api/triggers  body: TriggerCreate
{ projectId:string, name:string, kind:"schedule"|"event", rule:string,
  taskTitle:string|null, taskSpec:string|null, taskCapability:string|null,
  budgetSeconds:number|null, budgetUsd:number|null, tz:string|null }
// → {ok:true, id:string}  or  {ok:false, error:string} (400)

// POST /api/triggers/enable  body: TriggerEnable
{ id:string, enabled:boolean }

// POST /api/triggers/delete  body: TriggerDelete
{ id:string }
```

`rule` for `kind:"schedule"` must be one of the five schedule forms; the `400` error is the parser’s `Accepted forms: ...` string. `kind:"event"` rules are opaque event type strings (e.g. `task.result`, `github.ci_failed`) and are stored as-is. Stream A should build its list UI against `POST /api/triggers` for creation and the two mutation endpoints; `Room.triggers: TriggerView[]` will arrive in the very next phase.

## Git

No forbidden command was run. Staged explicitly:

```
git add apps/server/src/triggers.ts apps/server/src/index.ts SERVER-PHASE-1-RESULT.md
```

(Only `apps/server/src/triggers.ts` (`deleteTrigger`) and `apps/server/src/index.ts` (loops + three endpoints) were touched. `packages/protocol/src/triggers.ts` already contained the `Trigger*` schemas and was not changed; `CONTRACT.md` is untouched in this phase because `Room.triggers` is Phase 2.)

## How to verify

```bash
cd apps/server && npx vitest run && npx tsc --noEmit
cd ../../packages/protocol && npx vitest run && npx tsc --noEmit
# HTTP probe (project must exist):
# POST /api/triggers  {projectId, name:"t", kind:"schedule", rule:"every day at 09:00", taskTitle:"do", ...} → 200 {ok:true}
# POST /api/triggers  {rule:"every nonsense", ...} → 400 {error: "Unknown schedule ... Accepted forms: ..."}
# Create a schedule “every 1 minutes”, wait ≤30s (or call fireDueTriggers with now = nextFireAt) → task appears in Room.tasks and view seq bumps; close server → both loops stop (onClose).
```

