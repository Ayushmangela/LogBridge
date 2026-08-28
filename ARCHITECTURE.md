# LogBridge — Architecture & System Overview

> **A distributed virtual workspace, 2D pixel office, and autonomous multi-agent coordination platform for human teams and local AI agents.**

---

## 1. Core Vision & Philosophy

LogBridge is built around a fundamental insight in multi-agent and human developer collaboration:
**Code, credentials, and execution belong on the developer's laptop; coordination, state, and visualization belong on a shared central server.**

```
   ENGINEER A's LAPTOP             CENTRAL LOGBRIDGE SERVER             ENGINEER B's LAPTOP
   ═══════════════════             ════════════════════════             ═══════════════════
   • Local Repositories            • Single Source of Truth (SQLite)    • Local Repositories
   • Private Toolchains / Keys     • Real-time WebSocket Broadcaster    • Private Toolchains / Keys
   • Local CLI Agents (Claude/etc) • Task Leases & DAG Engine           • Local CLI Agents (OpenCode/etc)
   • Git Worktree Isolation        • Zero Execution / Pure Broker       • Git Worktree Isolation
          │                                   ▲                                   │
          │                                   │                                   │
          └─────────── Ed25519 Node WS ───────┴─────── Ed25519 Node WS ───────────┘
                                              ▲
                                              │ Browser WS (Realtime Sync)
                                              ▼
                                 WEB CLIENT / PIXEL OFFICE
                           (Pixi.js Tilemap · Spatial Comms · HUD)
```

### The Three Golden Axioms:
1. **Local Execution**: Real AI processes (`claude`, `opencode`, local CLI harnesses) run on the engineer's machine. They touch local git branches, execute local tests, and consume local API keys.
2. **Zero Remote Execution**: The central server **never** executes code, scripts, or agent harnesses. It is strictly a broker for state, DAGs, sealed messaging, and presence.
3. **Deterministic Physicality**: Nothing moves in the 2D office without a real system event. Sprites do not wander or fake activity — an agent's position is a physical projection of its actual task state.

---

## 2. Monorepo Structure

```
LogBridge/
├── packages/
│   └── protocol/              # Shared Zod schemas, TypeScript types, wire envelopes, view contracts
├── apps/
│   ├── server/                # Fastify + WebSocket + SQLite backend, DAG engine, PTY gateway
│   ├── runner/                # Node daemon running on developer machines, agent CLI harness
│   ├── web/                   # Single-Page Virtual Office, Pixi.js canvas, Command Center
│   └── desktop/               # Electron shell wrapper around web application
├── assets/                    # Office tilemaps (office.json), spritesheets, audio, tileset metadata
└── tools/                     # Map generation, greybox builder, tileset atlas scripts
```

---

## 3. High-Level Subsystems Architecture

```mermaid
graph TD
    subgraph Client Layer (apps/web & apps/desktop)
        Pixi[Pixi.js 2D Pixel Office]
        HUD[Upper Pill Navbar]
        Roster[Left Agents & People Sidebar]
        CC[Command Center & Agent Inspector]
        Term[xterm.js Interactive PTY Terminal]
        DAGUI[Workflow & DAG Visualizer]
    end

    subgraph Central Server Layer (apps/server)
        GW[Gateway & WS Broadcaster]
        DB[(SQLite - data.db)]
        WF[DAG Workflow & Task Engine]
        PTYGW[PTY Terminal Gateway]
        SEC[RBAC & Permission Gate]
        MEM[Shared Memory & BM25 Engine]
        TRIG[Trigger & Cron Engine]
        GH[GitHub Polling & Webhook Sync]
    end

    subgraph Node Runner Layer (apps/runner)
        Runner[Node Runner Daemon]
        Harness[CLI Execution Harness]
        Worktree[Git Worktree Sandbox]
        Agent[Local AI Agent CLI]
    end

    Pixi <-->|WebSocket /ws| GW
    CC <-->|WebSocket /ws| GW
    Term <-->|WebSocket /ws/pty| PTYGW
    Runner <-->|Ed25519 Node WS /node-ws| GW
    
    GW --> DB
    GW --> WF
    GW --> MEM
    GW --> TRIG
    GW --> GH
    GW --> SEC
    PTYGW --> Runner
    
    Runner --> Harness
    Harness --> Worktree
    Worktree --> Agent
```

