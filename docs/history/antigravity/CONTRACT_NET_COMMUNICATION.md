# Contract-Net Protocol, Artifact-Bound Handoffs, Review Lifecycle & Live Sequence Flow

## Overview
This subsystem introduces enterprise-grade **Contract-Net Protocol (CFP/Bidding)**, **Artifact-Bound Peer-to-Peer Handoffs**, **Structured Review Verdicts & Automated Rework**, and a **Live Sequence Flow Inspector** in LogBridge.

It upgrades LogBridge from basic task assignment into an inspectable, market-bidding, peer-delegating multi-agent collaboration platform while maintaining 100% backward compatibility with direct assignment.

---

## 1. Full Communication Lifecycle Architecture

```text
Task Created
     │
     ▼
Assignment Strategy Decision (assignmentStrategy.ts)
     │
     ├── Direct Assignment ────────────► ASSIGN_PROPOSAL ──► Execution
     │
     └── Contract-Net / Auction (contractNet.ts)
             │
             ▼
        CFP Broadcast (to eligible candidates only)
             │
             ▼
        Agent PROPOSE Responses (approach, duration, confidence)
             │
             ▼
        Deterministic Proposal Scoring (breakdown calculation)
             │
             ├── ACCEPT_PROPOSAL (winning agent)
             └── DECLINE_PROPOSAL (other bidders)
                     │
                     ▼
                Assigned Agent Execution
                     │
                     ▼
              Produce Artifacts (diff.patch, test reports)
                     │
                     ▼
              DELEGATE_HANDOFF (handoff.ts)
                     │
                     ▼
                 Reviewer Agent
                     │
                     ▼
                REVIEW_RESULT (review.ts)
                     │
          ┌──────────┴──────────┐
          │                     │
        ACCEPT                REJECT
          │                     │
          ▼                     ▼
    TASK_COMPLETED        REWORK_NEEDED
                                │
                                ▼
                         Linked Rework Task (attempt N+1, lineage)
                                │
                                └──► Execution / Review Cycle
```

---

## 2. Core Subsystems & Components

### 1. Assignment Strategy Layer ([`apps/server/src/communication/assignmentStrategy.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/communication/assignmentStrategy.ts))
- **`selectAssignmentStrategy({ task, candidates, configuration })`**:
  - Automatically selects `"CONTRACT_NET"` when:
    - Task specifies `#auction`, `#cfp`, or `[auction]`.
    - Multiple eligible online candidates exist with matching capabilities for high-value tasks.
    - Explicit configuration requests bidding.
  - Otherwise cleanly selects `"DIRECT"` (backward compatible).

### 2. Contract Net Protocol & Deterministic Scoring ([`apps/server/src/communication/contractNet.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/communication/contractNet.ts))
- **`issueCfp(db, opts)`**: Broadcasts a Call for Proposals strictly to qualified agents.
- **`submitProposal(db, opts)`**: Records structured agent bids:
  - `approach`: High-level execution strategy.
  - `confidence`: 0.0 to 1.0 confidence rating.
  - `estimatedDuration`: Expected completion time in seconds.
  - `reasoningSummary`: Concise execution rationale.
- **`scoreAgentProposal(...)`**:
  $$\text{FinalScore} = (w_{\text{match}} \cdot \text{Match}) + (w_{\text{conf}} \cdot \text{Conf}) + (w_{\text{avail}} \cdot \text{Avail}) + (w_{\text{perf}} \cdot \text{Perf}) - (p_{\text{dur}} \cdot \text{DurPenalty})$$
- **`resolveContractNet(db, cfpId)`**: Issues `ACCEPT_PROPOSAL` to the highest-scoring bidder, `DECLINE_PROPOSAL` to others, and assigns the task.

