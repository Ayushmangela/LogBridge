# The Contract
### Single source of truth for everything exchanged between the office and the system.

**Version 1.5** · Copies of this appear inside `OFFICE.md` and `SYSTEM.md` for reading convenience. **If they ever disagree, this file wins.**

> **Rule: never change this file alone.** Both people present, both agree, bump the version, add a changelog line. A contract one person edited is not a contract.

---

## Who produces what

| | Produces | Consumes |
|---|---|---|
| **Server** *(you)* | `WorkspaceView`, `ChatMessage` | `ClientMessage` |
| **Office UI** | `ClientMessage` | `WorkspaceView`, `ChatMessage` |
| **Map file** *(friend)* | zone names, layer names | — |

---

## Server → browser

```ts
type ServerMessage =
  | { type: "view"; view: WorkspaceView }     // FULL state — replaces everything
  | { type: "chat"; roomId: string; msg: ChatMessage }

type WorkspaceView = {
  seq: number                  // increases every update; ignore anything older
  serverTime: string           // ISO 8601
  meId: string                 // which human the receiver is
  rooms: Room[]
}

type Room = {
  id: string                   // "prj_acme_api"
  name: string                 // "acme/api"          ← display this
  callLink: string | null      // Discord/Meet URL, render as a button
  layout: string               // "office"            ← which map file to draw
  humans: HumanView[]
  agents: AgentView[]
  machines: MachineView[]
}

type HumanView = {
  id: string
  name: string                 // "sam"
  avatar: number               // 0–7, index into the character sheet
  presence: "online" | "away" | "offline"
  position: { x: number; y: number } | null   // TILE coords; null = at their cabin desk
  cabin: number | null         // ★ 0-3, which private office is theirs. 0 = boss cabin
}

type AgentView = {
  id: string
  name: string                 // "dev-api"           ← display this
  ownerId: string
  ownerName: string            // "ayush"
  machineId: string
  machineName: string          // "ayush-mbp"         ← display under the sprite
  role: AgentRole
  status: AgentStatus
  zone: ZoneId                 // ★ server decides. office obeys.
  slot: number                 // ★ stable index within the zone
  zoneAnchor: number | null    // ★ when zone === "needs_human": WHICH cabin (0-3),
                               //   i.e. whose office the agent is standing in
  task: TaskBrief | null
  waitingOn: string | null     // "qa-api@sams-mbp" | "human: ayush" | "CI"
  githubRef: { kind: "pr" | "issue"; ref: string } | null   // "acme/api#212"
}

type TaskBrief = {
  id: string
  title: string                // "Add JWT auth"
  elapsedSec: number
  costUsd: number
  note: string | null          // "running test suite"
}

type MachineView = {
  id: string
  name: string                 // "sams-mbp"
  ownerId: string
  online: boolean              // ★ offline = that person's agents can't take work
  lastSeen: string
}

type ChatMessage = {
  id: string
  roomId: string
  from: { kind: "user" | "agent"; id: string; name: string }
  text: string
  ts: string
  ask: {                       // set when a human must respond
    taskId: string
    options: ("approve" | "edit" | "reject" | "answer")[]
  } | null
}
```

## Browser → server

```ts
type ClientMessage =
  | { type: "position"; roomId: string; x: number; y: number }   // throttle to 5/sec
  | { type: "chat";     roomId: string; text: string }
  | { type: "answer";   taskId: string;
      choice: "approve" | "edit" | "reject" | "answer"; text?: string }
```

## Enums

```ts
type AgentRole =
  | "developer" | "research" | "qa" | "review" | "docs" | "planner"

type AgentStatus =              // fixed by requirement 14 — do not add to this
  | "idle" | "working" | "waiting" | "blocked"
  | "needs_input" | "reviewing" | "completed" | "failed"

type ZoneId =
  | "idle" | "working" | "reviewing" | "collaborating"
  | "blocked" | "needs_human" | "done"
```

## Status → zone

Computed **server-side only**, in `buildView()`:

```ts
function zoneFor(a): ZoneId {
  if (a.status === "blocked" && a.waitingOn?.includes("@")) return "collaborating";
  if (a.status === "working" && a.hasLiveDelegation)        return "collaborating";
  switch (a.status) {
    case "idle": case "waiting":     return "idle";
    case "working":                  return "working";
    case "reviewing":                return "reviewing";
    case "blocked":                  return "blocked";
    case "needs_input":              return "needs_human";
    case "completed": case "failed": return "done";
  }
}
```

## Zone → room in the map

