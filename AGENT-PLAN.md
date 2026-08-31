# What to change

**A decision, not a menu.** Grounded in a code audit of this repo, published
research on multi-agent failure, and the drawback analysis of the current
system. Every claim here was checked against the source.

The short version: **don't rebuild — re-scope.** LogBridge is trying to be two
products. One of them the evidence says is losing. The other, nobody else is
building.

---

## 0. The thesis

| | |
|---|---|
| **What LogBridge is losing at** | being a multi-agent *orchestration framework*. MetaGPT and ChatDev do it better in-process, and the research says the whole category underperforms one well-contexted agent |
| **What LogBridge is alone at** | a **trust and observability layer over real CLI agents on their owners' machines** — zero-execution server, E2E-sealed cross-machine delegation, position computed from real task state |

Every defensible property, and every part with real tests behind it, is in the
second row. The orchestration is roughly 15% of the code and it is the 15% to
cut back, not to grow.

**The evidence:**
[Tran & Kiela](https://arxiv.org/pdf/2604.02460) — single agents match or beat
multi-agent on equal token budgets; reported advantages are "better explained by
unaccounted computation and context effects."
[MAST](https://arxiv.org/abs/2503.13657) — 14 failure modes over 1,600 traces;
41–86.7% production failure rates; and the failures "require more sophisticated
solutions" than prompt and architecture tweaks.
[Cognition](https://cognition.com/blog/dont-build-multi-agents) — what works is
"one main loop carries state, subagents are stateless workers with narrow scope."

**LogBridge demonstrably exhibits six MAST failure modes**, each traceable to
code: Step Repetition (the circuit breaker exists because of it), Unaware of
Termination Conditions ("continually monitor" to a one-shot process), Loss of
Conversation History (restart re-seeding), Information Withholding (mailbox
delivering into a void), Ignored Other Agent's Input, No/Incomplete
Verification.

---

## 1. FIX — in risk order

### 1.1 `READY_MARKERS` is the sharpest risk in the codebase

```js
const READY_MARKERS = ["Ask anything", "ctrl+p", "OpenCode", "tab agents",
                       "connected to", "What would you like",
                       "Tip Run /connect", "Tip", "commands"];
looksReady = (data) => READY_MARKERS.some(m => data.includes(m));
```

An unanchored substring match on the words **`"Tip"`** and **`"commands"`**.
Any output containing *"the tip of the branch"* or *"multiple commands"*
declares the CLI ready. This now gates **three** behaviours: the `starting`
status, prompt seeding, and the wake path.

And **it has never been validated against a real CLI** — every PTY test does
`vi.mock("node-pty")`. This is precisely the failure class `PROVIDERS.md` was
written about, sitting in the hottest path in the system.

**Do:** capture real `claude` and `opencode` boot output to a fixture; derive
markers from the capture; anchor them to line-start; delete `"Tip"` and
`"commands"`. Add a real-CLI smoke test that skips when the binary is absent.

### 1.2 `isolation: 'shared'` is the default

The Add Agent dialog defaults to `shared` — agents work **directly in the same
folder, no branch**. Git conflicts at least announce themselves; concurrent
edits to one working tree do not. This is how `board.md` got "two design
systems collided."

**Do:** default new agents to `worktree`. Keep `shared` as an explicit choice
with a warning. The branch is per-agent (`logbridge/<agentId>`), which is the
right granularity — leave it.

### 1.3 Verification is a sentence, not a gate

MAST's third category is task verification, and LogBridge's Phase 5 review
exists only as prompt text. Nothing checks that a subordinate's claimed output
exists before the commander marks a task done.

**Do:** make acceptance a code path. A task carries `expectedOutputs: string[]`;
completion checks the files exist and are non-empty before the state can reach
`done`. Prompt-instructed verification is not verification.

### 1.4 20 silent catches in a 1,100-line file

`ptyGateway.ts` has 10 exports and does spawn, prompts, readiness, identity,
writes, completion detection, crash recovery and WebSocket routing. Errors
disappear into `catch {}`.

**Do:** split into `ptySession.ts` (lifecycle + writes), `ptyReadiness.ts`
(markers + completion), `ptyRoutes.ts` (WebSocket). Replace bare catches with a
logged `swallow(err, context)` helper — same behaviour, but findable.

---

## 2. REMOVE

Removal is the highest-leverage work available, because each item below is a
mechanism that can drift, fail, or mislead.

| Remove | Why |
|---|---|
| **Per-agent `memory.md`** | Workers must be **stateless**. Persistent private memory per worker is the exact fragility Cognition names, with extra state to desynchronise. Memory belongs to the orchestrator and the project |
| **Agent-to-agent mailbox** | Hub-and-spoke means workers talk to the orchestrator, not each other. Removing this deletes the wake path, the dedup cache, the ack/retry/dead-letter machinery, and 3 of the 6 MAST modes we exhibit |
| **The 6-phase commander** | Ceremony applied unconditionally. Already made conditional; now cut to: plan → dispatch → verify |
| **`experimental/contractNet.ts`** | Shelved with reasoning recorded. If nothing reopens it in a month, delete rather than curate |
| **WebRTC voice (~674 lines)** | Zero tests, the only microphone surface, and unrelated to watching agents work. It is a liability in a product about observability |
| **`ccRenderMemoryEditor`** and other unmounted renderers | Dead code kept "just in case" is how the unreachable Artifacts tab hid a `ReferenceError` for months |

**Net effect:** the mailbox, wake, dedup and delivery-state machinery is a large
subsystem that exists to make agent-to-agent messaging reliable. If agents don't
message each other, none of it is needed.

---

## 3. CHANGE — the architecture

One change, stated precisely:

> **The orchestrator holds all state. Workers receive a narrow, self-contained
> brief and return artifact references. Nothing else persists.**

| | Now | Target |
|---|---|---|
| Worker state | own `memory.md`, own inbox, accumulating identity | **stateless**; everything needed is in the brief |
| Worker output | prose in a message | `{ summary, files[], verdict }` — structured, checkable |
| Worker → worker | file mailbox + wake + retry + dead-letter | **none**; via orchestrator |
| Verification | prompt instruction | code gate on `expectedOutputs` |
| Orchestrator | 6 phases, 4 owned files | plan → dispatch → verify, still sole scribe |

This is not a rewrite. It is mostly **deletion**: the protocol, sealed
delegation, PTY harness, office renderer, orchestrator scoring and 449 tests all
stay. What goes is the part that makes workers into peers.

---

## 4. ADD

Four things, chosen because each converts an assumption into a fact.

**4.1 A real-CLI smoke test.** Spawns the actual installed `claude` /
`opencode`, asserts the readiness signal fires and a prompt lands. Skips when
the binary is absent, so CI stays green. *This single test converts most of this
codebase from "logically correct" to "verified."*

**4.2 A provider capture harness.** `npm run capture -- opencode` records real
boot and turn output into `fixtures/`. Markers and parsers get derived from
captures, never from documentation — the rule `PROVIDERS.md` already states but
has no tooling for. This is what unblocks the six unverified providers.

**4.3 Structured worker results.** A worker returns
`{ summary, files: [...], verdict }` instead of prose. Makes 1.3's verification
gate possible, makes the board honest, and removes the parsing guesswork.

**4.4 The authorization decision.** Not a feature — a decision that has been
open all along. `buildView()` takes `meId` and uses it only for avatar
placement; every signed-in user receives every project. Either write down that
this is a trusted-team workspace and make the docs match, or filter by
`project_members`. Right now the code and docs say different things.

---

## 5. DON'T ADD

Attractive, and the evidence is against all of them.

| | Why not |
|---|---|
| **More agents or roles** | failure rate rises with agent count; 3–6 is where hub-and-spoke works |
| **Wiring Contract Net** | *N+1* cold starts and two round-trips of billed tokens to decide worse than free deterministic scoring |
| **A message broker** (Redis/NATS) | durability requirement is "survive a laptop sleeping" — files satisfy it. A broker adds an always-on dependency to a system whose premise is your own machine |
| **Agent-to-agent mesh** | multiplies coordination surface for no gain below ~60 agents |
| **Full FIPA ACL / conversation state machines** | ceremony, not capability |
| **Migrating off SQLite** | the stated ceiling is wrong: PTY chunks **never touch the database** (`onData` appends to an in-memory string, zero DB writes per chunk) and WAL is on, so readers never block. Real write pressure is events and task rows — orders of magnitude below the concern |

---

## 6. Order of work

1. **Capture real CLI output; fix `READY_MARKERS`; add the smoke test** (1.1, 4.1, 4.2)
   — highest risk, and everything else's correctness rests on it
2. **Default isolation to `worktree`** (1.2) — one line, removes a whole class of corruption
3. **Verification gate + structured results** (1.3, 4.3) — closes MAST's third category
4. **Delete: per-agent memory, agent-to-agent mailbox, WebRTC, dead renderers** (§2)
   — the largest single reduction in surface area
5. **Split `ptyGateway.ts`, log the silent catches** (1.4)
6. **Decide authorization** (4.4)

Steps 1–3 make the system trustworthy. Step 4 makes it smaller. Nothing here
requires starting over, and nothing here is a new agent framework.

---

## 7. What this is *not*

This plan does not make LogBridge a better orchestration framework, because the
research says that race is not winnable and probably not worth entering. It
makes it a **reliable, observable, trustworthy harness for real coding agents
running on real machines** — which is the thing it is already closest to, and
the thing nobody else has built.