### 3. Artifact-Bound Peer Handoffs ([`apps/server/src/communication/handoff.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/communication/handoff.ts))
- **`delegateHandoff(db, opts)`**:
  - Direct peer-to-peer delegation from Developer to Reviewer/QA.
  - Carries zero-copy artifact references (`diffArtifactId`, `testReportArtifactId`, `buildArtifactId`) and context summary (design decisions, files modified) without bloating message envelopes.

### 4. Typed Review Verdicts & Automated Rework ([`apps/server/src/communication/review.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/communication/review.ts))
- **`processReviewResult(db, opts)`**:
  - **`ACCEPT`**: Completes task, unlocks downstream workflow DAG dependencies, and emits `TASK_COMPLETED`.
  - **`REJECT`**: Spawns a linked rework task (`[Rework #2] ...`, `retryOf: originalTaskId`, `parentTask: rootTaskId`) passing structured findings (`severity`, `message`, `file`, `line`).
  - **`REWORK_ESCALATED`**: When rework cycles exceed `maxReworkAttempts` (default 3), escalates to human commander rather than looping indefinitely.

### 5. Normalized Sequence Event Stream ([`apps/server/src/communication/sequenceEvents.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/communication/sequenceEvents.ts))
- Normalizes all communication events into a unified timeline:
  `CFP_SENT`, `PROPOSAL_RECEIVED`, `PROPOSAL_ACCEPTED`, `PROPOSAL_DECLINED`, `DIRECT_ASSIGNMENT`, `AGENT_STARTED`, `ARTIFACT_CREATED`, `DELEGATE_HANDOFF`, `REVIEW_STARTED`, `REVIEW_RESULT`, `REWORK_CREATED`, `TASK_COMPLETED`, `REWORK_ESCALATED`.

### 6. Live Sequence Flow Inspector UI ([`apps/web/index.html`](file:///Users/ayush/Project/LogBridge/apps/web/index.html))
- **`⚡ Sequence Flow` Tab**:
  - Real-time lifelines for `👑 Commander`, `💻 Developer`, `🔍 Reviewer`, `🧪 QA`, `📦 Artifact Store`, and `⚙️ System`.
  - Color-coded animated message vectors showing live communication flows.
  - Task filter dropdown and live WebSocket synchronization.
  - Interactive Event Details Drawer showing deep payload metadata, confidence breakdowns, review findings, and artifact links.

---

## 3. Database Schema

```sql
CREATE TABLE IF NOT EXISTS contract_net_cfps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  candidate_agent_ids_json TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  selected_proposal_id TEXT,
  deadline TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_proposals (
  id TEXT PRIMARY KEY,
  cfp_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  approach TEXT NOT NULL,
  estimated_duration INTEGER,
  confidence REAL NOT NULL,
  capability_match REAL,
  availability_score REAL,
  reasoning_summary TEXT,
  score REAL,
  score_breakdown_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (cfp_id) REFERENCES contract_net_cfps(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sequence_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  correlation_id TEXT,
  type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_verdicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  comments_json TEXT NOT NULL,
  artifact_id TEXT,
  findings_json TEXT,
  rework_task_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

---

## 4. REST API Surface

- `POST /api/contract-net/cfp` — Issue Call for Proposals
- `POST /api/contract-net/propose` — Submit structured agent proposal
- `POST /api/contract-net/resolve` — Resolve CFP and assign task
- `POST /api/handoff/delegate` — Delegate artifact-bound peer handoff
- `POST /api/review/verdict` — Submit review verdict (`ACCEPT` / `REJECT`)
- `GET /api/projects/:id/sequence-events` — Stream project sequence flow events
- `GET /api/tasks/:id/sequence-events` — Get task-specific sequence timeline

---

## 5. Verification Status

All 8 tests in [`apps/server/src/contractNet.test.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/contractNet.test.ts) and all 421 tests across the monorepo pass:
```text
@logbridge/runner: 129 / 129 passed (19 test files)
@logbridge/server: 292 / 292 passed (34 test files)
Total:             421 / 421 passed across 53 test files (100% green)
```
