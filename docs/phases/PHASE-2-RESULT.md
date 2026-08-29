# Phase 2 Result — Roster Projection & Sole-Scribe Guard

## Summary

Resolved the two core multi-agent integrity problems identified in Phase 2:
1. **Roster Projection**: Made `fleet.json` a strict, automated projection of `registry.json` (+ live inbox metrics), eliminating drift and phantom agents.
2. **Sole-Scribe Guard**: Enforced that only the designated god agent (or human operator) can write to god-owned files (`board.md`, `tasks.json`, `registry.json`, `fleet.json`). Disallowed writes from subordinate agents are intercepted at the router and rejected with an actionable refusal instructing them to message god instead.

## Key Changes

1. **Roster Projection (`deriveFleet()` in `apps/server/src/hive.ts`)**:
   - `deriveFleet()` reads `registry.json` and agent inbox folders to produce `fleet.json` atomically.
   - Synchronized on `initHive()`, `saveRegistry()`, `registerAgent()`, `registerAgentInProjectHive()`, and router sweeps.
   - Prohibits independent hand-maintained copies of `fleet.json`.

2. **Sole-Scribe Enforcement (`apps/server/src/hive.ts`, `apps/server/src/routes/hive.ts`)**:
   - `isGodOwnedFile()`: Normalized path checker guarding `board.md`, `tasks.json`, `registry.json`, `fleet.json` across relative and absolute forms (`./board.md`, `hive/board.md`, etc.).
   - `isSoleScribe()`: Identifies authorized authors (`godId`, `isGod: true`, `user`, or admin).
   - `setBoard()`: Direct programmatic mutation checks author authorization and throws a readable refusal on violation.
   - `routes/hive.ts`: `POST /api/hive/board` catches unauthorized author attempts and returns `403 Forbidden` with the refusal rationale.
   - Mailbox Router Interception: If a subordinate agent attempts a direct mutation message to god-owned files in its outbox, the router intercepts the message, generates a formal `refuse` speech-act response delivered to the subordinate's inbox with clear delegation instructions (`"Message god (<godId>) with your proposed change so god can update it"`), and notifies the room chat.

## Verification

### 1. Automated Tests (`apps/server/src/hiveRosterWriters.test.ts`)
- `fleet.json` auto-generation and dynamic synchronization on agent registration.
- Path normalization across standard, relative, and nested forms of god-owned files.
- Authorization verification: God agent and human operator can update `board.md`.
- Rejection verification: Subordinate agent is rejected in `setBoard()`.
- Router outbox interception: Malicious/unauthorized write requests produce a typed `refuse` speech act in the sender's inbox.

### 2. Red-Test Verification
- Temporarily commented out `isSoleScribe` check in `setBoard()`.
- Verified test `non-god worker agent is refused when writing board.md directly via setBoard` failed red.
- Restored check and verified return to green.
