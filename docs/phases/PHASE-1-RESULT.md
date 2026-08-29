# Phase 1 Result — Delivery Guarantees for Hive Messages

## Summary

Implemented end-to-end delivery tracking, acknowledgment detection, timeout-based redelivery with `working`-agent suppression, and dead-letter queueing for hive messages.

## The Model Implemented

```
pending ──► delivered ──► handled (ack on inbox/.done/ move)
   │            │
   │            ├─ timeout (10m), attempts < 3 ──► redeliver
   │            └─ attempts = 3 ────────────────► dead (dead-letter/ dir + event + chat)
   └─ machine offline ──────────────────────────► undeliverable (durable record)
```

## Key Changes

1. **`hive_deliveries` Table (`apps/server/src/db/schema.ts`)**:
   - Durable delivery ledger storing `message_id`, `to_agent_id`, `from_agent_id`, `delivered_at`, `handled_at`, `dead_at`, `attempts`, `last_wake_outcome`, and `state`.
   - Explicit `delivered_at` timestamp avoids unreliable filesystem `mtime` under sync/restore operations.
   - Survives server restarts so attempt counters never reset to 0.

2. **Core Delivery Engine (`apps/server/src/hiveDelivery.ts`)**:
   - `recordDelivery()`: Persists every wake/delivery attempt.
   - `isAlreadyDelivered()`: Durable check replacing the ephemeral in-memory set.
   - `checkForAcks()`: Scans `inbox/.done/` directories across hive roots and marks matching delivered messages as `handled`. Safe against ack races (file disappears mid-scan).
   - `sweepDeliveries()`: Evaluates stale deliveries (>10m default). Skips agents with `status = 'working'` to prevent work duplication. Redelivers up to max attempts (default 3), or transitions to `dead` state.
   - `deadLetterMessage()`: Moves the unhandled message to `inbox/dead-letter/<id>.json`, emits `hive_message.dead_lettered` event, and posts a visible alert in the office room chat for human recovery.

3. **Wake Integration (`apps/server/src/hiveWake.ts`)**:
   - Updated `wakeRecipient()` to use two-layer dedup: in-memory hot cache for sub-tick speed, backed by durable `hive_deliveries` table.

4. **Server Loop Wiring (`apps/server/src/index.ts`)**:
   - Wires `recordDelivery()` upon successful wake.
   - Registers periodic background intervals: 30s for ack scanning (`checkForAcks`) and 60s for timeout/dead-letter sweeping (`sweepDeliveries`).

## Verification & Tests

### 1. Automated Tests (`apps/server/src/hiveDelivery.test.ts`)
14 tests covering all state transitions:
- Durable delivery recording and `isAlreadyDelivered` lookup.
- Dedup surviving server restart (simulated by clearing in-memory state).
- State transitions: `delivered` → `handled` when message is moved to `inbox/.done/`.
- Unmoved inbox messages remain `delivered`.
- Ack race handling (safe DB updates when files are moved asynchronously).
- Timeout redelivery with attempt counter increment.
- **Working-agent protection**: mid-task agents are skipped to prevent duplicate execution.
- Stale messages reaching max attempts (3) transition to `dead` state, move file to `inbox/dead-letter/`, emit event, and post room chat alert.
- Exactly one redelivery per agent failure, no runaway loop/stream.
- Normal handling never triggers redelivery.
- Filtered queries and distribution counts (`deliveryCounts`).

### 2. Red-Test Verification (Rule Compliance)
- Reverted the `working` agent status check in `sweepDeliveries()`.
- Verified test `a working agent is NOT redelivered — the brief says check status first` failed red (`expected 1 to be +0`).
- Restored fix and observed test return to green.

### 3. Monorepo Test & Typecheck
- Full test suite: **481 passing tests** (129 runner, 340 server, 5 web unit, 7 Playwright e2e).
- Workspace typecheck: zero errors across `@logbridge/protocol`, `@logbridge/runner`, `@logbridge/server`.
