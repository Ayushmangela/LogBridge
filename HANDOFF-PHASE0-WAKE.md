# Phase 0 — make dispatch actually arrive

**For whoever continues this.** This is not a requirements list. It is how I
am thinking about the problem, why the design is what it is, and what I would
be suspicious of. Read §1–§3 before writing code; they are the reasoning that
makes the rest obvious.

Context: `PLAN-AGENT-SYSTEM.md` (the plan), `AGENT-ARCHITECTURE.md` (the
diagnosis), `research/` (six papers).

---

## 1. The mental model — get this right and the code writes itself

### 1.1 Agents are processes, not services

This is the thing everything else follows from.

`claude -p "..."` runs a turn and **exits**. `opencode run` does the same. They
are not servers. They do not sit in a loop checking a mailbox. There is no
"agent" running between tasks — there is a folder on disk with that agent's
name on it, and sometimes a process.

Almost every multi-agent design you will read (including the good ones)
assumes long-lived actors with inboxes. That assumption is why this system is
broken: someone built a mailbox for a recipient that does not exist to check
it. The router faithfully moves JSON into `inbox/` and **no one is home**.

So: a message is not something an agent *receives*. **A message is a reason to
run an agent.** Once you hold that, "wake on delivery" stops being a feature
and becomes the only thing that could ever have worked.

### 1.2 There are exactly two verbs

A message reaches a CLI agent in one of two ways, and there is no third:

| Verb | When | Cost | Preserves context? |
|---|---|---|---|
| **inject** | a PTY session is live | cheap | yes — same conversation |
| **spawn** | no session, machine online | cold start | no — fresh context, message becomes the prompt |

Everything in Phase 0 is deciding which verb to use and making sure exactly
one of them happens.

### 1.3 Why `say` + payload, and not one or the other

The product is a virtual office. The human must *watch colleagues talk*:

```
sam → ram   hey, finished the card layout — can you check the contrast ratios?
ram         on it
```

