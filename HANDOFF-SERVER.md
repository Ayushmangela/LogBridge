# Brief: Stream B — the server

**Read §1–§4 before writing code. Build Phase 1, push it, write its result
file, and stop.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI on its owner's machine. A browser
watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- **You work in `apps/server/**` and `packages/protocol/**`.** Nothing else.
- Fastify + WebSocket + SQLite (better-sqlite3). The server pushes a full
  `view` on every change; the browser only renders it.

Read first:

| File | Why |
|---|---|
| `apps/server/src/triggers.ts` | The feature you are switching on. `fireDueTriggers`, `fireEventTriggers`, `startTriggerLoop`, `startEventLoop` all exist and are tested |
| `TRIGGERS.md` | Its grammar, timezone decision, and what each mode costs |
| `apps/server/src/index.ts` — `buildServer` | Where services are constructed. `github.ts`'s poll is the precedent for a loop |
| `CONTRACT.md` invariants 1 and 2 | Full snapshot on every change; the server decides |
| `CONTRIBUTING.md` | The working rules, short |

```bash
cd apps/server && npx vitest run && npx tsc --noEmit
cd packages/protocol && npx vitest run && npx tsc --noEmit
```

Both must be green before you push. 160 server tests and 42 protocol tests
pass today — that is your baseline, and it must not go down.

---

## 2. ⚠️ Three AIs are working on this repo

- **You (Stream B)** — the server and the protocol.
- **Stream A** — the browser: `apps/web/index.html`, and only that.
- **The reviewer** — verifies both streams, fixes bugs, owns the project
  docs. Not building features.

The split is **by layer, not by feature**, because that is the only division
with zero shared files.

### Yours — nobody else edits these

```
apps/server/**            packages/protocol/**
CONTRACT.md               (you are the only stream that changes the wire)
SERVER-PHASE-1-RESULT.md  (and -2-, -3-)
```

### Not yours — do not edit, for any reason

```
apps/web/**            apps/runner/**
README.md   MEMORY.md   PHASES.md   DECISIONS.md   COMMAND-CENTER.md
TRIGGERS.md   WORKSPACE.md   CONTRIBUTING.md
PHASE-1-RESULT.md … PHASE-4-RESULT.md   (a previous stream's, keep them)
BROWSER-PHASE-*.md     HANDOFF-*.md
```

**Stream A is waiting on your Phase 1 and 2.** They cannot list triggers until
your endpoints and `Room.triggers` exist. Ship those first and say in your
result file exactly what shape landed, so they can build against it.

---

## 3. ⚠️⚠️ Git rules — one of these has already cost a full feature

A previous stream ran `stash → commit → stash pop` to tidy the tree before
committing. It moved **another** stream's uncommitted work, which vanished
mid-edit and could not be recovered — it had never been committed, so git had
no copy. That was the trigger firing loops. They were rebuilt from their tests.

**Permitted, for your own paths only:**

```
git add apps/server/... packages/protocol/... CONTRACT.md SERVER-PHASE-N-RESULT.md
git commit -m "..."
git push origin main
```

**Never, under any circumstance:**

```
git add .    git add -A    git stash    git checkout    git restore
git reset    git clean     git rm       git rebase     git merge    git pull
```

Name every path you stage. `git add .` would sweep in Stream A's work in
progress and commit it half-finished under your message.

**If `git push` is rejected** because the remote moved, **stop and report it.**
Do not pull, fetch-and-rebase, or force. The reviewer resolves it.

Also: `apps/runner`'s tests import `apps/server`. A syntactically broken
server file blocks the **other** stream's entire test run, so keep shared
files valid between edits rather than leaving them half-typed.

---

## 4. Process for each phase

1. Build **one** phase. Then stop.
2. Both suites green, both typechecks clean.
3. **A test must fail without its fix.** Revert it, watch it go red, restore
   it. You will be asked whether you actually did this — a previous stream
   deleted the test for its hardest requirement and reported a passing suite.
