# Brief: Triggers — work that starts itself (stream B, multi-phase)

**Read §1–§3 before writing any code. Then build Phase 1 and stop.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI process (`claude`, `opencode`, …)
on its owner's own machine. A browser watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- TypeScript monorepo: `packages/protocol`, `apps/server`, `apps/runner`,
  `apps/web`
- Server: Fastify + WebSocket + SQLite (better-sqlite3)
- You work in **`apps/server`**, plus one new protocol file in Phase 4

Read before starting:

| File | Why |
|---|---|
| `apps/server/src/github.ts` | The closest precedent: a periodic loop that turns outside events into tasks. Copy its shape |
| `apps/server/src/db.ts` | `createTask`, `appendEvent`, the schema, and the `ALTER TABLE` migration list |
| `apps/server/src/orchestrator.ts` | What happens to a task once it exists — you create work, it routes it |
| `apps/server/src/plan.ts` + `planFlow.test.ts` | A feature built to this repo's standards recently. Match that bar |
| `DECISIONS.md` D9/D10 | Why polling, and why read-only integrations stay dumb |

```bash
cd apps/server && npx vitest run      # must stay green
cd apps/server && npx tsc --noEmit    # must stay clean
```

---

## 2. ⚠️ Two AIs are working in this repo right now

### Stream A (not you)

Building the **Command Center** UI — a per-agent detail view with tabs, the
Add Agent wizard, and the memory panel. Stream A owns:

```
apps/web/**                    packages/protocol/src/view.ts
packages/protocol/src/bodies.ts   packages/protocol/src/index.ts
apps/runner/**                 apps/server/src/view.ts
CONTRACT.md  README.md  MEMORY.md  PHASES.md  COMMAND-CENTER.md  PROVIDERS.md
```

**Stream A builds the triggers *tab*. You build the triggers *engine*.**
Do not write UI. Do not add a view field. Phase 4 tells you exactly where
your surface stops.

### Stream B (you)

Everything below, **one phase at a time**.

---

## 3. ⚠️⚠️ Rules that have already been broken once — do not repeat

### 3a. Never run a git command that changes the tree, index, or HEAD

A previous stream ran `stash` → `commit` → `stash pop` to tidy up before its
own commit. It moved the *other* stream's uncommitted work, which vanished
mid-edit and cost real time to diagnose. `git stash` does not read markdown
files and does not respect §2.

**Forbidden, no exceptions:**

```
git commit   git add     git stash    git checkout   git restore
git reset    git clean   git rm       git merge      git rebase
git pull     git push
```

**Allowed:** `git status`, `git diff`, `git log`, `git show`, `git blame`.

If the tree is dirty with files you did not write — that is Stream A.
**Leave it alone.** It is not your mess to clean, and cleaning it is exactly
the failure above.

### 3b. Stop at the end of each phase

Build one phase. Run the tests. Report. **Then wait.** The repo owner will
have Stream A verify it before you start the next one. Every phase must leave
the repo green and coherent on its own — never half of Phase 2 because you
could see where it was going.

### 3c. Cross-package test imports

`apps/runner`'s integration tests import `apps/server`. A syntactically broken
server file blocks the *other* stream's entire test run. Keep `db.ts` valid
between edits; do not leave it broken while you think.

---

## 4. The feature

Nothing in this repo schedules anything. Verify it yourself:

```bash
grep -ril "cron\|trigger" apps/server/src --include=*.ts   # only FTS triggers in db.ts
```

Tasks exist because a human typed one, a GitHub issue was mirrored, or a plan
was approved. **Nothing starts work on its own.** The product's own
architecture diagram promises otherwise — "KICK IT OFF FROM ANYWHERE: YOU ·
SLACK INBOX · TRIGGERS", and agents running 24/7 — and the Command Center
design has a `triggers` tab with nothing behind it.

A **trigger** is a standing rule that creates a task when a condition is met:

- *every weekday at 09:00* → "Triage overnight CI failures"
- *when CI goes red on main* → "Find and fix the failing test"
- *when a task fails twice* → "Investigate the repeated failure"

---

## Phase 1 — The schedule model (pure, storage only)

**Nothing fires in this phase.** Build the vocabulary and prove it, so the
loop in Phase 2 has something trustworthy underneath it.

- `apps/server/src/triggers.ts` (new)
- A `triggers` table: id, project_id, name, enabled, kind (`schedule` |
  `event`), the rule, the task template (title, spec, required capability,
  budget), created_at, last_fired_at, next_fire_at
