# experimental/

Code that is **built and tested but deliberately not on any live path.**

Nothing here is imported by the orchestrator, the runner, or any agent loop.
It is reachable only by hand, through an HTTP route. If you are looking for how
work actually gets assigned, that is `orchestrator.ts` —
`evaluateAgentCandidates()`.

---

## contractNet.ts + assignmentStrategy.ts — Contract Net (CfP → bid → award)

**Status: shelved, not deleted.** ~450 lines, fully tested.

### Why it is not wired

Contract Net is a good pattern for autonomous services that can price their own
availability. This system does not have those. **Agents here are one-shot CLI
processes** — `claude -p` and `opencode run` execute a turn and exit. Nothing
sits in a loop waiting to bid.

So running a real auction would mean:

1. Wake **every** candidate agent with the CfP as its prompt — one cold start each
2. Have each reply with a structured bid, and parse it
3. Wait out the bid deadline
4. Award
5. Wake the winner **again**, now with the actual task

That is *N+1 cold starts and two round-trips of billed tokens* per task.

### What it would have to beat

`evaluateAgentCandidates()` already scores every candidate on:

| Signal | |
|---|---|
| capability match | 40 / 30 / 0 |
| machine online | 20 |
| historical success rate | up to 20 |
| current load vs concurrency | penalty |
| failed a previous attempt at this task | −15 |

…and emits a `task.routing_evaluated` event carrying the full scoring
breakdown and a disqualification reason per rejected agent. It is free,
instant, and explainable.

For a bid to be **better** information, an agent would have to know something
the server does not. It cannot: a one-shot CLI has no memory of the task before
it is spawned, so its bid could only restate capability and availability —
which the server already has, and has more reliably.

An auction here would therefore cost more, take longer, add failure modes, and
decide *worse*.

### The real reason it was shelved

Three parallel messaging mechanisms is how `fleet.json` and `registry.json`
drifted apart. `AGENT-COMMS-RESEARCH.md` §5.7 names it directly: *"Three
parallel mechanisms is how the fleet/registry drift happened in the first
place."*

Leaving a fully-formed, well-tested, **unreachable** third path in
`communication/` was worse than either finishing it or shelving it, because it
looked wired. `selectAssignmentStrategy()` in particular returned a
`"CONTRACT_NET"` decision that **nothing consumed** — a seam that appeared
load-bearing and was not.

### What would reopen this

- Agents become **long-lived processes** rather than one-shot CLIs — then they
  can bid without a cold start, and the cost argument collapses.
- Agents gain **private information** the server cannot see (local build cache
  state, a warm index, measured latency to a resource) — then a bid carries
  signal that scoring cannot.
- The floor grows past the point where a single orchestrator's view is
  trustworthy — hub-and-spoke is correct at 3–6 agents, not at 60.

Until one of those is true, this stays here.

### The HTTP routes still work

`routes/communication.ts` still exposes `issueCfp` / `submitProposal` /
`resolveContractNet`, so the mechanism can be exercised by hand and its tests
still run. Nothing calls them automatically, and nothing should start to
without revisiting the trade above.
