# Brief: memory quality (parallel stream B, round 2)

**Read this whole file before writing code. It is self-contained.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI process (`claude`, `opencode`, …)
on its owner's own machine. A browser watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- TypeScript monorepo: `packages/protocol`, `apps/server`, `apps/runner`,
  `apps/web`
- Server: Fastify + WebSocket + SQLite (better-sqlite3). You work in
  **`apps/server`** only.

Read before starting:

| File | Why |
|---|---|
| `MEMORY.md` | What shared memory claims to do, and what it admits it does not |
| `apps/server/src/db.ts` | `writeMemory`, `recallMemories`, `recentMemories` — your whole surface |
| `apps/runner/src/agentMemory.test.ts` | How memories get written today. Read only — do not edit |

```bash
cd apps/server && npx vitest run      # must stay green
cd apps/server && npx tsc --noEmit    # must stay clean
```

---

## 2. ⚠️ Two AIs are working in this repo right now

### Stream A (not you) — Phase 2, "Engine"

Expanding the agent-CLI registry: more providers, per-provider model lists, a
live command preview, and a permissions gate. Stream A owns:

```
apps/runner/**            (all of it)
apps/web/index.html
packages/protocol/**
```

### Stream B (you) — memory quality

Everything below. **`apps/server` only.** You will not write UI, will not
touch the runner, and will not change the protocol.

---

## 3. ⚠️⚠️ What went wrong last round — read this twice

The previous parallel round produced working code from both streams, but one
incident nearly cost a stream its work.

**What happened:** Stream B finished, and — to get a clean tree for its own
commit — ran git commands that moved other people's uncommitted work:
a `stash`, a commit, then a `stash pop`. Stream A's in-progress changes
vanished from the working tree for several minutes. Stream A saw its files
revert mid-edit, spent real time diagnosing a phantom data loss, and the
commit that resulted swept in half of Stream A's uncommitted work.

Nothing was ultimately lost. It still must not happen again.

**Why prose ownership was not enough:** you shared one working tree and one
git index with another agent. `git stash`, `git checkout -- .`, `git restore`
and `git commit -a` all operate on *the whole tree*. They do not read this
document, and they do not respect the file list in §5.

### The rule that follows

> **Never run a git command that changes the working tree, the index, or
> HEAD.**

Specifically **forbidden**, with no exceptions and regardless of how convenient:

```
git commit      git add        git stash       git checkout
git restore     git reset      git clean       git rm
git merge       git rebase     git pull        git push
```

**Allowed** (read-only, useful for orientation):

```
git status      git diff       git log        git show      git blame
```

The repo owner does every commit personally. When you finish, hand them a
ready-to-paste command and **do not run it**.

If your tree looks dirty with files you did not write — that is Stream A
working. **Leave it alone.** It is not your mess to clean, and cleaning it is
precisely the failure above.

---

## 4. What to build

Two defects, both in `apps/server/src/db.ts`.

### 4a. Dedup only catches byte-identical text

```sql
CREATE UNIQUE INDEX idx_memories_dedupe
  ON memories (project_id, scope, IFNULL(scope_id, ''), text);
```

`writeMemory` inserts with `ON CONFLICT DO NOTHING`, so re-learning a fact is
a no-op. But the index is on raw `text`, so all of these are separate rows:

```
use pnpm, not npm
Use pnpm, not npm
use pnpm not npm.
  use pnpm, not npm
```

This mattered little when the only writer was the runner emitting one
`Completed: <title>` per task. It matters now: agents volunteer their own
memories (the `REMEMBER:` convention), so the same fact arrives repeatedly,
phrased slightly differently each time, from every agent that learns it.
Recall returns at most 100 rows — near-duplicates crowd out real knowledge.

**Build:** a normalised dedup key — lowercase, collapse whitespace, strip
trailing punctuation, trim. Store it in a `dedupe_key` column and move the
unique index onto that, keeping the original `text` exactly as the agent
wrote it for display. Backfill existing rows.

