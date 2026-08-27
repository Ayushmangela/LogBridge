# Brief: Stream B — the server (round 2, agent lifecycle)

**Read §1–§4 first. Then work Phase 1 → 2 → 3 without stopping, pushing each
phase and writing its result file as you go. When Phase 3 is done, continue
to `HANDOFF-SERVER-3.md`. Do not wait for review between phases.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI on its owner's machine. A browser
watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- **You work in `apps/server/**` and `packages/protocol/**`.** Nothing else.
- Fastify + WebSocket + SQLite. The server pushes a full `view` on every
  change; the browser only renders it.

Read first:

| File | Why |
|---|---|
| `FEATURE-INVENTORY.md` §2 | The gap you are closing, and why it matters more than another tab |
| `apps/server/src/index.ts` | `/api/agents`, `/api/summon`, `/api/triggers` — the shape to copy |
| `apps/server/src/nodeGateway.ts` | `agent.card`, and how the runner is asked to do things |
| `DECISIONS.md` D1, D2, D28 | Agents live on their owner's machine; offline means unreachable |
| `CONTRIBUTING.md` | The working rules, short |

```bash
cd apps/server && npx vitest run && npx tsc --noEmit
cd packages/protocol && npx vitest run && npx tsc --noEmit
```

Baseline: **203 server tests, 45 protocol tests** pass today. That number must
not go down.

---

## 2. ⚠️ Three AIs are working on this repo

- **You (Stream B)** — server and protocol.
- **Stream A** — the browser: `apps/web/index.html`, and only that.
- **The reviewer** — verifies both, fixes bugs, owns the project docs.

The split is **by layer, not by feature** — the only division with zero shared
files. It worked perfectly last round: six commits, zero collisions.

### Yours

```
apps/server/**   packages/protocol/**   CONTRACT.md
SERVER2-PHASE-1-RESULT.md  (and -2-, -3-)
```

### Not yours — do not edit, for any reason

```
apps/web/**   apps/runner/**
README.md  MEMORY.md  PHASES.md  DECISIONS.md  CONTRIBUTING.md
FEATURE-INVENTORY.md  COMMAND-CENTER.md  TRIGGERS.md  WORKSPACE.md
BROWSER*-RESULT.md   PHASE-*-RESULT.md   HANDOFF-*.md
```

**Stream A is waiting on your Phase 1.** They cannot build edit/retire/pause
controls until the endpoints exist. Ship it first and put the exact request
and response shapes in your result file.

---

## 3. ⚠️⚠️ Git rules — one of these has already cost a full feature

A previous stream ran `stash → commit → stash pop` to tidy the tree. It moved
**another** stream's uncommitted work; it vanished mid-edit and could not be
recovered, because it had never been committed. An entire implementation was
rebuilt from its tests.

**Permitted, for your own paths only:**

```
git add apps/server/... packages/protocol/... CONTRACT.md SERVER2-PHASE-N-RESULT.md
git commit -m "..."
git push origin main
```

**Never:**

```
git add .   git add -A   git stash   git checkout   git restore
git reset   git clean    git rm      git rebase     git merge   git pull
```

Name every path. **If `git push` is rejected, stop and report** — do not pull,
rebase or force. The reviewer resolves it.

`apps/runner`'s tests import `apps/server`, so a half-typed server file breaks
the other stream's entire test run. Keep shared files valid between edits.

---

## 4. Process for each phase

1. Build **one** phase. Then stop.
2. Both suites green, both typechecks clean.
3. **A test must fail without its fix.** Revert it, watch it go red, restore
   it. You will be asked — a previous stream deleted the test for its hardest
   requirement and reported a passing suite.
4. Push it (§3).
5. Write **`SERVER2-PHASE-N-RESULT.md`** and push it with the phase:
   what you built · **the method and what you rejected** · decisions forced ·
   test count before/after · confirmation of the revert-proof · **the exact
   shapes Stream A should build against** · confirmation of §3.
6. **Do not wait.** Start the next phase immediately. After the last phase in
   this document, open **`HANDOFF-SERVER-3.md`** and keep going.

---

## Phase 1 — Agent lifecycle: edit, note, pause, retire

