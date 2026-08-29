# M4 kickoff — for starting fresh in a new session

Read `M3-STATUS.md` first — it confirms M3 is done except one honest gap
(ptyHarness never run against a real CLI binary). This doc picks up from
there: M4 hasn't started, here's the first concrete, buildable slice of it.

## What M4 requires (from `PHASES.md`)

> **You deliver:** Room chat. `@dev-api do X` → agent proposes a spec → you
> confirm → it runs. Approval inbox with approve/edit/reject/answer. Board ↔
> office toggle
>
> **Test:** Ask an agent something in chat, get a spec, confirm, watch it
> run, answer its question mid-task from another browser

That's three separable features. This doc is only about the first one —
it's the one everything else depends on.

## Current state — chat is wired but inert

Checked directly against the code, not assumed:

- `apps/server/src/gateway.ts`'s `/ws` handler already persists and
  broadcasts chat messages (`msg.data.type === "chat"`) — a human typing in
  a room works today, end to end.
- The `answer` client message (approve/edit/reject/answer, already fully
  speced in `packages/protocol/src/view.ts`'s `ClientMessage` and
  `CONTRACT.md`) is already received and logged as a `human.answer` event.
  **Nothing reads it back.** It's a dead end — logged, never acted on.
- `ChatMessageT.ask` (`{ taskId, options }`, also already speced) is never
  set by any code path. Every chat message that's ever been sent has
  `ask: null`. There is no `@agent` mention parsing anywhere.

So: the wire format for the whole approve/reject loop already exists and is
validated by the protocol's zod schemas. Nothing server-side ever populates
or consumes the interesting half of it.

## The first slice to build

Turn `@dev-fake do X` into a real task, using machinery that already exists
rather than inventing new task states:

1. **Parse `@agent-name <text>` in `gateway.ts`'s chat handler.** Look up
   the agent by name in the room. If no match, ignore (or bounce an error
   chat message back — human `@`-typos shouldn't do anything silent-scary).

2. **Create the task row immediately in `submitted` state, but do not send
   `task.offer` to the runner yet.** `submitted -> rejected` is already a
   legal transition in `packages/protocol/src/task-state.ts`'s `LEGAL` map
   — no new `TaskState` value needed.

3. **Set the agent's status to `needs_input` with `waiting_on: "human: you"`.**
   This is not new machinery — `zoneFor()` already maps that to the
   `needs_human` zone, and `buildView()` already resolves `zoneAnchor` to
   the right cabin for exactly this case (see the `waitingOn?.startsWith("human: ")`
   branch in `apps/server/src/view.ts`). The office will already visualize
   this correctly with zero renderer changes.

4. **Push a chat message *from* the agent with `ask: { taskId, options: ["approve", "reject"] }`.**
   Start with just those two — skip `edit` and `answer` for this slice, add
   them once approve/reject round-trips cleanly.

5. **Wire up the `answer` handler in `gateway.ts` to actually do something:**
   `approve` → offer the task to the runner (this is the exact same DB
   update + `task.offer` WS send that `apps/server/src/index.ts`'s
   `/debug/offer-task` already does — pull that into a shared function both
   paths call, don't duplicate it). `reject` → transition the task to
   `rejected`, agent back to `idle`.

6. **Automated test**, modeled on `apps/runner/src/officeZones.test.ts`:
   send a chat message mentioning a connected fake-harness agent, assert
   the task row lands in `submitted` and the agent's zone is `needs_human`;
   send an `answer` with `choice: "approve"`; assert the task actually gets
   offered, runs via the fake harness, and completes — same idle → working →
   idle path already proven, just reached through chat instead of
   `/debug/offer-task`.

## What to deliberately stub, and say so out loud

There's no real LLM available anywhere in this project yet (same gap
`M3-STATUS.md` documents for `ptyHarness`) — no machine here has had
`claude`/`codex`/`gemini` installed. "Agent proposes a spec" cannot mean
"an agent actually reasons about the request" until that gap closes. For
this slice, stub it honestly: the "spec" is just the literal text after the
mention, wrapped in a `TaskBrief`, with a default budget. Say so in a
comment the same way `ptyHarness.ts`'s header does, not silently — the
gap between "structurally there" and "actually intelligent" needs to stay
visible or someone will trust a stub that was never meant to be trusted.

## Explicitly out of scope for this slice

- `edit` (open-ended re-specification) — needs a real UI decision about
  what's editable, not just plumbing. Come back to it once approve/reject
  round-trips.
- `answer` as a mid-task question-response (the M4 test's "answer its
  question mid-task from another browser") — depends on a running task
  being able to ask something, which depends on a real harness event for
  it. Also a separate slice.
- Board ↔ office view toggle — purely a renderer feature, zero dependency
  on the chat/approval work above. Could genuinely be built in parallel by
  someone else, same zero-file-overlap logic `PHASES.md` uses for Track A.

## Where to start reading

`DECISIONS.md` D16 ("Natural language in, typed contract out") already
commits to this exact shape before any of this was built — reread it before
writing code, it's the reasoning this whole slice is downstream of.
