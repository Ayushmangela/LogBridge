# LogBridge — Live Demo & System Walkthrough

> **Live System URL:** [http://localhost:8787](http://localhost:8787) (or `http://127.0.0.1:8787`)
> **Status:** Server & Node Runner Active with **Commando** and **3 OpenCode Developer Agents**

---

## 1. System Setup & Architecture in Motion

The LogBridge system is fully live and running in your local workspace environment:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 LOGBRIDGE CENTRAL SERVER               │
                  │                 (Fastify · WebSocket · SQLite)         │
                  └───────────────────────────┬────────────────────────────┘
                                              │
                     ┌────────────────────────┴────────────────────────┐
                     │                                                 │
          WebSocket /node-ws                                WebSocket /ws (Broadcast)
                     │                                                 │
  ┌──────────────────▼──────────────────┐            ┌─────────────────▼─────────────────┐
  │         LOCAL NODE RUNNER           │            │           WEB BROWSER UI          │
  │     (Ayush-Workstation Daemon)      │            │   (Pixel Office · Upper Navbar)   │
  ├─────────────────────────────────────┤            ├───────────────────────────────────┤
  │ 👑 Commando (Commander)             │            │ ⊞ Office Map (Live Pixi.js Canvas)│
  │ ⚡ Agent-Alpha (Frontend Specialist) │            │ 📈 Tasks & DAG Sequence Flow      │
  │ 🛠️ Agent-Beta (Backend Specialist)  │            │ 💬 Live Team & Agent Chat         │
  │ 🧪 Agent-Gamma (QA & Verification)  │            │ 🧠 Shared Associative Memory      │
  └─────────────────────────────────────┘            └───────────────────────────────────┘
```

---

## 2. Step-by-Step Walkthrough Guide

### Step 1: Open Application & Instant One-Click Login
1. Open your browser and navigate to **[http://localhost:8787](http://localhost:8787)**.
2. Click **⚡ One-Click Demo Access (Ayush)** to instantly log in as `Ayush Mangela`.

```
┌───────────────────────────────────────────────────────────────────┐
│                    LogBridge Virtual Workspace                    │
│                                                                   │
│   [ Ayush Mangela ]                                               │
│   [ ayush@logbridge.internal ]                                    │
│   [ ••••••••• ]                                                   │
│   [ Sign In → ]                                                   │
│                                                                   │
│   -------------------------------------------------------------   │
│   [ ⚡ One-Click Demo Access (Ayush) ]                           │
└───────────────────────────────────────────────────────────────────┘
```

---

### Step 2: Enter the Project Workspace
1. In the **Project Workspaces** overview, select **LogBridge Virtual Workspace** (`prj_main`).
2. You will be taken directly onto the live office floor!

---

### Step 3: The 2D Pixel Office & Upper Navigation Bar

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [🏠 Floor 1 / Workspace ▾]   [ ⊞ Office Map ] [ 📈 Tasks ] [ 💬 Chat (1) ] [ 🧠 Memory ] [ ⛶ ]  [● Online] [👤 Ayush]│
├─────────────────┬──────────────────────────────────────────────────────────────────────────────────────┤
│ AI AGENTS (4) + │                                                                                      │
│ ● Commando      │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                │
│ ● Agent-Alpha   │  │   Dev Room   │  │ Review Room  │  │   QA Room    │  │Command Center│                │
│ ● Agent-Beta    │  │  (Alpha/Beta)│  │ (Agent-Gamma)│  │ (Test Suite) │  │  (Commando)  │                │
│ ● Agent-Gamma   │  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘                │
│                 │                                                                                      │
│ PEOPLE (1)    + │  ┌──────────────────────────────────────────────────────────────────┐                │
│ ● Ayush (You)   │  │                       ATRIUM (Central Corridor)                  │                │
│                 │  └──────────────────────────────────────────────────────────────────┘                │
│                 │                                                                                      │
│ [◀ Collapse]    │  ┌──────────────────────────────┐          ┌────────────────────────┐                │
│                 │  │      Open Office Desks       │          │      Meeting Room      │                │
│                 │  └──────────────────────────────┘          └────────────────────────┘                │
└─────────────────┴──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Upper Navbar Tabs**:
  - `[ ⊞ Office Map ]`: Vibrant indigo gradient active tab rendering the live Pixi.js tilemap.
  - `[ 📈 Tasks ]`: Interactive Kanban & DAG execution sequence flow.
  - `[ 💬 Chat ]`: Live real-time chat with speech bubbles over characters on the floor.
  - `[ 🧠 Memory ]`: Shared team memory board with BM25 associative search.
  - `[ ⛶ ]`: One-click Fullscreen toggle.
- **Left Sidebar**:
  - Exclusively dedicated to **AI Agents** and **People** with live status dots (`working`, `reviewing`, `online`) and count badges.

---

### Step 4: Live Multi-Agent Pod Roster

| Agent Name | Role | Provider | Assigned Folder | Current Task / Status |
|---|---|---|---|---|
| 👑 **Commando** | Commander / Orchestrator | `opencode` | `LogBridge` | 1. Decompose System Architecture & DAG Flow (`done`) |
| ⚡ **Agent-Alpha** | Developer (Frontend) | `opencode` | `apps/web` | 2. Implement Upper Navbar Pill Tabs & Roster Dock (`working`) |
| 🛠️ **Agent-Beta** | Developer (Backend) | `opencode` | `apps/server` | 3. Real-time WebSocket Protocol & DAG Engine (`working`) |
| 🧪 **Agent-Gamma** | Developer (QA / CI) | `opencode` | `packages/protocol` | 4. Automated Test Suite & Multi-Agent Verification (`review`) |

---

### Step 5: Command Center & Live Agent Inspector
1. Click on **`Commando`** or **`Agent-Alpha`** in the left roster to open the **Command Center**.
2. **Explore the Tabs**:
   - **Terminal**: Live interactive PTY terminal (`xterm.js`) connected to the runner.
   - **Workflows**: Multi-Agent DAG workflow graph with task step dependencies.
   - **Traces**: Tool call timelines, token expenditures, and execution step breakdowns.
   - **Memory**: Extracted `REMEMBER:` knowledge items and team learnings.

---

### Step 6: Real-Time Chat & Autonomous Communication
1. Click the **Chat** tab in the top navbar.
2. View existing messages from `Commando`:
   > *"🚀 LogBridge Autonomous Multi-Agent Workspace initialized! All 3 developer pods (Alpha, Beta, Gamma) are connected and active."*
3. Type `@Commando Run test suite verification` to see live broadcast speech bubbles over the agents!