Today an agent can be created and never changed, stopped, or removed.

- **`PATCH /api/agents/:id`** — name, description, goal, character, color,
  capabilities, and **note**
- **`POST /api/agents/:id/pause`** and `/resume` — a paused agent stays
  visible and keeps its memories but the orchestrator must not route work to
  it. **Check the orchestrator actually honours it** — a flag nothing reads is
  worse than no flag
- **`POST /api/agents/:id/retire`** — keeps memories and task history, takes
  no work, and can be brought back
- **`DELETE /api/agents/:id`** — actually removes it

**The decision this phase forces, and the reason it is not a formality:**
what happens to an agent's **memories** on delete? They are attributed by
agent name and other agents recall them. Deleting the rows loses team
knowledge the whole memory feature exists to accumulate; keeping them leaves
memories citing an agent nobody can find. **Decide, implement it, and write
the reasoning down.** Retire-vs-delete exists precisely so you have somewhere
to put the safe answer.

Two rules that are not optional:

- **The machine has the final say (D1).** Deleting an agent server-side while
  its runner still has it declared produces a split brain — the runner
  re-registers it on the next card. Tell the runner, or make the server
  authoritative and say which you chose.
- **`note` is browser-authored and must never ride `agent.card`.** A runner
  reconnecting would erase it, and reconnects are routine. There is already a
  regression test for this — do not break it.

**Done when:** each endpoint works and is tested; a paused agent provably
receives no routed work; deleting is decided and documented; a runner
reconnect does not resurrect a deleted agent or wipe a note.

## Phase 2 — Per-agent history and health

Every event is already in the log. Nothing surfaces it per agent.

- **`GET /api/agents/:id/history`** — that agent's past tasks with outcome,
  duration, and the events it produced. Paginated; a long-lived agent must not
  ship its entire history in one response
- **Health on `AgentView`** — last heartbeat, consecutive failures, and
  whether its machine is online. All three exist in the tables already
- Health is derived state, so it belongs in the view, not a second endpoint

**Watch the snapshot cost.** `broadcastView` re-sends the whole view on every
position message — a player walking does that continuously. Health fields are
small and fine; **history is not** and must stay on its own endpoint.

**Done when:** history returns real past tasks for a real agent, pages
correctly, and is empty-but-valid for a new one; health appears in the view;
the view does not measurably grow per task.

## Phase 3 — Steer, and move between projects

- **`POST /api/agents/:id/steer`** — inject a line of context into the agent's
  **next** task rather than typing into a terminal. This is the safe half of
  the terminal feature and most of its practical value. Reuse the existing
  task/prompt channel; do not open a shell
- **`POST /api/agents/:id/move`** — move an agent to another project, and
  **`/clone`** — copy its configuration into another project as a new agent

Moving forces a second real decision: memories are project-scoped. **Do the
agent's memories follow it, stay, or copy?** Argue it; there is no obviously
correct answer, only an answer that is written down.

**Done when:** a steered agent's next task visibly carries the injected
context; move and clone both work; the memory decision is implemented and
documented; an agent cannot be moved to a project that does not exist.

---

## 5. House rules

- **Prove it against the real database** — rows in and out through the real
  functions, never hand-built arrays.
- **Never sleep in a test to prove timing** — inject the clock.
- **Comments explain *why*, not *what*.** Read `plan.ts` for the voice.
- **Degrade, don't refuse.** A broken agent is disabled with a logged reason;
  it never takes down a loop or its peers.
- **No migration framework** (D7). New columns go in the `ALTER TABLE` list in
  `openDb`, which rethrows anything that is not a duplicate-column error. A
  backfill cannot live there — write it explicitly and idempotently.
- **Any view field fed by stored data must be optional or have a value for
  every existing row.** The gateway validates the whole view and sends
  *nothing* on failure — this blanked every office once.
- **Report honestly.** Half-done reported as half-done is fine.


---

## → Next

This document is finished when Phases 1–3 are pushed with their result files.
**Continue to `HANDOFF-SERVER-3.md`.** Do not pause for review — the reviewer looks at the
whole chain once every document in this lane is done.