- `parseSchedule(expr)` → a structured schedule or a clear error
- `nextFireAt(schedule, afterMs)` → the next firing instant, or null

**On the schedule language:** do NOT reach for a cron library. Pick the
smallest grammar that covers the three examples above, and reject everything
else with a message a human can act on. A rule nobody can read is worse than
a rule that only does five things. Whatever you choose, document its exact
grammar in `TRIGGERS.md`.

**Timezones are the trap.** "Every weekday at 09:00" means nine in the
morning where the person is, which is not UTC and shifts under DST. Decide
explicitly, write the decision down, and test the DST boundary. Silently
using UTC and calling it done is the failure mode here.

**Done when:** parsing round-trips, `nextFireAt` is correct across a DST
boundary and a month end, an invalid expression produces an actionable error,
the table migrates idempotently (see the `ALTER TABLE` list in `openDb` —
note it now rethrows anything that is not a duplicate-column error), and
`TRIGGERS.md` states the grammar and the timezone decision.

---

## Phase 2 — Firing (do not start until Phase 1 is verified)

The loop that turns due triggers into real tasks. Model it on
`github.ts`'s poll: a `setInterval` that `unref`s, plus an immediate first
run, returning a `stop()`.

Three decisions that are the whole difficulty — make each one deliberately
and write it into `TRIGGERS.md`:

1. **Double-firing.** Two ticks, or a restart mid-fire, must not create the
   task twice. `createTask` takes an `idem` key — use it.
2. **Catch-up.** The server was off for three days and a daily trigger was
   missed three times. Fire once, or three times? There is a right answer for
   *this* product; argue it in a comment.
3. **A trigger that fails.** A bad template, a deleted project. It must not
   take down the loop or every other trigger with it.

**Done when:** a controllable clock drives a trigger through several firings;
ticking twice at the same instant creates one task; a restart mid-window does
not duplicate; a broken trigger is disabled or skipped with a logged reason
while the others keep firing; every firing appends an event so the activity
feed can show it.

---

## Phase 3 — Event triggers (do not start until Phase 2 is verified)

Fire on things that happen, not on the clock. The event log already carries
everything you need — `task.result`, `github.ci_failed`, `lease.expired`.

- Subscribe to appended events rather than polling the table
- **Loop safety is the hard part:** a trigger that fires on `task.result` and
  creates a task will fire again when *that* task finishes. Make runaway
  loops structurally impossible, not merely unlikely, and say how in
  `TRIGGERS.md`
- Debounce: forty failing tests are one CI failure, not forty tasks

**Done when:** a real appended event fires a matching trigger; a
self-referential trigger provably cannot run away; a burst debounces to one
task; non-matching events cost nothing measurable.

---

## Phase 4 — The wire surface (do not start until Phase 3 is verified)

Where your work becomes visible. **This phase is deliberately narrow.**

- `packages/protocol/src/triggers.ts` — **a new file**, so you never edit
  `view.ts` or `bodies.ts`. Define `TriggerView` and the create/update/delete
  message bodies there
- Export it from `packages/protocol/src/index.ts` — **one line**. That is the
  only shared file you may touch, and only that line
- Server handlers to create, enable/disable and delete triggers

**Do NOT** add a field to `Room`, edit `view.ts`, or write any UI. Stream A
wires your types into the room view and builds the tab. Report the exact type
names you exported so they can.

**Done when:** a trigger can be created, disabled and deleted over the wire;
bad input is rejected by Zod with a usable message; `npx tsc --noEmit` is
clean in both `packages/protocol` and `apps/server`.

---

## 5. House rules

1. **No git writes.** §3a.
2. **Prove it against the real database.** Rows go in through the real
   functions and come back out through them. No hand-built arrays that only
   your code produces.
3. **A test must fail without your fix.** Revert it, watch it go red, restore
   it. You will be asked.
4. **Never test time with `sleep`.** Inject the clock. A test that waits two
   seconds to prove a schedule is both slow and a liar.
5. **Comments explain *why*, not *what*.** Read `plan.ts` for the voice.
6. **Report honestly.** Half-done reported as half-done is fine.

## 6. Report after each phase

1. What you built, in a few sentences
2. Test count before and after
3. The decisions this phase forced, and what you chose — especially the ones
   §4 names (timezone, catch-up, loop safety)
4. Confirmation you reverted a fix once and watched a test fail
5. Anything you wanted from Stream A's files but did not touch
6. A ready-to-paste `git add … && git commit -m "…"` — **do not run it**
7. Confirmation you ran no git command from §3a

Then **stop and wait** for verification.
