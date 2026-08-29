# Persistent Long-Term Memory & Shared Blackboard

Designed and implemented by **Antigravity**, this dual-tier knowledge system gives each agent private, persistent memory while providing a shared project blackboard for global architecture and planning.

---

## 1. Dual-Tier Memory Architecture

```
┌──────────────────────────────────────────────┬──────────────────────────────────────────────┐
│       Private Long-Term Memory               │           Shared Project Blackboard          │
│       `agents/<agent-id>/memory.md`          │           `hive/board.md`                    │
├──────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ - Private to this specific agent             │ - Visible to all floor agents & humans       │
│ - Durable codebase facts, bugs, caveats      │ - Architecture blueprints & co-authored plans│
│ - Read at task start, updated on completion  │ - Maintained collaboratively                 │
│ - Preserved across restarts & sessions       │ - Single source of truth for global specs    │
└──────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

---

## 2. Agent Private Memory (`memory.md`)

Each agent maintains a persistent markdown file inside its Hive directory:
- **Startup Learning**: When an agent launches, it reads its `memory.md` to recall past learnings, style preferences, and debugging findings.
- **Autonomous Recording**: As tasks complete, the agent appends lessons learned to avoid repeating past mistakes.
- **Human Editing**: Operators can inspect or guide an agent's memory directly through the Command Center UI.

---

## 3. Shared Project Blackboard (`board.md`)

Located at the root of the Hive (`hive/board.md`), the blackboard serves as a shared coordination space:
- **Co-Authored Plans**: Agents write requirements, API contracts, and integration points for their teammates to see.
- **Specification Source**: Prevents conflicting assumptions across specialists (e.g. backend and frontend agreeing on route schemas).
- **Orchestrator Oversight**: The floor orchestrator uses the blackboard to track global milestones and project deliverables.

---

## 4. Web UI Split Editor (`Memory` Tab)

The Command Center **Memory** tab features a side-by-side dual-pane editor:
- **Left Pane (`Private Memory`)**:
  - Displays the active agent's `memory.md`.
  - Styled with a warm paper background (`#FCFAF0`) and monospace typography.
  - Includes a `Save Memory` button wired to `POST /api/hive/memory/:id`.
- **Right Pane (`Shared Blackboard`)**:
  - Displays the global `board.md`.
  - Accessible from any agent's Command Center view.
  - Includes a `Save Blackboard` button wired to `POST /api/hive/board`.
