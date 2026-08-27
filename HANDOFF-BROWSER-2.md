# Brief: Stream A — the browser (round 2, managing agents)

**Read §1–§4 first. Then work Phase 1 → 2 → 3 without stopping, pushing each
phase and writing its result file as you go. When Phase 3 is done, continue
to `HANDOFF-BROWSER-3.md`. Do not wait for review between phases.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI on its owner's machine. A browser
watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- **You work in exactly one file: `apps/web/index.html`.** Markup, CSS and JS,
  no bundler.
- The server pushes a full `view` on every change. You render it and never
  invent state.

Read first:

| File | Why |
|---|---|
| `FEATURE-INVENTORY.md` §2 and §3 | What is missing, and why the Command Center may be the wrong shape for most agents |
| `apps/web/index.html`, `renderCommandCenter` | The tab system you are extending |
| `packages/protocol/src/view.ts` | The exact shape you receive. **Read-only for you** |
| `CONTRIBUTING.md` | The working rules, short |

```bash
cd apps/server && npm run dev     # http://localhost:8787
```

There is no test runner for `index.html`. **You verify in the browser**, and
your result file records what you clicked and what you saw.

---

## 2. ⚠️ Three AIs are working on this repo

- **You (Stream A)** — the browser.
- **Stream B** — the server: `apps/server/**`, `packages/protocol/**`.
- **The reviewer** — verifies both, fixes bugs, owns the project docs.

### Yours

```
apps/web/index.html
BROWSER2-PHASE-1-RESULT.md  (and -2-, -3-)
```

### Not yours — do not edit, for any reason

```
apps/server/**   packages/protocol/**   apps/runner/**
CONTRACT.md  README.md  MEMORY.md  PHASES.md  DECISIONS.md  CONTRIBUTING.md
FEATURE-INVENTORY.md  COMMAND-CENTER.md  TRIGGERS.md  WORKSPACE.md
SERVER*-RESULT.md   PHASE-*-RESULT.md   HANDOFF-*.md
```

**Phases 1 and 3 depend on Stream B's endpoints.** If one is missing, build
the UI so it degrades honestly ("not available yet") and say so in your result
file. **Do not add the endpoint yourself.** Phase 2 has no server dependency
and can be built at any time.

---

## 3. ⚠️⚠️ Git rules — one of these has already cost a full feature

A previous stream ran `stash → commit → stash pop` to tidy the tree. It moved
**another** stream's uncommitted work; it vanished mid-edit and was
unrecoverable, because it had never been committed.

**Permitted, for your own file only:**

```
git add apps/web/index.html BROWSER2-PHASE-N-RESULT.md
git commit -m "..."
git push origin main
```

**Never:**

```
git add .   git add -A   git stash   git checkout   git restore
git reset   git clean    git rm      git rebase     git merge   git pull
```

**If `git push` is rejected, stop and report.** Do not pull or force.

If the tree is dirty with files you did not write, that is Stream B. Leave it.

---

## 4. Process for each phase

1. Build **one** phase. Then stop.
2. **Verify in a real browser — click the thing.** A function that works when
   called from the console proves nothing about whether clicking works. That
   exact mistake shipped two bugs here: a card that opened and closed on the
   same click, and one that rendered in the wrong corner. Both passed
   console-level checks.
3. Push it (§3).
4. Write **`BROWSER2-PHASE-N-RESULT.md`**: what you built · **the method and
   what you rejected** · **exactly what you clicked and observed**, including
   states you could not reach and why · anything you wanted from Stream B and
   did not touch · confirmation of §3.
5. **Do not wait.** Start the next phase immediately. After the last phase in
   this document, open **`HANDOFF-BROWSER-3.md`** and keep going.

---

## Phase 1 — Managing an agent

Depends on Stream B Phase 1. The product lets you hire and never manage.

In the Command Center header, add:

- **Edit** — name, description, goal, character, colour, capabilities
- **Note** — the roster already renders a note under every agent and there is
  **no way to write one**. It has been a dead field since it shipped. This is
  the smallest change with the most visible payoff
- **Pause / Resume**, and **Retire**
- **Delete**, behind a confirm. Whatever Stream B decided about memories on
  delete, **say it in the confirm** — "this agent's 14 memories will be kept /
  removed". Do not make people guess

**Optimistic updates are the trap here.** Everything goes over HTTP and the
server's broadcast re-renders the result. Do not edit your own copy of the
view — that is invariant 2, and a form that fights the incoming broadcast is
how the triggers panel nearly became unusable. Keep draft state and focus
across broadcasts, exactly as the triggers tab already does.

**Done when:** every field round-trips and survives a reload; a note appears
in the roster; a paused agent is visibly paused; delete confirms with the real
consequence; a failed request shows the server's own message.

## Phase 2 — Tasks tab, and the ask-me check

No server dependency.

- **Tasks tab** in the Command Center: that agent's tasks — current, queued,
  recent — from `Room.tasks`, which is already in the view
- **Then check `ask me` before building it.** The M4 mid-task question flow
  already exists end to end: an agent stops, asks the room, and continues on
  the answer. `FEATURE-INVENTORY.md` suspects the mockup's "ask me" is that
  same flow, unsurfaced. **Find out first.** If it exists, surface it — a
  second, parallel question inbox would be a genuine bug, not a feature

**Done when:** the tasks tab shows real tasks scoped to that agent and is
honestly empty otherwise; and your result file states plainly whether ask-me
is new work or a re-skin, with the evidence.

## Phase 3 — Steer, traces, and the employee panel

Depends on Stream B Phase 3 for steer.

- **Steer box** — one line of context injected into the agent's next task.
  **Label it for what it is.** It is not a terminal and must not look like
  one: the text lands in the next task's prompt, not in a running process
- **Traces tab** — that agent's tool calls and step boundaries, from
  `task.event` rows already logged. This is the honest, buildable part of
  "watch it work"
- **Consider the two-surface split** in `FEATURE-INVENTORY.md` §3: the
  reference gives the orchestrator a ten-tab console and each employee agent a
  small panel. Ours gives every agent the same tabs. **Recommend a shape in
  your result file — do not restructure unasked.** The reviewer owns that call

**There is deliberately no terminal tab in this brief.** Streaming a PTY to a
browser is a remote shell on someone's laptop, and this system still has no
sign-in (D23). Traces and steer deliver most of the value with none of that.

**Done when:** steering an agent visibly affects its next task; traces show
real tool calls; neither is presented as a live terminal.

---

## 5. House rules

- **Verify by clicking, not by calling.** §4.2.
- **Never `Math.random()` in a render path** — two people watching one office
  must see the same thing.
- **`textContent`, not `innerHTML`,** for anything off the wire.
- **Degrade, don't refuse.** A missing field or endpoint renders an honest
  empty state and logs. A thrown exception in the render loop kills the office.
- **Comments explain *why*, not *what*.**
- **Report honestly.** Half-done reported as half-done is fine.


---

## → Next

This document is finished when Phases 1–3 are pushed with their result files.
**Continue to `HANDOFF-BROWSER-3.md`.** Do not pause for review — the reviewer looks at the
whole chain once every document in this lane is done.
