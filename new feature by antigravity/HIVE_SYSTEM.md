# Autonomous Hive Multi-Agent System

Designed and implemented by **Antigravity**, the **Hive System** is an on-disk multi-agent coordination layer that transforms independent AI processes into an organized team. It provides file-based coordination, strict writer isolation, and persistent tracking without requiring external server dependencies.

---

## 1. On-Disk Structure

The Hive workspace lives on disk (by default at `~/workspace/hive/`) and serves as the single source of truth for the entire multi-agent floor:

```
hive/
├── PROTOCOL.md             # Agent contract: rules for communication and memory
├── registry.json           # Live roster of all floor agents, roles, and status
├── board.md                # Shared project blackboard / co-authored plans
├── tasks.json              # Task ledger powering the Kanban board
├── log.jsonl               # Append-only chronological event feed
└── agents/
    └── <agent-id>/
        ├── identity.md     # Persona, role, and capabilities (read at start)
        ├── memory.md       # Long-term private memory (updated autonomously)
        ├── inbox/          # Messages delivered TO this agent (<ts>-<id>.json)
        │   └── .done/      # Processed messages archive
        ├── outbox/         # Outgoing messages waiting for delivery
        └── cursor.json     # Message delivery and processing cursor
```

---

## 2. Core Components

### A. The Agent Contract (`PROTOCOL.md`)
Every agent has access to `PROTOCOL.md`, which teaches it how to operate in a multi-agent environment:
1. **Startup Check**: On waking or starting a task, the agent reads its `memory.md` and checks its `inbox/`.
2. **Knowledge Recording**: Key decisions, codebase facts, and findings are appended to `memory.md`.
3. **Inter-Agent Messaging**: When an agent needs help or has completed work for a teammate, it writes a message JSON to its `outbox/`.
4. **Safety Rule**: An agent never writes directly to another agent's directory. All delivery is mediated by the background router.

### B. Live Roster (`registry.json`)
Maintains a dynamic registry of all agents on the floor:
- Agent ID, human-readable name, and assigned role (e.g. Frontend Engineer, Database Specialist).
- CLI provider (`opencode`, `claude`, `codex`, `agy`) and model configuration.
- Floor orchestrator reference (`godId`) to designate the lead coordinator.

### C. Isolated Workspaces (`agents/<id>/`)
Each agent has a dedicated folder ensuring **single-writer isolation**:
- `identity.md`: Tailored persona instructions generated during registration.
- `memory.md`: Durable factual context preserved across sessions and restarts.
- `inbox/`: Unread messages delivered by the router.
- `outbox/`: Outgoing message queue.

### D. Chronological Event Feed (`log.jsonl`)
An append-only log capturing every spawn, message route, task status update, and blackboard change. This log drives activity feeds and UI animations in real time.

---

## 3. Server Integration (`apps/server/src/hive.ts`)

The `HiveManager` class oversees the coordination lifecycle:
- **`initHive()`**: Initializes directory structures, seeds protocols, registers default tasks, and ensures files exist.
- **`registerAgent(meta)`**: Provisions new agent directories and synchronizes SQLite state into `registry.json`.
- **`routeOnce()`**: Atomic scan-and-deliver cycle that empties outboxes and populates inboxes.
- **`startRouter(intervalMs)`**: Continuous background daemon ensuring sub-second delivery of inter-agent communications.

---

## 4. API Endpoints

- `GET /api/hive/roster`: Returns the full registry and active agents.
- `GET /api/hive/board`: Retrieves the shared blackboard contents.
- `POST /api/hive/board`: Updates the shared blackboard.
- `GET /api/hive/tasks`: Retrieves all tasks.
- `POST /api/hive/tasks`: Creates or updates a Kanban task.
- `GET /api/hive/messages?agentId=...`: Fetches an agent's inbox and outbox message threads.
- `POST /api/hive/messages`: Sends an inter-agent message.
- `GET /api/hive/memory/:id`: Retrieves an agent's private memory.
- `POST /api/hive/memory/:id`: Saves updates to an agent's private memory.