4. Push it (§3).
5. Write **`SERVER-PHASE-N-RESULT.md`** and push it with the phase:
   - what you built, in a few sentences
   - **the method you took and what you rejected** — the reasoning is what
     gets reviewed, more than the diff
   - the decisions the phase forced
   - test count before and after
   - confirmation of the revert-proof in step 3
   - **the exact shape Stream A should build against**, if this phase changed
     the wire
   - confirmation you ran no forbidden git command
6. **Stop and wait** for review.

---

## Phase 1 — Switch triggers on

The whole triggers feature is built, tested, and **completely unreachable**:
`startTriggerLoop` and `startEventLoop` are never called, and no endpoint
creates a trigger. Nothing fires; nobody can make one. Verify it yourself:

```bash
grep -rn "startTriggerLoop\|startEventLoop" apps/server/src --include=*.ts | grep -v test
```

- Start both loops in `buildServer`, modelled on `github.ts`'s poll — `unref`
  the timer, and return a stop so tests and shutdown can end them
- `POST /api/triggers` (create), enable/disable, delete — validate bodies with
  the `TriggerCreate` / `TriggerEnable` / `TriggerDelete` schemas that already
  exist in `packages/protocol/src/triggers.ts`
- A rejected schedule returns the parser's own message and a 4xx, not a 500.
  That message was written to be read by a person
- Firing must push a view update, or a task appears in the database and the
  office does not notice

**Two things to get right, both of which have bitten this feature already:**
its loops must not run in tests that did not ask for them (an interval firing
during an unrelated suite is a maddening flake), and `buildServer` is used by
`apps/runner`'s integration tests too — do not make it slower or noisier for
them.

**Done when:** a trigger created over HTTP fires on the loop and its task
appears in the room; a bad rule returns a readable 4xx; closing the server
stops both loops; both suites green.

## Phase 2 — Triggers in the view

Stream A cannot render what the view does not carry.

- Add `triggers` to `Room`, shaped as the already-defined `TriggerView`
- Project it in `view.ts` from the stored rows
- Bump `CONTRACT.md` and add a changelog row **in the same commit**

**One rule that is not optional here.** The gateway validates the whole view
and, on failure, **sends nothing** — a required field with no value on disk
blanks every office for every viewer until each producer reconnects. That has
happened once. Any field you add that is fed by stored data must be optional
or have a value for every existing row. Test it against rows written before
your change.

**Done when:** a room's triggers appear in the view; a database with no
triggers still produces a valid view; the contract documents the shape; your
result file tells Stream A the exact field name and type.

## Phase 3 — Every state traces to a real event

An unchecked box on `PHASES.md`'s MVP list, and the invariant the whole office
rests on: *"Every state in the office traces to a real event in the log."*

- Enumerate every state the office can render — each agent status, each zone,
  each activity line, each badge
- For each, prove it derives from a logged event or from stored state the
  server owns, with a test
- Where something does **not** trace, say so plainly rather than forcing it

**The interesting case is idle roaming**, which is motion with no event behind
it, reconciled under D11 on the grounds that wandering-while-idle depicts
idleness rather than faking work. Judge it honestly: either it satisfies the
claim, or the claim needs rewording. Both are acceptable answers; pretending
is not. Recommend the wording — the reviewer owns `PHASES.md` and will apply it.

**Done when:** each renderable state is accounted for; the ones that trace have
tests; the ones that do not are listed with a recommendation.

---

## 5. House rules

- **Prove it against the real database.** Rows go in and come back through the
  real functions. No hand-built arrays that only your code produces.
- **Never sleep in a test to prove timing.** Inject the clock — `triggers.ts`
  already takes `now()` for exactly this.
- **Comments explain *why*, not *what*.** Read `plan.ts` for the voice.
- **Degrade, don't refuse.** A broken trigger is disabled with a logged
  reason; it never takes down the loop or its peers.
- **No migration framework** (D7). New columns go in the `ALTER TABLE` list in
  `openDb`, which rethrows anything that is not a duplicate-column error. A
  backfill cannot be expressed there — write it explicitly and idempotently.
- **Report honestly.** Half-done reported as half-done is fine.
