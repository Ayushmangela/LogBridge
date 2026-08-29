# Spatial Private Room Chat & Automatic Project Membership

Antigravity has engineered a Gather.town-inspired spatial communication layer and unified team membership system for LogBridge. Real users can walk their pixel-art avatars into designated office rooms—the **Boss Executive Cabin (`cabin0`)**, **Senior Cabins 1–3 (`cabin1`–`cabin3`)**, or the **Executive Meeting Room (`collaborating`)**—to engage in private, in-room conversations with live speech bubbles and a dedicated floating HUD. Furthermore, all registered team members are automatically enrolled in project workspaces.

---

## 1. Core Capabilities

1. **Spatial In-Room Communication (Gather.town Style)**:
   - When users move their character into private zones (Executive Cabins or Meeting Room), a glassmorphic **Private Channel HUD (`#room-comms-bar`)** appears at the bottom of the screen.
   - The HUD displays the room badge, active participants in the room, recent room messages, and a dedicated chat input.
   - Audio feedback (synthesized Web Audio chimes) announces room entry and arrival of in-room messages.
   - Stepping outside the room immediately closes the private session.

2. **Avatar Speech Bubbles**:
   - Messages sent inside a room render as stylized speech balloons hovering above the speaking avatar's head on the office floor.
   - Bubbles smoothly track avatar motion and automatically fade out after a configurable reading window.

3. **Multi-User Presence & Coordinates Synchronization**:
   - The WebSocket gateway now tracks distinct authenticated user sessions (`userId`, `name`, `zone`).
   - Movements from each connected colleague stream to all office viewers, allowing teams to see each other walk across the floor, sit at desks, or meet in rooms in real time.

4. **Real-Time WebRTC Spatial Voice & Microphone (Gather.town Style)**:
   - Entering a private cabin or the meeting room connects users to a peer-to-peer WebRTC audio mesh.
   - **Microphone Toggle Button (`#btn-room-mic`)**: 1-click toggle between `🔇 Mic: Muted` and `🎙️ Mic: Live (On)` with active sound equalizer meter.
   - **Keyboard Shortcut**: Press <kbd>M</kbd> while in any private room to immediately toggle mute.
   - **Dynamic Speaking Indicators**: Real-time `AudioContext` and `AnalyserNode` monitoring calculates voice volume. When any user speaks, an animated pulsing green speaking ring is rendered directly around their pixel-art avatar on the office floor, and an active speaking badge (`🔊 Speaking...`) highlights their name in the room HUD.
   - **Audio Track Lifecycle**: Stepping out of the room automatically closes peer connections and mutes the mic.

5. **Instant Project Membership on Registration**:
   - The schema introduces the `project_members` table (`project_id`, `user_id`, `role`, `joined_at`).
   - When any user signs up (`POST /api/auth/signup`), they are automatically granted membership in all existing project workspaces.
   - When a new project is created (`POST /api/projects`), all existing registered users are automatically added as members.

---

## 2. Technical Implementation

### Database Schema (`apps/server/src/db.ts`)
```sql
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT,
  user_id TEXT,
  role TEXT DEFAULT 'member',
  joined_at TEXT,
  PRIMARY KEY (project_id, user_id)
);
```

### Protocol Extensions (`packages/protocol/src/view.ts`)
- **`RoomChatMessage`**: Schema validating in-room messages with `id`, `roomId`, `zone`, `from` (`id`, `name`, `avatar`), `text`, and `ts`.
- **`ClientMessage`**: Supports `{ type: "room_chat", roomId, zone, text, from }`, as well as optional `userId`, `name`, and `zone` on `position` and `join` messages.
- **`ServerMessage`**: Dispatches `{ type: "room_chat", roomId, msg: RoomChatMessage }` to all client sockets scoped to the project.

### Gateway Dispatcher (`apps/server/src/gateway.ts`)
- Maintains mapping of `WebSocket -> userId` and `WebSocket -> roomId`.
- Handles `room_chat` events, persists them to the event log, and broadcasts them exclusively to connected clients in the project.
- Cleans up disconnected positions upon socket close and triggers view re-broadcast.

### Frontend Spatial HUD & Rendering (`apps/web/index.html`)
- `updateSpatialRoomComms()`: Detects if player tile coordinates are within `zones.cabin[0..3]` or `zones.collaborating`. Toggles the floating comms bar and updates participant lists.
- `showSpeechBubble(bubbleObj, text)`: Renders PIXI graphics speech balloons with pointer tails anchored directly to the sprite.
- `playRoomChime()`: Web Audio API sine generator providing crisp auditory cues for room transitions and incoming chat.
- `sendRoomMessage()`: Dispatches spatial room messages to the gateway.
- `leavePrivateRoom()`: 1-click exit action that steps the player into the central corridor.
