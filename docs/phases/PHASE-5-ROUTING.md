# Phase 5 — routing, honestly scoped

## The situation

`communication/contractNet.ts` is 390 lines implementing Contract Net: issue a
call-for-proposals, collect bids, score them, award. It is tested (8 tests, 43
assertions). It is reachable only through `routes/communication.ts`.

**No agent path calls it.** The orchestrator does not consult it. It is
well-built code that nothing uses.

## The decision to make

Not "should we use Contract Net" but **"when is an auction worth three round
trips?"**

Evidence, from `research/`:

- The interoperability survey's roadmap puts capability-based routing before
  market protocols.
- No credible benchmark exists for auction latency in LLM agents — the
  deep-research report checked and marked the claims it found as NOT VERIFIED.
- At three agents with distinct roles (developer, research, planner), the
  answer to "who should do this" is almost always obvious.

So: **direct capability matching first; auction only when no single agent
clearly fits.** The orchestrator already routes by capability. Contract Net
becomes one *strategy* it may select, not the default path.

`communication/assignmentStrategy.ts` (64 lines) exists and appears to be
exactly this seam. **Read it first** — this phase may be mostly wiring.

## Design notes

**Define "clearly fits" explicitly.** Something like: exactly one idle agent
whose capabilities cover the task's required capability. Zero → auction or
queue. More than one → tie-break by load, or auction if you want the bids to
carry context.

**Bids should carry context headroom.** The agent prompts already mention a
live `ctx NN%` occupancy signal, and treat a high value as busy rather than
idle. If bids exist, that belongs in them — it is a better signal than a token
count.

**Auctions need a timeout and a default.** If no bid arrives, assign the best
guess rather than stalling. A task that waits forever for a bid is worse than
one assigned imperfectly.

**Do not let the auction become the interesting part.** It is a fallback. If
you find yourself building bid-scoring heuristics, stop — that is a sign the
capability data is too weak, and fixing that is the better investment.

## The alternative outcome, which is legitimate

If, after wiring, auctions never fire in practice — because the capability
match always resolves — **that is a finding, and the honest response is to
shelve Contract Net** rather than manufacture cases for it. Move it out of
`communication/`, mark it experimental, note the conditions under which it
would earn its place (roughly ten heterogeneous agents).

Deleting or shelving working code is a legitimate result of this phase.

## Done when

- The common case assigns directly, with no auction.
- The ambiguous case runs a bounded auction with a timeout and a fallback.
- You can state how often each path fired in a real session.
- If the answer is "the auction never fired", you have said so plainly.