| Zone | Room | Map rects | Meaning |
|---|---|---|---|
| `needs_human` | **the cabin named by `zoneAnchor`** | *(uses `cabin` rects)* | A specific person must decide. **Pulses while occupied** |
| `working` | Open office, 4 desk pods | `working` × 4 *(`order` 0–3)* | Actively working right now |
| `blocked` | Atrium, upper half | 1 | Waiting on CI, a build, a dependency |
| `reviewing` | Atrium, lower half | 1 | Reviewing code |
| `collaborating` | Meeting room | 1 | Agents on **different machines** working together |
| `idle` | Cafeteria | 1 | Online, nothing to do |
| `done` | Chill room *(table tennis)* | 1 | Finished recently; fades after ~2 min |
| *(humans)* | The 4 private cabins | `cabin` × 4 *(`index` 0–3)* | A person's office. `HumanView.cabin` says whose |

**13 rectangles in the map, 7 distinct names.**

### The two zones with multiple rectangles

- **`working`** — 4 rects, sorted by `order`. Fill in sequence: slots 0–2 in pod A, 3–5 in pod B, and so on.
- **`cabin`** — 4 rects, keyed by `index` (**not** order). Used for two different things:
  - a human whose `cabin` matches that `index` idles there when `position` is null
  - an agent with `zone === "needs_human"` stands in the cabin matching its `zoneAnchor`

> **There is no rectangle named `needs_human` in the map.** The office resolves `needs_human` → the `cabin` rect whose `index` equals `zoneAnchor`. This is what makes *"three agents are waiting on Sam"* readable at a glance instead of just *"someone is needed."*

## Map file requirements

`public/assets/office.json`, exported from Tiled, tileset **embedded**.

| Layer | Type | Required |
|---|---|---|
| `floor` | tilelayer | ✅ |
| `walls` | tilelayer | ✅ |
| `props` | tilelayer | ✅ furniture |
| `props2` | tilelayer | ✅ desktop clutter + wall decor, drawn **above** `props` |
| `zones` | objectgroup | ✅ **13** named rects |
| `markers` | objectgroup | ✅ `spawn` point |

**64 × 40 tiles at 32 × 32 px** = 2048 × 1280 px. Object `x`/`y` are in **pixels** — divide by **32** for tile coords.

Five tilesets are registered in the map, all 32 px:

| Tileset | Tiles | Used for |
|---|---|---|
| `RoomBuilderOffice` | 224 | office wall/floor styles |
| `RoomBuilderFloors` | 600 | alternate floor library |
| `FloorAndGround` | 2560 | the floor in use |
| `RoomBuilderWalls` | 1280 | the wall library |
| `ModernOffice` | 848 | desks, chairs, sofas, screens, plants |
| `Generic` | 1248 | spare furniture |

**Tile gids may carry rotation flags.** Vertical wall runs are stored rotated 90° (`FLIP_D | FLIP_H`). Always mask with `gid & 0x1FFFFFFF` before looking a tile up, and apply the rotation when drawing. ~180 tiles are affected.

---

## Invariants — the reasons these choices exist

1. **Full snapshot every update, no deltas.** A few KB, four people. Deltas are a week of bugs for no benefit at this size. Revisit at 50 users, never before.
2. **The server computes `zone` and `slot`.** The mapping lives in exactly one place, so the office structurally *cannot* invent a position. This is how "no fake activity" is enforced rather than promised.
3. **`slot` is stable.** Same agent, same zone, same slot across updates — sort by `id` within the zone. Otherwise sprites jump every update.
4. **`collaborating` is derived, not a status.** Requirement 14 fixes the status list. The distinction is recoverable from `waitingOn`, so derive it.
5. **Only 3 client message types.** Everything else a human does goes through normal HTTP endpoints, not the socket.

---

## Changelog

| Version | Change | Why |
|---|---|---|
| **1.5** | Added a **`props2`** tile layer, drawn above `props`. White walls replace charcoal | Monitors, keyboards and papers have to sit *on* a desk, and wall posters *on* a wall — one prop layer can only hold one of the two, so the clutter was erasing the furniture underneath |
| **1.4** | **Tile size 16 → 32 px.** Map is now 2048 × 1280 px. Five 32px tilesets replace the three 16px ones | The full LimeZu Modern Interiors / Modern Office set arrived — proper office desks, swivel chairs, sofas, screens, glass partitions. Zone rects are unchanged in *tile* coordinates; their pixel values doubled |
| **1.3** | Floor plan restructured: review room and lounge removed, replaced by a central **atrium** corridor that holds `blocked` and `reviewing`; cafeteria and chill room enlarged to 23 × 8 | The atrium gives one walkable spine from the north corridor to the social wing, and frees floor area for the two social rooms. **No message-shape change** — only which room each zone maps to |
| **1.2** | Cabins belong to real people. Added `HumanView.cabin` and `AgentView.zoneAnchor`; `needs_human` now resolves to a specific person's cabin. Map is 64×40 with 13 rects | The four cabins are the team's private offices. Routing `needs_human` to the right cabin turns "someone is needed" into "**Sam** is the bottleneck" |
| **1.1** | Added `collaborating` zone → meeting room | Cross-machine AI collaboration had no visual representation. It's the headline feature and was invisible |
| **1.0** | Initial | — |
