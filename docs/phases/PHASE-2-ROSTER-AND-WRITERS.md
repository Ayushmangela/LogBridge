# Phase 2 — a roster you can trust, and one writer per file

Small phase. Both problems are real, observed, and cheap to fix.

## Problem 1 — the roster lies

In the samsung hive:

- `registry.json` lists `agt_7f6a3c1d` (sam), `agt_94bcb8f3` (ram),
  `agt_b793523e` (commander)
- `fleet.json` lists `agt_b793523e` and `agt_scout01`

`agt_scout01` **is not in the registry**. Sam and ram — the only two workers —
**are not in fleet**. Every `tokens` and `cost` field reads `0`.

The commander's protocol tells it to read `fleet.json` to monitor the floor.
It is monitoring a fiction. A monitoring file that is wrong is worse than none,
because it is trusted.

**Fix:** `fleet.json` becomes a **projection**, regenerated from
`registry.json` plus live process state. Never hand-maintained, never a second
source of truth. If it cannot be derived, it should not exist.

This is the same failure shape as `ProviderInfo.command` earlier in this
project: two places holding the same fact, drifting apart. The rule that came
out of it applies here — **derive, do not duplicate**.

## Problem 2 — the sole-scribe rule is only prose

`board.md` says god is the sole scribe. Nothing enforces it. Two agents edited
the same files and `board.md` itself records the result: *"two design systems
collided … CSS now matches markup … duplicate const removed; duplicate
theme-toggle removed"*.

That reconciliation was manual work caused entirely by a missing guard.

**Fix:** enforce at the router. A message asserting a write to a god-owned
path is refused with a readable reason. The refusal goes back to the sender so
it can adapt, and to the office so the human sees it happened.

## Design notes

**Where to enforce.** The router is the only chokepoint every message passes
through. Do not try to enforce inside agents — an agent that misbehaves is
exactly the case you are guarding against.

**What "god-owned" means.** Start with an explicit list (`board.md`,
`tasks.json`, `registry.json`, `fleet.json`). Do not invent a general
permission system; three agents do not need one.

**Refusing is not enough on its own.** If an agent is told "you may not write
board.md", it needs a path that works — message god and let god write. Make
sure the refusal says so, or you have replaced a collision with a deadlock.

## What to be suspicious of

1. **Deriving `fleet.json` from stale process state.** If an agent's process
   died, does the projection notice? Prefer "unknown" over a confidently wrong
   `active`.
2. **Path comparison.** `board.md` vs `./board.md` vs an absolute path are the
   same file. Normalise before comparing, or the guard is trivially bypassed
   by accident.
3. **Breaking god.** God legitimately writes `board.md`. The guard must key on
   *who* is writing, and god's id comes from `registry.json` — which is one of
   the files being guarded. Watch that circularity.

## Done when

- `fleet.json` cannot disagree with `registry.json`, because it is generated
  from it.
- A non-god agent's attempt to write `board.md` is refused with a reason it
  can act on.
- God can still write `board.md`.
- The office shows a refusal when one happens — silent enforcement is how you
  get a confused agent looping.
