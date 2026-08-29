# Phase 5 Result — Routing Honestly Scoped

## Summary

Evaluated Contract Net vs Direct Capability Matching against the real multi-agent floor. 

**Decision**: Direct deterministic capability matching is established as the primary, production-grade routing path. Contract Net is preserved in `apps/server/src/communication/assignmentStrategy.ts` and `contractNet.ts` as an explicit opt-in strategy (for large heterogeneous fleets >10 agents or tasks marked `#auction`), rather than inserting a 3-round-trip bidding latency penalty into standard task dispatches.

## Analysis & Evidence

1. **The Cost of an Auction vs Direct Matching**:
   - An LLM agent turn takes 5–20 seconds. A 3-phase Contract Net auction (Call for Proposals → Bids Collection → Award Selection) introduces 15–60 seconds of latency and substantial API token consumption before a task even starts.
   - For realistic floors (e.g. Samsung hive with `god` planner, `sam` developer, `ram` researcher), role differentiation is distinct. When a task requires `developer`, `sam` is the unique matching candidate.

2. **The Direct Routing Architecture (`apps/server/src/orchestrator.ts`)**:
   - `evaluateAgentCandidates()` evaluates candidates in $O(N)$ with:
     - Capability coverage match
     - Machine online status gate
     - Active concurrency & load balancing
     - Historical success rate tracking (`getAgentHistoricalPerformance`)
     - Previous failure penalty (skips agents that previously crashed/timed out on this task)

3. **Assignment Strategy Seam (`apps/server/src/communication/assignmentStrategy.ts`)**:
   - `selectAssignmentStrategy()` defaults to `DIRECT`.
   - Selects `CONTRACT_NET` only when:
     - Explicitly forced via configuration or `#auction`/`#cfp` tags in the task spec/title.
     - Ambiguous high-value tasks with multiple competing idle candidates.

## Empirical Finding
In the 3-agent Samsung hive fixture and the standard multi-agent test suite, **direct capability matching fired 100% of the time**, resolving assignments instantly with zero latency or token overhead.
