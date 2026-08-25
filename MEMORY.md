# Shared agent memory

A store of what the team has learned, shared across every agent and every
machine. The claim it makes:

**An agent begins a task already knowing what the team learned — including
what agents on other people's machines learned.**

That sentence is executable. `apps/runner/src/sharedMemory.test.ts` boots two
runners with two machine identities, has the first form a memory from real
work, then asserts the second one's *prompt* contains it, attributed.

## Where it lives, and why

On the **server**, in SQLite — not on the node.

This follows directly from D1 and D2: agents run on their owner's machine, and
all cross-machine traffic goes through the server. Memory on the node would be
private to that node, which makes "shared" a lie the moment a second machine
joins. The runner is deliberately stateless about memory — it asks, it writes,
it never caches.

## Scopes

| Scope | Who recalls it | For |
|---|---|---|
| `project` | every agent in the room, on any machine | what the **team** knows |
| `agent` | only the agent that wrote it | one agent's own working notes |

Only `project` memories reach the browser's Memory tab — an agent's private
notes are for its own recall, not a team display.

## Lifecycle

1. **Recall, before the work starts.** On `task.offer` the runner sends
   `memory.recall` and waits (max 2s) for `memory.result`, then prepends the
   hits to the prompt via `withMemories()`.
2. **Write, after it finishes.** Every terminal result forms an `outcome`
   memory — `Completed: <title>` or `Failed: <title> — <reason>`. Failures are
   recorded *with their reason*, because "we already tried that and it died on
   budget" is the single most useful thing to inherit.

Memories are framed in the prompt as **context, not instructions** ("What this
team already knows"). The task is the instruction. A harness that treated a
recalled note as a command would let a stale memory hijack a new task.

## Two properties worth stating plainly

**Recall can never block work.** A slow server, a lost response, a socket that
just dropped — all degrade to "no memories" and the task runs uninformed. A
memory system that can stop an agent working is worse than no memory system.
The 2s timeout, and the fact that `recall()` resolves rather than rejects, are
that guarantee.

**Recall bypasses the outbox; writes don't.** A recall is only useful *right
now*, so it is sent directly and dropped if the socket is down — replaying it
later against a finished task would be nonsense. A memory formed while the
network was down is still worth keeping, so writes go through the outbox and
replay on reconnect.

## What this is NOT

**Retrieval is lexical, not semantic.** SQLite FTS5 with BM25 ranking — real
relevance ranking over real text, but keyword-based. Semantic recall needs an
embedding model, and this project has no LLM or embedding API wired in
anywhere (the same gap `DECISIONS.md` D24 documents for `ptyHarness`), so it
could not be built honestly here.

The consequence is concrete: a memory saying *"use pnpm"* will not surface for
a query about *"package manager"* — no shared keyword. Embeddings would fix
exactly that. The interface is shaped so they can slot in later:
`recallMemories()` takes a query string and returns ranked rows, and nothing
above it assumes how the ranking happened.

**Near-duplicates collapse; nothing is forgotten or reconciled.** Memories are
deduped on (project, scope, `dedupe_key`) — a *normalised* form of the text, so
"use pnpm, not npm" and "Use pnpm not npm." are one fact rather than two. The
normalisation is strictly about formatting: case, whitespace, clause
punctuation and a trailing full stop. Punctuation inside a word is left alone,
because "3:1" and "31" are not the same fact.

Recall blends lexical relevance (BM25) with recency on a 21-day half-life,
weighted 80/20 so an old exact match still beats a recent vague one. **Age
affects ranking only — nothing is ever deleted for being old.**

Still missing: summarisation, and any notion that two memories contradict each
other. Recall is still capped at 100 rows (30 in the view). At the scale this
runs at — a few people, one room — that's fine. It would not be fine at a
thousand memories.

**Agents choose what to remember (as of the `remember` event).** Two things now
form a memory: a task's outcome, written by the runner, and anything the agent
itself marks. Each task prompt carries one line of convention —
`REMEMBER: <the fact>` — and the provider parsers turn a matching line into
`{ kind: "remember", memoryKind, text }`, which the runner sends as the
`memory.write` the protocol already accepted.

Two limits worth stating plainly. The `memoryKind` defaults to `fact` because
a CLI has no reliable way to declare `preference` vs `decision` in one line —
so that distinction exists in the schema and is barely used in practice. And
the convention is *advisory*: a model that ignores the instruction produces no
memories, and nothing detects that. What is guaranteed is the channel, not the
agent's judgement.

## Files

| Path | What |
|---|---|
| `packages/protocol/src/bodies.ts` | `memory.write` / `memory.recall` / `memory.result` |
| `apps/server/src/db.ts` | schema, FTS5 index + triggers, `writeMemory` / `recallMemories` |
| `apps/server/src/nodeGateway.ts` | the two handlers |
| `apps/runner/src/connection.ts` | `recall()`, `rememberOutcome()`, `withMemories()` |
| `apps/server/src/memory.test.ts` | store behaviour, scoping, dedupe, FTS safety |
| `apps/runner/src/sharedMemory.test.ts` | the cross-machine claim, end to end |
