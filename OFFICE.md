# Build Doc — The Pixel Office
### Front-end only. You can build 100% of this before the backend exists.

**You are building:** a top-down pixel office that shows *real* people and *real* AI agents working on real projects. Rooms, avatars, status zones, click-to-inspect.

**You are NOT building:** any AI logic, any networking logic beyond one WebSocket, any game mechanics. No collision with furniture, no inventory, no NPCs, no minigames.

---

## The one rule that defines this whole job

> ### Position is a pure function of state.
> You never decide where an agent goes. **The server sends you a `zone`, you put the sprite in that zone.** If no message arrives, nothing moves. There is no wander loop, no idle animation, no random motion, no "make it look busy."
>
> If a sprite moves, a real thing happened on someone's real computer. That's the entire point of the product.

The one exception: **humans move freely** (WASD). That's fine — a human moving is a real person choosing to move.

---

## Day 1: you are unblocked

You do **not** wait for the backend. Step 2 gives you a mock server that speaks the exact same protocol with fake data. Build the entire office against it. On the day the real server is ready, you change one URL.

---

# THE CONTRACT (frozen — identical in Ayush's doc)

> **This is a copy for reading convenience. [`CONTRACT.md`](CONTRACT.md) is the source of truth — if they ever disagree, that file wins.** Current version: **1.5**. Never change it without the other person present.

This is the only thing the two halves share. **Neither side changes it alone.**

## What you receive

The server sends you the **whole workspace view** on connect, and again every time anything changes. It's small (a few KB for 4 people) — no deltas, no patching, no diffing. Just replace your state and re-render.

```ts
type ServerMessage =
  | { type: "view";  view: WorkspaceView }        // full state, replaces everything
  | { type: "chat";  roomId: string; msg: ChatMessage }

type WorkspaceView = {
  seq: number                  // increases every update; ignore anything older
  serverTime: string           // ISO
  meId: string                 // which human is you
  rooms: Room[]
}

type Room = {
  id: string                   // "prj_acme_api"
  name: string                 // "acme/api"      ← show this
  callLink: string | null      // Discord/Meet link, render as a button
  layout: string               // "office_a"      ← which map file to draw
  humans: HumanView[]
  agents: AgentView[]
  machines: MachineView[]
}

type HumanView = {
  id: string
  name: string                 // "sam"
  avatar: number               // 0-7, pick a character sprite by index
  presence: "online" | "away" | "offline"
  position: { x: number; y: number } | null   // TILE coords, null = at their cabin desk
  cabin: number | null         // 0-3, which private office is theirs. 0 = boss cabin
}

type AgentView = {
  id: string
  name: string                 // "dev-api"       ← show this
  ownerId: string
  ownerName: string            // "ayush"
  machineId: string
  machineName: string          // "ayush-mbp"     ← show this under the sprite
  role: "developer" | "research" | "qa" | "review" | "docs" | "planner"
  status: AgentStatus
  zone: ZoneId                 // ★ WHERE YOU PUT IT. Server decides. You obey.
  slot: number                 // 0,1,2… position within the zone, so sprites don't overlap
  zoneAnchor: number | null    // when zone === "needs_human": WHICH cabin (0-3) to stand in
  task: {
    id: string
    title: string              // "Add JWT auth"
    elapsedSec: number
    costUsd: number
    note: string | null        // "running test suite"
  } | null
  waitingOn: string | null     // "qa-api@sams-mbp" | "human: ayush" | "CI"
  githubRef: { kind: "pr" | "issue"; ref: string } | null   // "acme/api#212"
}

type AgentStatus =
  | "idle" | "working" | "waiting" | "blocked"
  | "needs_input" | "reviewing" | "completed" | "failed"

type ZoneId =
  | "idle" | "working" | "reviewing" | "collaborating"
  | "blocked" | "needs_human" | "done"

type MachineView = {
  id: string
  name: string                 // "sams-mbp"
  ownerId: string
  online: boolean              // ★ show an offline machine clearly — it means
  lastSeen: string             //   that person's agents can't take work
}

type ChatMessage = {
  id: string
  roomId: string
  from: { kind: "user" | "agent"; id: string; name: string }
  text: string
  ts: string
  // when an agent asks a question, this is set — render the buttons
  ask: { taskId: string; options: ("approve"|"edit"|"reject"|"answer")[] } | null
}
```

## What you send

