# Visual Meeting Room Collab (Milestone M5)

Implemented by **Antigravity**, the **Visual Meeting Room Collab** bridges inter-agent messaging with real-time 2D pixel-art animations on the office floor.

Whenever two AI agents exchange messages through the Hive Mailbox (such as a Commander delegating a mission, or a Designer reviewing specs with a Developer), their characters **physically walk across the corridor and sit around the conference table in the glass 🤝 Meeting Room**.

---

## 1. How It Works

```
        Agent A                                      Agent B
   (e.g. Commander)                             (e.g. Developer)
          │                                            │
          └───► Outbox Message (`act: "request"`) ─────┘
                               │
                Hive Router (`HiveManager.ts`)
                               │
            Auto-Engages Active Meeting Collaboration
                               │
                        broadcastView()
                               │
             `buildView()` sets `av.zone = "collaborating"`
             and assigns conference table slots
                               │
                         WebSocket Push
                               │
            Pixi.js Ease Loop: Walking Animation across Floor
                               │
                               ▼
        ┌──────────────────────────────────────────────┐
        │               🤝 MEETING ROOM                │
        │   Characters take seats at conference table  │
        │       Purple badge: [MEETING] active         │
        └──────────────────────────────────────────────┘
```

---

## 2. Core Capabilities

### 1. Automatic Messaging Engagement
- When an agent sends a FIPA-Lite message (`request`, `query`, `propose`, `inform`), `HiveManager` automatically initiates a meeting collaboration between the two agents.
- When `done` or `agree` is exchanged, the meeting enters a wrap-up cooldown before agents walk back to their desks.

### 2. Live Dynamic Zone Resolution
- In `apps/server/src/view.ts`, communicating agents are dynamically placed in the `collaborating` zone (tile coordinates x47, y26 in `assets/office.json`).
- Their `waitingOn` field dynamically shows their meeting partner's name.

### 3. Quick Action: `🤝 Meet with...` in Command Center
- In the Command Center header of any agent, click the purple **`🤝 Meet with...`** button.
- Select any other agent on the floor.
- Both agents immediately stand up from their desks and walk across the office floor into the Meeting Room together.

### 4. REST API
- `POST /api/hive/meeting`:
  ```json
  {
    "agentA": "agt_commander",
    "agentB": "agt_developer",
    "action": "start",
    "durationSeconds": 60,
    "reason": "Sprint Planning"
  }
  ```
- `GET /api/hive/meetings`: Lists all currently active meetings with remaining countdown times.