But agents acting on prose is where multi-agent systems fail — MAST's
"communication breakdown" category, and this project already lived it ("two
design systems collided", in `board.md`).

So one message carries both: `say` for the room, typed fields for the
recipient. **The mental shortcut is a git commit** — the message describes,
the diff *is*. You read one; the machine applies the other.

The load-bearing rule: **`say` is never authoritative.** If prose and payload
disagree, payload wins. That means a loosely-worded sentence can produce a
confusing line but never a wrong action. Without that rule you have two
sources of truth, which is worse than prose alone.

---

## 2. Where the code goes, and why there

I looked for the seam rather than inventing one. It already exists.

`HiveManager` takes an `onMessage(msg, fromId, toId)` callback, fired from
`deliver()` for inter-agent messages. `index.ts` currently uses it only to
emit a sequence event.

**That callback is Phase 0's entire insertion point.** Delivery already
happens there; we are adding "and then tell somebody".

Why not inside `hive.ts`? Because `HiveManager` is a file-mover. It should not
know about PTY sessions, the agent DB, or chat. Keeping the wake in `index.ts`
— where `db`, `ptyGateway` and `broadcastChat` are all in scope — keeps the
router honest and testable. Resist the urge to pass the world into
`HiveManager`.

### The decision tree

```
message delivered to <toId>
        │
        ├─ recipient's machine offline? ──► record `undeliverable`, leave the
        │                                   file in inbox, post nothing.  (D28)
        │
        ├─ live PTY session for <toId>? ──► INJECT a one-line notice
        │
        └─ otherwise ─────────────────────► SPAWN with the message as prompt
```

Then, in all delivered cases: **post `say` to room chat** so the office shows
the conversation.

### Three things to get right

**Idempotency.** The router runs every 1.5s over a directory. If delivery and
wake are not idempotent you will spawn the same agent repeatedly for one
message. Key the wake on the message id and record that it fired. This project
already learned this lesson in triggers, where a debounce that only held
within one tick leaked one task per tick forever.

**Do not wake on an empty move.** Wake only when a file was actually moved for
that agent. Three agents woke to empty inboxes in one transcript and asked the
human what to do — that is real money for nothing.

**Waking is execution.** Spawning runs code on someone's machine. It must sit
behind the same authorisation as any other spawn, and it must respect D28: an
offline machine gets `undeliverable`, never a silent drop and never a queued
promise the system cannot keep.

---

## 3. What I would be suspicious of

Written down because these are the ways I expect this to go wrong.

1. **A spawn storm.** Agent A messages B, B's spawn messages A, and the floor
   catches fire. The triggers subsystem already solved this shape with
   *provenance* — a task created by a trigger cannot fire that trigger again.
   Apply the same idea: a wake caused by agent X's message should not
   immediately wake X back. If you only do one safety thing, do this.
2. **The `say` going missing.** An agent that omits it makes the office silent
   — the exact failure being designed against. Generate a fallback from the
   type (`"sam sent ram a REVIEW_REQUEST"`), never post nothing.
3. **Double delivery on restart.** Files persist. If the server restarts
   mid-route, does the message get delivered and woken twice? It must not.
4. **The prose being trusted.** The moment any code reads `say` to decide
   something, the design is broken. `say` is for eyes only.
5. **Chat flooding.** Every agent message posting to the room will drown human
   conversation fast. Cap `say`, and consider collapsing consecutive
   machine-ish lines in the UI. This is why Phase 4 (artifacts by reference)
   matters — without it agents paste diffs into chat.

---

## 4. How to verify — and this is the part that gets skipped

Unit tests will not tell you this works. The failure being fixed is precisely
one where every test passed while the system did nothing.

**The real test is end to end, with real agents:**

The samsung project at `/Users/ayush/project_test/samsung/` has three
registered agents (god, sam, ram) and is currently doing nothing. That is the
fixture. Success is:

> god dispatches a task to sam. **Sam starts working with no human touching
> anything.** The room shows a line from god to sam in plain English.

If that does not happen, Phase 0 is not done, whatever the tests say.

Also verify the negative cases, because they are where the honesty lives:

- recipient's machine offline → `undeliverable` recorded, nothing spawned
- same message routed twice → one spawn, not two
- agent omits `say` → room still shows a line
- message to an agent with a live session → injected, not respawned

---

## 5. State of play

**Already true (verified in code, do not rebuild):**

- `parseMention` in `gateway.ts` parses `@sam do the thing` and creates a task
  assigned to sam, then posts a `Proposed: … Approve to run it?` chat with
  approve/edit/reject. So the human path is half-built — it creates work but
  never starts anyone.
- `HiveManager.deliver()` writes to `inbox/` and fires `onMessage`.
- `ptyGateway.ts` can write into a live PTY (`proc.write`), and the runner
  exposes `AgentHandle.answer()`. **Both wake mechanisms already exist and
  neither is connected to the hive.**
- Sessions are enforced (`sessions.ts`); `/pty-ws` is gated. Waking must not
  route around that.

**Not true, despite the prompts saying so:**

- `hive.ts` contains zero occurrences of `wake`/`notify`/`inject`, but
  `index.ts`'s `onMessage` did call `submitPromptToAgent`. **Inject-only**,
  return value discarded inside `catch {}` — so with no live session it
  silently no-opped. Fixed in `hiveWake.ts`: inject → spawn → undeliverable.
- `fleet.json` disagrees with `registry.json` — lists an agent that does not
  exist, omits two that do. Fix in Phase 2, but do not trust it meanwhile.

---

## 6. Order of work

1. Add the wake to `index.ts`'s `onMessage` — the decision tree in §2.
2. Post `say` to room chat on delivery, with a generated fallback.
3. Make it idempotent (§3.1, §3.3).
4. Suppress empty wakes.
5. Verify against the samsung hive (§4).

Do not start Phase 1 (ack/retry/dead-letter) until a real dispatch wakes a
real agent. Everything above Phase 0 assumes messages arrive.

---

## 7. The standard this repo holds to

From `CONTRIBUTING.md`, and they are not decoration:

- **A test must fail without its fix.** Revert it, watch it go red, restore it.
- **Capture real behaviour; never write a fixture to match your code.**
- **Comments explain *why*, not *what*.**
- **Degrade, don't refuse** — a wake that cannot happen is logged and recorded,
  never silently dropped.
- **The human runs every commit.** Hand over a ready-to-paste command; do not
  run it. Never `git add .` — name every path.