Only three things. Everything else is Ayush's side.

```ts
type ClientMessage =
  | { type: "position"; roomId: string; x: number; y: number }
  | { type: "chat";     roomId: string; text: string }
  | { type: "answer";   taskId: string; choice: "approve"|"edit"|"reject"|"answer"; text?: string }
```

Send `position` **at most 5× per second** (throttle it), and only when the position actually changed.

## Zone → meaning (for your labels and colours)

| zone | label | colour | meaning |
|---|---|---|---|
| `working` | WORKING | green | actually running right now — open office |
| `reviewing` | REVIEWING | blue | reviewing someone's code — atrium, lower half |
| `collaborating` | MEETING | purple | working *with an agent on someone else's machine* — the meeting room |
| `blocked` | BLOCKED | amber | waiting on CI or a build — atrium, upper half |
| `idle` | IDLE | grey | nothing to do — cafeteria |
| `done` | DONE | faded green | just finished — chill room |
| `blocked` | BLOCKED | amber | waiting on CI, a delegate, a dependency |
| `needs_human` | ⚑ NEEDS HUMAN | red, **pulses** | a *specific* person must answer — the agent stands in **their** cabin. The only animated thing in the room |
| `done` | COMPLETED | faded green | finished recently; fades out after ~2 min |

**`needs_human` is the most important zone in the product.** Make it impossible to miss.

**`collaborating` is the most impressive one.** It means two agents on two different laptops are working together right now — the hardest feature in the project, and the only place you can actually see it happen.

---

# BUILD STEPS

## Step 1 — Project setup *(30 min)*

```bash
npm create vite@latest office -- --template react-ts
cd office
npm install
npm install pixi.js @pixi/tilemap
npm install -D @types/node
```

Folder layout:

```
office/
├── public/assets/          ← tilesets + character sheets go here
├── src/
│   ├── contract.ts         ← paste the types above. Never edit alone.
│   ├── mock/mockServer.ts  ← step 2
│   ├── net/useWorkspace.ts ← WS hook, returns WorkspaceView
│   ├── pixi/
│   │   ├── Stage.tsx       ← mounts the Pixi app into React
│   │   ├── drawRoom.ts     ← floor + walls from a layout file
│   │   ├── zones.ts        ← zone rectangles + labels
│   │   ├── avatars.ts      ← sprite creation + placement
│   │   └── layouts/office_a.json
│   └── ui/                 ← React overlays: chat, detail panel, room list
```

**Key architectural call:** Pixi draws the *world* (floor, walls, sprites). React draws all *UI* (chat, panels, buttons) as normal HTML on top. Do not build UI inside Pixi — it's painful and you don't need to.

---

## Step 2 — Mock server *(45 min — do this before anything visual)*

This is what unblocks you. One file, plain Node, no dependencies except `ws`.

```bash
npm install -D ws @types/ws tsx
```

`mock/mockServer.ts` — serve a `WorkspaceView` on connect, then mutate it on a timer so you can see state changes drive the office:

```ts
import { WebSocketServer } from "ws";

let seq = 0;
const view = { /* one room, 3 humans, 5 agents, hand-written */ };

const wss = new WebSocketServer({ port: 8787 });
wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "view", view: { ...view, seq: ++seq } }));

  // every 4s, move one agent to a different zone — proves your renderer reacts
  const t = setInterval(() => {
    const a = view.rooms[0].agents[Math.floor(Math.random() * 5)];
    a.zone = ["idle","working","reviewing","blocked","needs_human"][Math.floor(Math.random()*5)];
    a.status = a.zone === "needs_human" ? "needs_input" : a.zone as any;
    ws.send(JSON.stringify({ type: "view", view: { ...view, seq: ++seq } }));
  }, 4000);

  ws.on("close", () => clearInterval(t));
});
console.log("mock on ws://localhost:8787");
```

Write **realistic** fake data — real-looking agent names (`dev-api`, `qa-api`, `review-api`), real machine names, real task titles. Fake data that looks fake makes you design for fake data.

Run it: `npx tsx src/mock/mockServer.ts`

**✅ Done when:** you can connect with a browser console and see the view arrive and change every 4 seconds.

---

## Step 3 — Get assets *(1 hour, mostly browsing)*

You need three things. **Check the license on every page before you use it** — some are free, some are a few dollars, some require attribution.