Watch out: two genuinely different facts must not collapse. `"deploy on
Friday"` and `"never deploy on Friday"` differ by one word and must stay two
rows. Normalisation is about *formatting*, never meaning.

### 4b. Nothing ever ages

`MEMORY.md` states it plainly: nothing ages memories out, merges them, or
notices that two contradict. A memory from six months ago ranks identically
to one from this morning.

**Build:** recency weighting in `recallMemories`, blended with the existing
BM25 relevance so an old-but-exact match still wins over a recent-but-vague
one. Do **not** delete anything — this is ranking, not eviction. Losing a fact
because it got old is worse than ranking it slightly low.

### What NOT to build

- **Semantic / embedding search.** Blocked: no embedding model is available.
  Recall is BM25 and `MEMORY.md` says so honestly. Do not add a similarity
  function that pretends otherwise.
- **Contradiction detection.** Needs judgement this layer does not have.
- **Any change to what memory *looks like* in the browser.** That is view
  shape, which is Stream A's protocol.

---

## 5. File ownership — binding

**Yours:**

```
apps/server/src/memory.ts        (new — put the normalisation + ranking here)
apps/server/src/memory.test.ts   (new)
apps/server/src/db.ts            writeMemory / recallMemories / the memories
                                 schema + index ONLY
```

**Not yours. Do not edit, for any reason:**

```
apps/runner/**
apps/web/**
packages/protocol/**
apps/server/src/view.ts          apps/server/src/nodeGateway.ts
apps/server/src/index.ts         apps/server/src/activity.ts
CONTRACT.md  README.md  MEMORY.md  PHASES.md  COMMAND-CENTER.md
```

`MEMORY.md` is on the forbidden list even though it documents your feature —
Stream A maintains it and will update it from your report. Tell them what
changed; do not edit it.

If you believe you need a forbidden file, **stop and say so in your report.**
That is an interface question for both streams, not something to resolve by
editing.

---

## 6. House rules

1. **No git writes.** See §3. This is the one that broke last round.
2. **Prove it against real data, not fixtures you invented.** Write real rows
   through `writeMemory` and read them back through `recallMemories`. Do not
   assert against a hand-built array that only your code produces.
3. **A test must fail without your fix.** Revert the fix, watch it go red,
   restore it. You will be asked whether you actually did this.
4. **Comments explain *why*, not *what*.** Read `db.ts` for the voice.
5. **Report honestly.** Half-done is fine to report; half-done reported as
   finished is not.
6. **Migrations:** there is no migration framework (D7). New columns go in the
   `ALTER TABLE` list in `openDb`, which now rethrows anything that is not a
   duplicate-column error. A **backfill** cannot be expressed there — write it
   as an explicit, idempotent step and say so in your report.

---

## 7. Done means

- [ ] `use pnpm, not npm` / `Use pnpm not npm.` / `  use pnpm,  not  npm `
      collapse to one row; `deploy on Friday` and `never deploy on Friday`
      stay two
- [ ] The stored `text` is still exactly what the agent wrote — normalisation
      affects the key, never the display
- [ ] Existing rows are backfilled, and running it twice is harmless
- [ ] Recall blends recency with BM25; an old exact match still beats a recent
      vague one, proven by a test
- [ ] Nothing is ever deleted
- [ ] `cd apps/server && npx vitest run` green, `npx tsc --noEmit` clean
- [ ] `git status` shows nothing from the "not yours" list — check it, do not
      act on it

## 8. When you finish

Report:

1. What you built, in a few sentences
2. Test count before and after
3. The normalisation rule, stated precisely, and the near-miss pair you used
   to prove it does not over-collapse
4. Confirmation you reverted a fix once and watched a test fail
5. What `MEMORY.md` now says wrongly, so Stream A can correct it
6. A ready-to-paste `git add … && git commit -m "…"` command — **do not run it**
7. Confirmation you ran no git command from the forbidden list in §3
