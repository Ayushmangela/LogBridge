# Phase 3 — Task and TaskAttempt: **verify, do not rebuild**

⚠️ **Read this section before writing any code.**

The deep-research report proposed splitting `Task` from `TaskAttempt`. It is
the right model and I endorsed it. **But it already exists.**

```sql
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  error_message TEXT,
  cost_usd REAL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

It is referenced in **8 non-schema files**, including `orchestrator.ts`,
`replanning.ts`, `contextBuilder.ts` and `deadLetter.ts`.

**Building it again would duplicate working code.** This phase is an audit.

## What to actually do

**1. Establish whether it is wired or ornamental.** The schema existing and
being queried is not the same as the state machine being honoured. Check:

- Does a failed task actually create attempt 2, or does something overwrite
  attempt 1?
- Does `attempt_number` increment correctly under concurrency?
- Is `state` a closed set, or free-form strings that have drifted?

**2. Check the retry-class distinction.** The report's sharpest point: a crash
retry, a rejected review, and a reassignment are *different* failures and must
not share one `max_attempts` counter. Verify whether the existing code
distinguishes them. My guess is it does not — that nuance is easy to miss.

**3. Check idempotency.** `attempt_id` is the natural key. Does replaying the
same attempt double-apply work? `createTask` already takes an `idem` key
(added when the trigger loops were rebuilt); see whether attempts use the same
discipline.

**4. Only then, fill gaps.** Write the missing tests first — a test that fails
against current behaviour is how you prove a gap is real rather than assumed.

## What to be suspicious of

1. **A schema built by one stream and half-used by another.** Several tables
   here were added during unattended work. Confirm the code paths agree with
   the columns; `artifacts.summary` and `exit_code` may be written by nobody.
2. **Silent state drift.** If `state` is a TEXT column with no constraint,
   check what values actually appear:
   `SELECT DISTINCT state FROM task_attempts`. Reality beats the enum you
   expect.
3. **The "REWORK" temptation.** The report is right: a rejection should open a
   *new attempt*, not add a state. If you find a REWORK state, that is a
   finding worth reporting rather than extending.

## Done when

You can state, with evidence, which of these is true:

- the model is fully wired and honoured → **say so and move on**
- it is wired with specific gaps → **list them, fix the ones that matter**
- it is ornamental → **say that clearly**; it is a bigger finding than any fix

Do not report "Phase 3 complete" without answering that question.
