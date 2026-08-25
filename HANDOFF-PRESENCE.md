# Brief: agents that move — idle roaming, selection popup, and summoning

**Read §1–§4 before writing code. Build Phase 1, push, write its result file,
and stop.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI on its owner's machine. A browser
watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- The office is a Pixi.js renderer inside the single file `apps/web/index.html`
- Server: Fastify + WebSocket + SQLite in `apps/server`

Read first, in this order:

| File | Why |
|---|---|
| `DECISIONS.md` **D11** | The axiom this feature collides with. §3 is about it |
| `CONTRACT.md` invariant 2 | "The server decides, the office renders" |
| `apps/web/index.html` around `DIR_FRAMES` | Sprite frames — `idle` and `run`, four directions, six frames each. **The run animation already exists as data** |
| the render loop (`entry.target`, `ease`) | Agents already ease toward a target. You are extending this, not inventing it |
| `apps/server/src/view.ts` | `zoneFor` / slot placement — where agent positions come from today |

```bash
cd apps/server && npx vitest run && npx tsc --noEmit
cd apps/runner && npx vitest run && npx tsc --noEmit
```

---

## 2. What to build

Four things, in four phases:

1. **Idle roaming** — an agent with no task wanders instead of standing still.
2. **Running animation** — agents use the `run` frames while moving, facing
   the direction of travel. Today they hold a single static idle frame.
3. **Selection popup** — clicking an agent shows a small card *at its head* in
   the office with a few live details.
4. **Summon** — "come here" makes the agent walk to wherever the player is
   standing, and stay until it has work again.

---

## 3. ⚠️ Read this before designing anything

`DECISIONS.md` D11 is the project's **second axiom**:

> **Position is a pure function of state.** Agents are *placed*, never
> animated. **There is no code path that produces motion without an event, so
> fake activity is impossible to render.** *Would change it: nothing.*

Idle roaming is, on its face, exactly what that forbids: motion with no event
behind it. So this feature cannot be bolted on — it has to be reconciled, and
**how you reconcile it is the most important thing you will decide here.**

The reconciliation that appears to hold (argue for it, or argue for a better
one, in `PHASE-1-RESULT.md`):

- D11 exists so the office cannot **imply work that isn't happening**. An
  agent that wanders *because it is idle*, inside the idle zone, does not fake
  work — it depicts idleness accurately. The lie D11 guards against is an
  agent that looks busy while doing nothing.
- **Summoning is caused by a real user action**, so it is motion *with* an
  event and sits comfortably inside D11 — provided the summon is recorded like
  any other event, not just tweened locally.
- **The run animation** only ever plays while a sprite is actually travelling
  between two real positions. It adds no motion; it describes motion that the
  ease loop already performs.

Two hard constraints that follow, and that your tests must enforce:

**A. Roaming must never leave the idle zone.** An idle agent wandering into
the working area reads as working. That is the exact lie D11 forbids.

**B. Every browser must draw the same office.** `Math.random()` in the render
loop breaks invariant 2 — two people watching the same room would see
different things, and the office stops being a shared truth. Derive roaming
deterministically from data every client already has (the agent's id and a
shared clock), or have the server publish it. **State which you chose and
why.**

If you conclude D11 must actually be amended rather than reconciled, say so
plainly in your result file and propose the new wording. That is a legitimate
outcome. Quietly breaking it is not.

---

## Phase 1 — Roaming, deterministic and confined

- Idle agents drift within the idle zone instead of standing on their slot
- Identical on every client — no `Math.random()` in the render path
- An agent that stops being idle returns to its real placement immediately
- `DECISIONS.md` gets a short honest note on how this sits with D11

**Done when:** two browsers open side by side show the same agent in the same
place; an idle agent never renders outside the idle zone; giving it a task
snaps it back to its zone within one view update; suites green.

## Phase 2 — Running animation and facing

- While a sprite's distance to its target exceeds a small threshold, play
  `DIR_FRAMES.run[direction]`; otherwise `DIR_FRAMES.idle[direction]`
- Direction from the movement vector — the larger of |dx|,|dy| picks the axis
- Applies to **all** movement: roaming, zone changes, summoning
- No animation when a sprite is stationary; a running-on-the-spot agent is a
  worse bug than no animation

**Done when:** an agent moving between zones visibly runs and faces the right
way; a stationary agent shows a still frame; frame rate is stable with a dozen
agents on screen.

## Phase 3 — Selection popup at the head

- Clicking an agent shows a compact card anchored **above its sprite**,
  following it as it moves
- Contents: name, status, current task title if any, and its `note` when set
- Closes on: clicking elsewhere, pressing Escape, or the agent leaving the room
- Must not block clicking the agent underneath it

There is already a floating inspector panel and a full Command Center view.
**This is a third thing, and smaller than both** — a glanceable card, not a
panel. If it grows past ~4 lines you have built the wrong thing.

**Done when:** the card tracks a moving agent smoothly, survives a view
update without flickering, closes every way listed, and never renders off the
edge of the viewport.

## Phase 4 — Summon

- A "call here" action on the popup (and on the Command Center header)
- The agent walks to the player's current position and stays
- **This is a real event, not a local tween** — it goes through the server so
  everyone sees it, and it lands in the activity feed
- Releasing: the agent returns to its zone when it receives work, or when the
  caller dismisses it
- A summoned agent must still be **placed correctly the moment it gets a
  task** — work always wins over being summoned

**Done when:** summoning is visible in a second browser; the agent arrives at
the caller's position and stays; assigning it a task returns it to its zone;
the feed shows the summon; summoning an offline or busy agent fails with a
readable reason rather than silently doing nothing.

---

## 4. Process for this feature

Different from previous briefs — the repo owner has authorised it **for this
task only**:

1. **Build one phase. Then stop.** Do not start the next one.
2. **Push that phase to GitHub yourself** — `git add`, `git commit`, `git push`
   are permitted here, *only for the files this feature touches*. Never stage
   with `git add .` or `git add -A`: name every path explicitly, because other
   people's uncommitted work lives in this tree.
3. **Never run `git stash`, `checkout`, `restore`, `reset`, `clean`, `rebase`
   or `pull`.** A previous stream ran `stash → commit → stash pop` and moved
   another stream's uncommitted work; it vanished mid-edit. Those commands
   operate on the whole tree and do not respect file lists.
4. **Write `PHASE-N-RESULT.md`** in the repo root for each phase, and push it
   with the phase. It must contain:
   - what you built, in a few sentences
   - **the method you took, and what you rejected** — the reasoning matters
     more than the diff, because that is what gets reviewed
   - the decisions the phase forced, especially anything touching §3
   - test count before and after
   - confirmation you reverted a fix once and watched a test fail
   - anything you wanted to change outside this feature and did not
5. Then **stop and wait** for review before the next phase.

## 5. House rules

- **A test must fail without its fix.** Revert it, watch it go red, restore it.
- **Never `Math.random()` in a render path.** See §3B.
- **Comments explain *why*, not *what*.** Match the file you are editing.
- **Degrade, don't refuse.** A missing sprite sheet, an agent that vanishes
  mid-summon, a zone that isn't in `office.json` — fall back and log, never
  throw into the render loop. A thrown frame kills the whole office.
- **Report honestly.** Half-done reported as half-done is fine. A removed test
  reported as a passing suite is not.
