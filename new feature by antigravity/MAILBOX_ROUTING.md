# FIPA-Lite Inter-Agent Mailbox & Routing Engine

Designed and implemented by **Antigravity**, the **Mailbox & Routing Engine** provides an asynchronous, speech-act-based communication protocol for autonomous AI agents in LogBridge.

---

## 1. Overview

Instead of fragile direct network calls or shared-memory collisions, agents communicate through **structured speech acts** placed in file-based mailboxes. The server's background router regularly sweeps outgoing queues, validates schemas, routes envelopes into destination inboxes, and broadcasts delivery events to the UI.

```
Agent A                                                                Agent B
┌─────────────────────┐                                                ┌─────────────────────┐
│  Writes JSON to:    │                                                │  Reads message from:│
│  agents/A/outbox/   │                                                │  agents/B/inbox/    │
└──────────┬──────────┘                                                └──────────▲──────────┘
           │                                                                      │
           ▼                                                                      │
   ┌───────────────┐        ┌────────────────────────────┐        ┌───────────────┴─────┐
   │ Outbox Queue  │ ───►   │     Hive Router Loop       │  ───►  │    Inbox Queue      │
   └───────────────┘        │  (atomic delivery & logs)  │        └─────────────────────┘
                            └──────────────┬─────────────┘
                                           │
                                           ▼
                            WebSocket: `hive:event` (Live UI)
```

---

## 2. Speech Acts & Message Schema

Messages follow a structured FIPA-Lite standard designed for autonomous multi-agent systems:

```jsonc
{
  "id": "2026-08-27T12-30-00-123Z-a1b2",   // Unique, timestamp-prefixed ID
  "conversation": "conv-4f9e",             // Groups related messages in a thread
  "in_reply_to": null,                     // ID of message being replied to
  "from": "agt_frontend",                  // Sender agent ID
  "to": "agt_backend",                     // Recipient ID, 'god', or 'broadcast'
  "act": "request",                        // Speech act type
  "subject": "Add user profile endpoint",  // Brief summary
  "body": "Need GET /api/user/:id with auth guards.", // Payload
  "hops": 0,                               // Incremented per reply (prevents loops)
  "requires_reply": true,                  // Whether recipient must respond
  "needs_human": false,                    // Set to true to escalate to human
  "created_at": "2026-08-27T12:30:00.123Z"
}
```

### Supported Speech Acts

| Speech Act | Meaning | Obligates Reply? |
| :--- | :--- | :--- |
| `request` | Asking another agent to perform a specific action or task. | **Yes** |
| `query` | Asking a clarifying or informational question. | **Yes** |
| `propose` | Suggesting an architectural approach or plan. | **Yes** |
| `inform` | Sharing status, results, or data. Terminal state. | No |
| `agree` | Accepting a previously proposed plan or request. | No |
| `refuse` | Declining a request with explanation. | No |
| `done` | Confirming completion of a requested deliverable. | No |

---

## 3. Anti-Livelock & Routing Safety

To ensure agents do not enter infinite communication ping-pong loops:
1. **Hop Count Limiter**: Every reply increments the `hops` field. Once it exceeds a preset threshold, the message is routed to the orchestrator for escalation.
2. **Terminal Acts**: Pure `inform` and `done` acts do not obligate a response.
3. **Target Routing**:
   - `to: "<agent-id>"`: Delivers directly to that specific agent's inbox.
   - `to: "god"` or `"orchestrator"`: Routes directly to the floor orchestrator.
   - `to: "broadcast"`: Replicates delivery across all active agents on the floor.

---

## 4. Web UI Integration (`Messages` Tab)

The Command Center now includes a dedicated **Messages** interface:
- **Directional Tags**: Clear visual distinction between incoming (`📥 from <sender>`) and outgoing (`📤 to <recipient>`) communications.
- **Color-Coded Badges**: Unique styles for each speech act (`act-request`, `act-inform`, `act-done`, etc.).
- **Live Message Composer**:
  - Target selector (specific agent, orchestrator, or broadcast).
  - Speech act selector.
  - Subject and body fields with immediate delivery and live inbox refresh.
- **Filters**: Quickly narrow view to `All`, `📥 Inbox`, or `📤 Outbox`.