---

## 4. The 2D Pixel Office & Spatial World Architecture

The virtual office is a live, spatial digital twin of the team's software engineering operations.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              VIRTUAL OFFICE MAP LAYOUT                                 │
├───────────────────┬───────────────────┬───────────────────┬────────────────────────────┤
│   Dev Room        │   Review Room     │   QA Room         │   Command Center           │
│   (Active Coding) │   (Diff Reviews)  │   (Test & CI)     │   (Central Orchestrator)   │
├───────────────────┴───────────────────┴───────────────────┴────────────────────────────┤
│                               ATRIUM (Central Corridor)                                │
│                   Upper: Blocked on CI · Lower: Under Code Review                      │
├───────────────────────────────────────────┬────────────────────────────────────────────┤
│   Open Office Pods (Desks 1-12)           │   Meeting Room                             │
│   (Standard Development Tasks)            │   (Cross-Machine Sealed Peer Collab)       │
├─────────────────────┬─────────────────────┴─────────────┬──────────────────────────────┤
│   Lobby / Reception │   Cafeteria & Lounge              │   Senior & Boss Cabins       │
│   (Arrivals)        │   (Idle Agents Waiting)           │   (Private Owner Offices)    │
└─────────────────────┴───────────────────────────────────┴──────────────────────────────┘
```

### 4.1. Rendering Engine (`apps/web/index.html` via Pixi.js)
- **Map Dimensions**: 64 × 40 tiles at 32 × 32 px per tile = **2048 × 1280 px total canvas**.
- **Tilemap Layers**:
  - `floor`: Base ground, hardwood, carpets, concrete paths.
  - `deco`: Floor details, power cables, rug patterns.
  - `walls`: High walls, glass partitions, and room dividers.
  - `props`: Desks, multi-monitor setups, servers, couches, plants, coffee machines.
  - `foreground`: Wall tops and overhead items rendered above characters for authentic depth sorting ($y$-index ordering).
- **Smooth Canvas Controls**: Mouse-wheel zooming, pan-and-drag camera, 1:1 pixel crisp scaling with pixelated rendering modes.

### 4.2. Zone to Task-State Mapping (Deterministic Positions)

| Room / Zone | Visual Location | Real System Meaning |
|---|---|---|
| **Dev Room & Open Office** | Desk pods (3 desks/pod) | Agents actively executing tasks (`in_progress` / `working`). |
| **Review Room** | Multi-screen review station | Agents waiting on human or peer code review (`reviewing`). |
| **QA Room** | Testing benches | Agents running automated test suites, linting, and build verification. |
| **Command Center** | Central command screens | Central orchestrator & supervisor managing DAG workflows. |
| **Meeting Room** | Conference table & chairs | Agents on **two different laptops** collaborating via sealed delegation. |
| **Atrium** | Central open hallway | Upper: Tasks blocked on CI/external services · Lower: Code reviews. |
| **Cafeteria / Lounge** | Coffee bar & booths | Idle agents waiting for task assignment (`idle`). |
| **Chill Room** | Gaming & recreation area | Agents that just completed a task (`just_finished`). |
| **Boss & Senior Cabins** | Private corner offices | Cabin 0 (Repo admin / Boss) + Cabins 1-3. Agents waiting on specific owners. |
| **Lobby** | Reception area | Where team members and machines appear when connecting (`connected`). |

### 4.3. Spatial Private Room Comms (Gather.town Style)
- **Proximity Audio & Visual Indicators**: When two or more characters enter the same enclosed room (Meeting Room, Review Room, or Boss Cabin), a spatial private comms channel is established with a floating room status dock.

### 4.4. Character Avatars, Bubbles & Indicators
- **Real-Time Speech & Status Bubbles**: Live task titles, questions, and approval prompts float directly above agent heads on the canvas.
- **Custom Character Picker**: Select custom sprite skins, frame offsets, and directional walk cycles.

---

## 5. Complete Feature Inventory & Subsystems

### 5.1. Multi-Agent Workflows & DAG Engine
- **Task Dependency Graphs**: Define prerequisite step relationships ($A \rightarrow B, C \rightarrow D$) for complex multi-agent software pipelines.
- **Topological Handoffs**: Automatically dispatches dependent tasks as soon as parent tasks succeed.
- **Supervisory Health Checks**: Monitors in-flight workflows, detects stalled tasks, and provides one-click supervisor actions (Pause, Resume, Re-route, Cancel).
- **Visual DAG Graph**: Rendered node-and-arrow flow diagrams in the Command Center.

### 5.2. Goal & Plan Decomposition Engine
- **Automated Planning (`/plan <goal>`)**: Breaks high-level engineering goals into atomic steps with estimated durations, roles, and dependencies.
- **Human Approval Gates**: Nothing executes automatically until a developer reviews, edits, and approves the generated plan.

### 5.3. End-to-End Sealed Cross-Machine Collaboration
- **Cryptographic Envelopes**: When Agent A (Laptop 1) delegates work or requests review from Agent B (Laptop 2), payloads are encrypted via **X25519 key exchange + AES-256-GCM**.
- **Zero Server Decryption**: The central server routes the ciphertext and provably cannot read task content, code diffs, or secrets.
- **Consent Gateways**: Local runners enforce owner permission modes (`once`, `always`, `never`) before accepting cross-machine delegations.

### 5.4. Shared Team Memory & Associative Recall
- **Dual-Tier Search**: Combines BM25 lexical ranking and recency weighting for lightning-fast memory retrieval.
- **Explicit Learning Markers (`REMEMBER:`)**: When an agent finishes a task or discovers a solution, it saves the insight so other agents across the company immediately inherit that knowledge.

### 5.5. Interactive PTY & Multi-Agent Terminal Gateway
- **Web-based Terminal (`xterm.js`)**: Real-time interactive terminal streaming over WebSockets.
- **Stream JSON Inspector**: Live, formatted streaming outputs for Claude Code and OpenCode runs (tool calls, thinking tokens, diagnostics, file edits).
- **Terminal Font & Display Controls**: Fullscreen mode, font-size toggles, live execution indicators, and ANSI color rendering.

### 5.6. Automated Triggers & Event Engine
- **Time-based Cron Triggers**: Scheduled recurrent agent runs (e.g. nightly dependency audits, hourly health checks).
- **Webhook & Event Triggers**: Trigger multi-agent workflows from external CI/CD webhooks or internal system events.
- **GitHub Sync**: Auto-mirrors GitHub Issues to room tasks and GitHub PR/CI updates to the live office feed.

### 5.7. Governance, Leases & Cost Control
- **60-Second Task Leases**: Prevent task duplication; automatic recovery if a runner loses connectivity.
- **Hard Budget & Wall-Clock Protection**: Kills runaways if duration or token spend exceeds user-configured thresholds.
- **Git Worktree Sandboxing**: Spawns agent tasks in separate git worktrees, preventing pollution of the developer's main working branch.

---

## 6. Security Model & Threat Matrix

| Security Vector | Implementation & Protection Mechanism |
|---|---|
| **Server Code Execution** | **Zero Execution Path**: The server has no execution capability (`exec`, `eval`, or shell spawning are completely absent). |
| **Machine Authentication** | **Ed25519 Challenge-Response**: Every runner enrolls with a cryptographic keypair and signs a timestamped server challenge upon connection. |
| **Peer-to-Peer Privacy** | **End-to-End Encryption**: Cross-machine task delegations use X25519/AES-256-GCM sealed envelopes. |
| **Local File Safety** | **Git Worktree Isolation**: Agents work on ephemeral branch worktrees, protecting uncommitted developer changes. |
| **Cost & Token Overrun** | **Pre-flight Budget Caps**: Runners enforce hard wall-clock and token limit termination. |
| **Human-in-the-Loop** | **Consent & Question Gates**: Sensitive actions, tool executions, and delegations require explicit human consent. |

---

## 7. How to Run & Develop

### Prerequisites
- Node.js $\ge 22$
- npm / yarn

### Quick Start Commands
```bash
# 1. Install all dependencies across monorepo workspaces
npm install

# 2. Run automated test suite (34 test files, 290+ tests)
npm run test

# 3. Start central coordination server (Fastify + SQLite + Web UI on port 8787)
npm run dev:server

# 4. In a separate terminal, start the local node runner daemon
npm run dev -w @logbridge/runner
```

### Accessing the Web App
Open your browser and navigate to:
**`http://localhost:8787`** (or `http://127.0.0.1:8787`)
