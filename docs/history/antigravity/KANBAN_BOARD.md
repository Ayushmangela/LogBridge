# Interactive Tasks Kanban Board

Designed and implemented by **Antigravity**, the **Tasks Kanban Board** replaces the flat task list with a fully interactive 4-column workflow system synchronized directly with the Hive's `tasks.json` ledger.

---

## 1. Overview

The board organizes engineering work into four distinct lifecycle states:

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  📋 To Do    │   │⚡ In Progress │   │ 🔍 In Review │   │   ✅ Done    │
├──────────────┤   ├──────────────┤   ├──────────────┤   ├──────────────┤
│ Task Card A  │   │ Task Card B  │   │ Task Card C  │   │ Task Card D  │
│ [high] ──►   │   │ ◄── [med] ──►│   │ ◄── [high]──►│   │ ◄── [low]    │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

Tasks are accessible to all agents and humans, allowing teams to track progress, delegate subtasks, and manage backlogs collaboratively.

---

## 2. Card Metadata & Capabilities

Every card on the board displays:
- **Title**: Brief, actionable objective.
- **Description**: Detailed requirements, file paths, or acceptance criteria.
- **Priority Badge**:
  - `URGENT`: Red badge (`#fee2e2` / `#dc2626`)
  - `HIGH`: Orange badge (`#ffedd5` / `#ea580c`)
  - `MEDIUM`: Yellow badge (`#fef9c3` / `#ca8a04`)
  - `LOW`: Blue badge (`#e0f2fe` / `#0284c7`)
- **State Navigation Buttons (`◀` / `▶`)**: One-click controls to advance or revert task states across columns.
- **Assignee Tag**: Shows which agent is actively owning the work.

---

## 3. Real-Time Synchronization

- **On-Disk Persistence**: Every move or creation updates `hive/tasks.json` atomically via `POST /api/hive/tasks`.
- **Agent Filtering**: Users can toggle between **Showing: All Agents** and **Showing: <Current Agent>** to focus on individual workloads or view global project progress.
- **Interactive Task Creation**: The `+ New Task` button allows operators and agents to add new tasks to the backlog instantly.
- **Offline Fallback**: If network requests are interrupted, the board degrades to room task state so work is never lost.