| What | Where | Notes |
|---|---|---|
| **Office tileset** (floors, walls, desks, chairs, plants) | [LimeZu — Modern Office 16×16](https://limezu.itch.io/modernoffice) · [LimeZu — Modern Interiors](https://limezu.itch.io/moderninteriors) | The best-looking option by a distance. Has free and paid tiers — check which files you get |
| | [Pixel Office 32×32](https://masalimov-ilnur.itch.io/pixel-office) | 32×32 alternative, simpler |
| | [Kenney.nl](https://kenney.nl/assets) | **CC0, no attribution needed.** Less office-specific but zero license worry — good fallback |
| **Characters** | LimeZu packs include characters (matching style — prefer this) | |
| | [LPC Spritesheet Generator](https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/) | Free, generate as many characters as you want. **CC-BY-SA — you must credit.** Keep a CREDITS.md |
| **Pixel font** | [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) (Google Fonts) | Free. Tiny and readable at small sizes |

### What you actually need — smaller than you think

- **Floor tiles:** 3–4 variants. That's it.
- **Wall tiles:** top, left, right, corners. ~6 tiles.
- **Furniture:** desk, chair, plant, whiteboard, server rack, sofa. ~6 objects. Purely decorative.
- **Human characters:** 8 sprites, **4-direction walk cycle** (4 frames each = 16 frames per character).
- **Agent characters:** 6 sprites (one per role), **single idle frame each. Agents don't walk, so they need no walk cycle at all.** This saves you most of the character work.

> The map is **32 × 32**. Never mix sizes. Render at 2× or 3× scale so it looks crisp. `PIXI.TextureSource.defaultOptions.scaleMode = "nearest"` or everything will be blurry.

---

## Step 3.5 — ⚠ Handle the tile rotation flags *(15 min — skip this and every vertical wall renders wrong)*

LimeZu's wall tiles carry their dark outline on the **top and bottom edges only**, so every vertical wall run in the map is stored **rotated 90°**. Tiled encodes that in the top three bits of the gid:

```ts
const FLIP_H = 0x80000000, FLIP_V = 0x40000000, FLIP_D = 0x20000000;

function drawTile(rawGid: number, x: number, y: number) {
  const flipH = !!(rawGid & FLIP_H);
  const flipV = !!(rawGid & FLIP_V);
  const flipD = !!(rawGid & FLIP_D);
  const gid   = rawGid & 0x1FFFFFFF;        // ← always mask before lookup
  const sprite = spriteFor(gid);
  // diagonal + horizontal == 90° clockwise, which is all this map uses
  if (flipD && flipH) { sprite.rotation = Math.PI / 2; sprite.anchor.set(0.5); }
  ...
}
```

**If you look up a gid without masking, you get an out-of-range index and a blank tile.** About 180 tiles in the map are rotated — all of them walls and door leaves.

---

## Step 4 — Draw the room *(2–3 hours)*

Room layout is a hand-written JSON file. Don't build a level editor. Don't use Tiled unless you already know it.

`pixi/layouts/office_a.json`:

```json
{
  "tileSize": 16,
  "width": 40, "height": 24,
  "floor":  [[1,1,2,1,...], ...],
  "walls":  [[9,9,9,9,...], ...],
  "props":  [ { "tile": 21, "x": 6,  "y": 4 },
              { "tile": 22, "x": 7,  "y": 4 } ],
  "zones": [
    { "id":"idle",        "x":2,  "y":3,  "w":8, "h":6 },
    { "id":"working",     "x":12, "y":3,  "w":10,"h":6 },
    { "id":"reviewing",   "x":24, "y":3,  "w":8, "h":6 },
    { "id":"blocked",     "x":2,  "y":12, "w":8, "h":6 },
    { "id":"needs_human", "x":12, "y":12, "w":10,"h":6 },
    { "id":"done",        "x":24, "y":12, "w":8, "h":6 }
  ],
  "spawn": { "x": 20, "y": 21 }
}
```

Draw order — three Pixi `Container`s, back to front:
1. **floor** — a `CompositeTilemap` from `@pixi/tilemap`, drawn once, never touched again
2. **props + walls** — static sprites, drawn once
3. **actors** — humans and agents, the only layer that ever updates

**✅ Done when:** you see a static office. No avatars yet.

---

## Step 5 — Zones *(1 hour)*

For each zone in the layout, draw:
- a translucent rounded rectangle in the zone colour (`Graphics`, alpha ~0.12)
- a label in the pixel font at the top-left: `WORKING (2)` — the count comes from the view

The count updating is your first proof the office is showing real state.

**✅ Done when:** six labelled coloured areas, counts at 0.

---

## Step 6 — Avatars *(2–3 hours)*

Load your spritesheets with `PIXI.Assets.load()`. For humans use `AnimatedSprite` (walk cycles); for agents a plain `Sprite` is enough.

Each actor is a small `Container` holding:
```
Container
 ├── Sprite        the character
 ├── Text          name        "dev-api"     (above)
 ├── Text          machine     "ayush-mbp"   (below, smaller, dimmer)
 └── Graphics      status dot  (top-right, zone colour)
```

Agents also get a second line when `task` is set: `8m · $0.40`.

**Placing agents inside a zone — use the `slot` field:**

```ts
function slotPosition(zone: ZoneRect, slot: number, tileSize: number) {
  const perRow = Math.floor(zone.w / 2);           // 2 tiles per agent
  const col = slot % perRow;
  const row = Math.floor(slot / perRow);
  return {
    x: (zone.x + col * 2 + 1) * tileSize,
    y: (zone.y + row * 3 + 1) * tileSize,
  };
}
```

The server guarantees `slot` is stable and unique within a zone, so sprites never overlap and never jump around for no reason.

**Two zones have more than one rectangle in the map:**

- **`working`** — 4 rects (the desk pods), each with an `order` property. Sort by `order` and fill in sequence: slots 0–2 in pod A, 3–5 in pod B, and so on.
- **`cabin`** — 4 rects, each with an `index` property. These are the team's **private offices**, and they are used for two things:
  - a human whose `cabin` equals that `index` idles there when their `position` is null
  - **an agent with `zone === "needs_human"` stands in the cabin matching its `zoneAnchor`**

```ts
function rectFor(a: AgentView) {
  if (a.zone === "needs_human") return cabinRects[a.zoneAnchor!];   // whose office
  if (a.zone === "working")     return workingRects[Math.floor(a.slot / 3)];
  return singleRects[a.zone];
}
```

> There is **no rectangle named `needs_human`** in the map. Routing it to a specific cabin is what makes *"three agents are waiting on Sam"* readable — instead of just *"someone is needed."* Pulse the cabin that's occupied, not a generic room.

**✅ Done when:** agents from the mock server appear in the right zones with names and machine labels.

---

## Step 7 — Make state changes *move* things *(1–2 hours)*

This is the heart of the office.

When a new `view` arrives:
1. Match agents by `id` against what's on screen.
2. **New id** → create the container, fade it in over 200ms.
3. **`zone` or `slot` changed** → tween from current position to the new one over ~500ms with easing. Do **not** teleport — the movement is the information.
4. **Gone from the view** → fade out and destroy.
5. Update every label and the status dot.

Use a tiny tween helper or `PIXI.Ticker` with a manual lerp. You don't need a tween library.

> **Do not add any other motion.** No bobbing, no breathing, no idle sway, no walking to desks. The only movement in this room is caused by something that actually happened. That restraint is what makes the office trustworthy — and it's the thing that makes this different from every "AI office" demo.

**One exception:** the `needs_human` zone pulses (a slow alpha or scale pulse on the zone rectangle) **while and only while** at least one agent is in it. That's a real signal, not decoration.

**✅ Done when:** you watch the mock server for a minute and sprites glide between zones as the fake state changes.

---

## Step 8 — Human movement *(1–2 hours)*

- WASD / arrow keys move **your** avatar (`view.meId`) one tile at a time.
- Play the walk animation while moving, idle frame when stopped.
- Clamp to the room bounds. **Don't bother with furniture collision** — walking over a desk is not a bug worth two hours.
- Send `{ type: "position", roomId, x, y }` on change, throttled to 5/sec.
- Other humans' positions come back in the next `view` — tween them the same way as agents.

**✅ Done when:** two browser tabs, and you see your avatar move in the other tab.

---

## Step 9 — Click to inspect *(2 hours)*

Click any avatar → a React panel slides in from the right (plain HTML, not Pixi):

**Agent panel:**
```
dev-api                                    ● WORKING
developer · owned by ayush · on ayush-mbp

TASK    Add JWT auth to the API
        8m 04s · $0.40 · running test suite
        acme/api#212  ↗

WAITING ON  —

RECENT
  09:14  started
  09:16  read src/auth/user.ts
  09:19  delegated run_integration_tests → qa-api@sams-mbp
  09:22  ⚑ asked ayush: "push to main?"
```

**Human panel:** name, presence, their machines (with online/offline), their agents and what each is doing.

**Machine offline** must be loud: a red dot and the words *"offline — agents can't take work"*. This is the signal nothing else they use can show them.

**✅ Done when:** clicking anything shows real information from the view, and every panel closes cleanly.

---

## Step 10 — Chat + the answer buttons *(2 hours)*

A normal React chat panel down the right side, or across the bottom.

- Renders `ChatMessage[]`, humans and agents in the same feed.
- Agents styled differently (their role colour, monospace name).
- Input box sends `{ type: "chat", roomId, text }`.
- **When `msg.ask` is set, render the buttons under the message:** `[Approve] [Edit] [Reject] [Answer]`. Clicking sends `{ type:"answer", taskId, choice, text? }`.

That's the human-in-the-loop UI, and it's the second most important thing in the room after the `needs_human` zone.

**✅ Done when:** you can type in one tab and see it in another, and clicking Approve on a mock question sends the right message.

---

## Step 11 — Room switching + the board toggle *(2 hours)*

- Room list down the left: name, human count, agent count, and a **red badge if anything in it is `needs_human`**.
- Clicking switches which room the Pixi stage draws.
- **A toggle: Office ↔ Board.** The Board is the same `WorkspaceView` rendered as plain HTML columns — one column per zone, one card per agent. Half a day of work, and it's what people will actually use when they're busy.

> Same data, two renderers. **They can never disagree, because there's only one source.** That's the rule from the main plan, made real.

**✅ Done when:** the toggle flips instantly and both views show identical information.

---

## Step 12 — Connect to the real server *(15 min)*

Change `ws://localhost:8787` to the real URL. Everything else already works.

If you built against the contract honestly, this step is genuinely fifteen minutes. If it isn't, you took a shortcut somewhere — find it.

---

# Definition of done

- [ ] Office renders from a layout JSON with floor, walls, props, six labelled zones
- [ ] Agents appear in the zone the server says, at the slot the server says, never overlapping
- [ ] A zone change produces a smooth 500ms glide — and **nothing else in the room ever moves on its own**
- [ ] `needs_human` pulses only while occupied
- [ ] Names, machine names, task title, elapsed time and cost all visible under sprites
- [ ] Offline machines are unmistakable
- [ ] WASD moves you; other people's avatars move in your tab
- [ ] Clicking anything opens a panel with real data
- [ ] Chat works both ways; agent questions render answer buttons
- [ ] Office ↔ Board toggle, identical information in both
- [ ] Swapping the mock URL for the real one required no other change

---

# Things to deliberately NOT build

| Don't | Why |
|---|---|
| Furniture collision / pathfinding | Walking over a desk is not a bug. Costs hours, teaches nothing |
| Agents walking to desks | Breaks the one rule. Agents are *placed*, not animated |
| Idle animations, bobbing, ambient motion | Same reason. Every motion must mean something |
| Proximity voice / video | Whole separate project. There's a `callLink` button |
| A level editor | Hand-write the JSON. You need one or two rooms |
| Zoom / camera controls | Fit the room to the viewport. Add later if it's actually cramped |
| Custom avatar creator | `avatar: number` picks from 8. Done |
| Day/night, weather, decorations | No |

---

# If you get stuck

- **Blurry sprites** → `PIXI.TextureSource.defaultOptions.scaleMode = "nearest"` before loading anything
- **Pixi + React fighting** → mount the Pixi app once in a `useEffect` with `[]`, keep the app in a ref, never let React re-render the canvas
- **Sprites jumping around** → you're re-creating containers instead of matching by `id`. Match by id, mutate in place
- **Everything re-renders on each view** → keep the Pixi scene in a ref and diff manually; only React UI should re-render

**Useful references:** [PixiJS v8 getting started](https://generalistprogrammer.com/tutorials/pixijs-tutorial-getting-started-v8) · [Spritesheets in PixiJS](https://pixijs.com/7.x/guides/components/sprite-sheets) · [@pixi/tilemap docs](https://api.pixijs.io/@pixi/tilemap/Tilemap.html)

---

**Build order if you're short on time:** Steps 1, 2, 4, 6, 7 give you a working, honest office. Everything after that is refinement.
