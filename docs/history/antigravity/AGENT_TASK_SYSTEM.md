# Core Agent-Related Task & Execution System

Antigravity has engineered a comprehensive agent task lifecycle management, real-time control, live steering, execution tracing, and hierarchical goal decomposition suite for LogBridge.

---

## 1. Suite of 5 Core Agent Task Features

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CENTRAL COMMANDER GOAL INPUT                          │
│               "Build Real-time WebRTC Voice Chat System"                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                         [POST /api/commander/breakdown]
                                       │
     ┌─────────────────────────────────┼─────────────────────────────────┐
     ▼                                 ▼                                 ▼
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│  [Architecture & Schema]│ │    [Implementation]     │ │ [Testing & Verification]│
│  Assigned: Commander    │ │    Assigned: Developer  │ │ Assigned: Reviewer/QA   │
└────────────┬────────────┘ └────────────┬────────────┘ └────────────┬────────────┘
             │                           │                           │
             └───────────────────────────┼───────────────────────────┘
                                         ▼
                   ┌───────────────────────────────────────────┐
                   │       DIRECT AGENT TASK DISPATCHER        │
                   │  Modal: Title, Spec, Timeout, Budget Cap  │
                   └─────────────────────┬─────────────────────┘
                                         ▼
                   ┌───────────────────────────────────────────┐
                   │    LIVE EXECUTION CONTROLS & STEERING     │
                   │    • ⏸️ Pause Task    • ▶️ Resume Task    │
                   │    • ⏹️ Halt Task     • 🧭 Live Steer     │
                   └─────────────────────┬─────────────────────┘
                                         ▼
                   ┌───────────────────────────────────────────┐
                   │   STRUCTURED TRACE WATERFALL TIMELINE     │
                   │  🧠 THOUGHT   🛠️ TOOL   📄 OUTPUT          │
                   │  🧭 STEER     ⏸️ CONTROL 📋 TASK          │
                   └───────────────────────────────────────────┘
```

---

### Feature 1: Direct Agent Task Dispatcher & Assignment Modal
- **Quick Action Triggers**: A `🚀 Assign Task` button is seamlessly integrated on:
  - Sprite hover/click popup on the office floor (`#agent-popup`)
  - Slide-out Agent Inspector drawer (`#inspector`)
  - Command Center management toolbar (`#cc-manage`)
- **Dispatch Modal (`#dispatch-task-modal`)**:
  - Automatically targets the selected agent with visual avatar indicator.
  - Fields for **Task Title / Objective**, detailed **Context & Spec**, **Execution Timeout Cap** (30s – 1200s), and **Budget Limit** ($0.10 – $20.00).
- **Backend API**:
  - `POST /api/tasks`: Directly creates the task row with `state = 'submitted'`, dispatches offer to runner node socket via `sendTaskOffer`, moves agent status to `working`, and broadcasts updated workspace view.

---

### Feature 2: Live Task Steering & Context Injection (`steer`)
- **Dual-Mode Guidance**:
  - **Live Injection**: When the agent is actively executing a task, steering instructions are injected directly into the live running task loop, recorded in the `events` table under `type = 'task_steer'`, and relayed to the runner process over WebSocket.
  - **Queued Context**: If the agent is idle, the steer message is saved to agent memory and prepended to the prompt of its next task.
- **UI Enhancements**:
  - Upgraded Command Center **Steer** tab with an active execution status badge (`🟢 Live Task in Progress` vs `⚪ Agent is Idle`).
  - Added a 1-click `🧭 Steer` action directly inside the Agent Inspector for instantaneous mid-task corrections.

---

### Feature 3: Active Task Execution Controls (Pause, Resume, Halt)
- **Lifecycle Endpoints**:
  - `POST /api/tasks/:id/pause`: Suspends execution, sets task `state = 'paused'` and agent `status = 'waiting'`, and notifies the runner.
  - `POST /api/tasks/:id/resume`: Resumes work, returning `state = 'in_progress'` and `status = 'working'`.
  - `POST /api/tasks/:id/halt`: Gracefully cancels execution, records `ended_at`, cleans up active task references, and resets the agent to `idle`.
- **Dynamic Toolbar Controls**: Contextual `⏸️ Pause`, `▶️ Resume`, and `⏹️ Halt` buttons automatically appear in the Command Center header and Inspector drawer only when an active task is running.

---

### Feature 4: Step-by-Step Tool Execution Traces Timeline
- **Interactive Trace Waterfall (`ccRenderTraces`)**:
  - Visual step-by-step breakdown of agent actions categorized by color-coded badges:
    - 🧠 `THOUGHT` (Model planning & internal monologue)
    - 🛠️ `TOOL` (`read_file`, `write_file`, `bash`, `git`, etc.)
    - 📄 `OUTPUT` (Execution results & stdout)
    - 🧭 `STEER` (User-injected guidance directives)
    - ⏸️ `CONTROL` (Pause, resume, and halt lifecycle checkpoints)
    - 📋 `TASK` (Task offer & acceptance events)
  - Monospace timestamps, task tags, expandable JSON payload viewers, and a real-time refresh button.
- **Backend Endpoints**: `GET /api/agents/:id/traces` and `GET /api/tasks/:id/traces`.

---

### Feature 5: Central Commander Hierarchical Subtask Breakdown & Delegation
- **Epic Delegation Action**: When viewing the Central Commander (`role = 'planner'`), a prominent `👑 Delegate Epic` button appears in the toolbar.
- **Automated Specialist Delegation (`POST /api/commander/breakdown`)**:
  - Creates an Epic Goal parent task (`kind = 'plan'`).
  - Automatically identifies available specialist agents (Commander/Planner, Developer/Coder, Reviewer/QA).
  - Decomposes the epic into 3 linked child subtasks (`parent_task = parentId`):
    1. `[Architecture & Schema]` ➔ Assigned to Commander / Planner
    2. `[Implementation]` ➔ Assigned to Developer
    3. `[Testing & Verification]` ➔ Assigned to Reviewer / QA
  - Dispatches offers to specialist runners simultaneously and broadcasts view.

---

## 2. API Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/tasks` | Direct task creation and agent dispatch offer |
| `POST` | `/api/agents/:id/steer` | Injects real-time guidance into active task or queues for next task |
| `POST` | `/api/tasks/:id/pause` | Pauses active task execution and puts agent in waiting status |
| `POST` | `/api/tasks/:id/resume` | Resumes paused task execution and sets agent to working status |
| `POST` | `/api/tasks/:id/halt` | Aborts running task and resets agent to idle |
| `GET` | `/api/agents/:id/traces` | Returns structured waterfall execution events for an agent |
| `GET` | `/api/tasks/:id/traces` | Returns ordered trace steps for a specific task |
| `GET` | `/api/agents/:id/tasks` | Returns historical run log of tasks executed by an agent |
| `POST` | `/api/commander/breakdown` | Decomposes high-level epic into specialist subtasks and delegates |
