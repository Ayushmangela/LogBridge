# The Contract
### Single source of truth for everything exchanged between the office and the system.

**Version 1.24** · Copies of this appear inside `OFFICE.md` and `SYSTEM.md` for reading convenience. **If they ever disagree, this file wins.**

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
  tasks: BoardTask[]           // ★ 1.8 every task in the room — the board's rows
  memories: MemoryView[]       // ★ 1.9 what the team has learned (project scope only)
  activity: ActivityItem[]     // ★ 1.10 what just happened, newest first (30 max)
  triggers: TriggerView[]      // ★ 1.24 standing rules that create tasks (see TRIGGERS.md)
  collaborationAvailable: boolean  // ★ 1.18 two or more DISTINCT owners online
}

type ActivityItem = {         // projected from the event log, server-side
  seq: number                 // event log sequence — stable ordering
  type: string                // raw event type, so the UI can filter/tint
  actor: string | null        // agent or human name; null = the system
  summary: string             // ALREADY human-readable — the UI only renders
  taskId: string | null
  ts: string
}

type TriggerView = {          // standing rule (TRIGGERS.md), projected server-side
  id: string
  projectId: string
  name: string
  enabled: boolean
  kind: "schedule" | "event"
  rule: string
  taskTitle: string | null
  taskSpec: string | null
  taskCapability: string | null
  budgetSeconds: number | null
  budgetUsd: number | null
  tz: string | null
  createdAt: string
  lastFiredAt: string | null
  nextFireAt: string | null
  lastEvtSeq: number           // event cursor for kind:"event", 0 for schedule
}

type MemoryView = {           // see MEMORY.md
  id: string
  scope: "project" | "agent"  // only "project" ones are sent to browsers
  kind: "fact" | "preference" | "decision" | "outcome"
  text: string
  agentName: string           // who learned it
  createdAt: string
}

type BoardTask = {
  id: string
  title: string
  state: TaskState             // the full 9-state enum, not the 7 zone ids
  agentId: string | null       // null = proposed but not assigned to anyone
  agentName: string | null
  createdAt: string
  startedAt: string | null     // null until a runner accepts it
  costUsd: number
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
  character: string | null     // ★ 1.20 sprite the office draws
  color: string | null         // ★ 1.20 accent hex, e.g. "#c05d5d"
  folder: string | null        // ★ 1.20 the repo it works in; also how the roster groups
  isolation: "shared" | "worktree" | "copy" | null   // ★ 1.20 see WORKSPACE.md
  note: string | null          // ★ 1.20 a HUMAN's note. never sent on agent.card
  description: string | null   // ★ 1.20 one line: what this agent is
  goal: string | null          // ★ 1.20 its standing objective
  provider?: string | null     // ★ 1.22 which agent CLI it runs. null = the machine's default harness
  githubRef: { kind: "pr" | "issue"; ref: string } | null   // "acme/api#212"
}

type TaskBrief = {
  id: string
  title: string                // "Add JWT auth"
  elapsedSec: number
  costUsd: number
  note: string | null          // ★ 1.19 the agent's latest line — "running test suite"
  steps: number                // ★ 1.19 step boundaries reported so far. A COUNT,
                               //   never a fraction: no provider reports a total
}

type MachineView = {
  id: string
  name: string                 // "sams-mbp"
  ownerId: string
  online: boolean              // ★ offline = that person's agents can't take work
  lastSeen: string
  providers: ProviderInfo[]    // ★ CLIs the machine actually has installed —
                               //   reported by the machine at handshake, not guessed
  allowAgentCreation: boolean  // ★ machine accepts browser-initiated agent creation
  allowUnsandboxed: boolean    // ★ machine accepts providers with no tool policy
}

type ProviderInfo = {
  id: string                   // "opencode"
  label: string                // "OpenCode"
  policy: "claude-settings" | "none"   // none = cannot enforce allowTools/denyPaths
  verified: boolean            // output format observed here, or assumed?
  models: string[]
  command?: {                  // ★ 1.21 what this CLI will actually run — OPTIONAL, see 1.22
    withModel: string          //   contains the literal "<model>" to substitute
    noModel: string            //   NOT the same as substituting "" — the flag is dropped
    bypassFlag: string | null  //   null when the CLI has no such mode
  }
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
  | { type: "join";     roomId: string }   // ★ 1.17 which room this browser is in
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
| `props2` | tilelayer | ✅ desktop clutter + wall decor, above `props` |
| `props3` | tilelayer | ✅ chairs, above `props2` — they must occlude the desk *and* its clutter |
| `zones` | objectgroup | ✅ **13** named rects |
| `markers` | objectgroup | ✅ `spawn` point |

**64 × 46 tiles at 32 × 32 px** = 2048 × 1472 px. Object `x`/`y` are in **pixels** — divide by **32** for tile coords.

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
| **1.24** | Added **`Room.triggers: TriggerView[]`** — standing rules that create tasks | Triggers are stored per project and projected into the view so the browser can list them without inventing its own. Always an array (empty when no triggers) so a database written before triggers existed still produces a valid view — a required field with no value would have blanked the office for every viewer until each trigger was recreated. Stream A builds its list UI against this |
| **1.23** | Added **`AgentView.summonedBy` / `summonedAt` / `summonedPos`** — summon is a real event, not a tween | The agent walks to the caller's tile (player position) and stays until dismissed or it gets work — `setAgentStatus(working)` clears the summon so work always wins. `summon`/`summon.cancel` land in the activity feed. Optional for the same reason as `provider`: older agent rows have null and a required field would blank the office |
| **1.22** | Added **`AgentView.provider`**; made **`ProviderInfo.command`** optional | The Command Center's command reference is keyed by the CLI an agent runs, and the view never carried it — the runner reported it on `agent.card` as `harness` and the server dropped it. `command` becoming optional is a **fix, not a refinement**: `providers` is JSON frozen at a machine's last handshake, the gateway validates the whole view and sends **nothing** when validation fails, so shipping it as required in 1.21 blanked every office until each runner happened to reconnect. Any field added to a view fed by stored producer data carries that same risk and must be optional |
| **1.21** | Added **`ProviderInfo.command`** | The Add Agent dialog shows the command an agent will run. Composing that string in the browser would mean the browser guessing flags for CLIs it has never seen installed, and drifting silently the first time an arg changed. The machine now generates it from the **same `buildArgs` the harness spawns**, so the preview cannot be wrong without the run being wrong too. `bypassFlag` is carried separately and is null for every provider that has no such mode — the toggle shows the literal flag rather than implying one exists |
| **1.20** | Added seven **`AgentView`** identity fields | An agent had a name, a role and a status, and nothing that said who it was. The Add Agent wizard asks for a sprite, a colour, a folder and a briefing, and the agents table had nowhere to put any of it. `folder` doubles as the roster's grouping key — "who is touching this repo right now" is the question the roster actually answers. **`note` is the one field never carried on `agent.card`**: a human types it in the browser, and reconnects are routine, so a runner declaring it would erase it at seemingly random moments |
| **1.19** | Added **`TaskBrief.steps`**, and started populating **`TaskBrief.note`** | A running task was a black box between "started" and "done" — a 40-minute run and a 4-second run rendered identically, and `note` had been in the contract since 1.0 while the server always sent `null`. Providers emit real step boundaries (opencode `step_start`, claude assistant turns), so the count is observed rather than estimated. It is deliberately **not** a percentage: no CLI reports how many steps remain, so a progress bar here would be inventing its denominator |
| **1.18** | Added **`Room.collaborationAvailable`** | Delegation, review, context sharing and consent are all inert unless a second *person* has a machine online, so the office was advertising a meeting room nobody could enter. Counts **distinct owners**, not machines — one person's laptop and desktop is not collaboration, and a soak rig must not flip it on |
| **1.17** | Added **`ClientMessage.join`** | The server had no idea which room a browser was looking at — membership was only implied by `position`, which doesn't exist until the player moves. So chat was broadcast and replayed to every socket and the browser filtered it for display. Survivable with one room; wrong once the GitHub mirror started creating one per repo. A socket that hasn't joined now receives no chat at all: silence is recoverable, another project's conversation arriving is not |
| **1.16** | **`Room.pulls`** (`PullView[]`, capped 20) — number/title/state/CI/author; `AgentView.githubRef` now populates from issue-sourced tasks | GitHub mirror (M6/prompt 7). Read-only polling with ETags (D9/D10): repo → room, open issues → queued tasks keyed by a UNIQUE `idem` of `gh:<repo>#<n>` so no poll ever duplicates one, closed issues retire their task, PR state and CI transitions land once in the activity feed. Left out and labelled: commit aggregation (needs per-push grouping the poll loop doesn't model yet) |
| **1.15** | **`review.request`/`review.result`/`context.share` now carry `sealed` payloads**; results gain plaintext `note` for refusals; `context.share` gains `shareId` and drops plaintext `body` | Reviews and context sharing built (prompt 6), following D15: a review returns a judgement, not work. Findings, criteria and context bodies are CONTENT — sealed like delegation payloads; only routing metadata stays plaintext. Server-generated refusals carry their reason as plaintext `note` since nobody sealed them. Received context is stored on the receiving machine only — putting it in server-side team memory would hand the server what the sealing kept from it |
| **1.14** | `delegate.request` gains optional **`summary`** (requester-authored plaintext); `answer` gains optional **`mode`** (`once\|always\|never`) | Per-request consent (prompt 5). The server holds a delegation until the target machine's owner approves it in the room — shown the requester's summary of intent, never the payload. `always`/`never` persist to `grants` and are honoured silently afterwards; a machine that hasn't opted into delegations at all refuses immediately without asking. Trade-off documented in SEALED.md |
| **1.13** | `answer` gains optional **`spec`**; proposals now carry an `edit` option | Editing a proposal before approval (prompt 4). Only legal while the task is `submitted` — after acceptance the recourse is Stop, not silent rewrites. An edit sets title AND spec to the human's text, so what you typed is exactly what runs. Every edit is logged (`task.edit`) and re-proposed to the room |
| **1.12** | **`agent.create` (server → node) and `agent.create.result` (node → server)**; `MachineView` gains `providers`, `allowAgentCreation`, `allowUnsandboxed` | Creating an agent from the browser. The machine reports what it can do (installed CLIs, its own gates) so the dialog offers only real options — and the runner, not the UI, is what refuses: creation is opt-in per machine (`--allow-agent-creation`), and a provider with no enforceable tool policy is refused unless the owner accepts unsandboxed runs. An agent that would refuse every task never gets born |
| **1.11** | **`task.offer` carries `agentId`** (nullable, so an older runner still parses it) | A machine can run several agents, on different CLIs. Without this the runner had to guess — it used `agents[0]` — so a second agent could never receive work and every agent shared one harness. Prerequisite for choosing a provider per agent |
| **1.10** | Added **`Room.activity: ActivityItem[]`** (30 newest, noise filtered) | The office shows the present tense and the board shows task state; neither can say *"the lease expired"*, *"it learned something"* or *"a result arrived late"*. Those only exist in the event log. The **summary is written server-side** for the same reason `zone` is (invariant 2): one place decides the wording, so the UI cannot narrate something the log doesn't support |
| **1.9** | Added **`Room.memories: MemoryView[]`** (project-scoped only, 30 newest) and the `memory.write` / `memory.recall` / `memory.result` envelope types | Shared agent memory — see `MEMORY.md` and D25. An agent recalls what the team learned before it starts, including from agents on other machines, which only works if the store is server-side. Agent-scoped memories stay out of the view: they're for that agent's recall, not a team display |
| **1.8** | Added **`Room.tasks: BoardTask[]`** — every task in the room, capped at 100, newest first | The office shows what each agent is doing *right now*; it structurally cannot show a queue, a rejected proposal, or yesterday's failures. The board view needs task identity and the full `TaskState`, neither of which `TaskBrief` carries (it's scoped to one agent's current task). Same snapshot, second view — no new socket messages |
| **1.7** | Map height **40 → 46 tiles** (2048 × 1472 px) | The cafeteria and chill room needed more floor. Growing the map downward gives it to them without shrinking the desk floor — the alternative was taking rows from the open office |
| **1.6** | Added a **`props3`** layer for chairs, above `props2` | A chair pulled up to a desk overlaps both the desk's front edge and the keyboard on it. On `props2` it erased the clutter tile; it needs to be the last thing drawn |
| **1.5** | Added a **`props2`** tile layer, drawn above `props`. White walls replace charcoal | Monitors, keyboards and papers have to sit *on* a desk, and wall posters *on* a wall — one prop layer can only hold one of the two, so the clutter was erasing the furniture underneath |
| **1.4** | **Tile size 16 → 32 px.** Map is now 2048 × 1280 px. Five 32px tilesets replace the three 16px ones | The full LimeZu Modern Interiors / Modern Office set arrived — proper office desks, swivel chairs, sofas, screens, glass partitions. Zone rects are unchanged in *tile* coordinates; their pixel values doubled |
| **1.3** | Floor plan restructured: review room and lounge removed, replaced by a central **atrium** corridor that holds `blocked` and `reviewing`; cafeteria and chill room enlarged to 23 × 8 | The atrium gives one walkable spine from the north corridor to the social wing, and frees floor area for the two social rooms. **No message-shape change** — only which room each zone maps to |
| **1.2** | Cabins belong to real people. Added `HumanView.cabin` and `AgentView.zoneAnchor`; `needs_human` now resolves to a specific person's cabin. Map is 64×40 with 13 rects | The four cabins are the team's private offices. Routing `needs_human` to the right cabin turns "someone is needed" into "**Sam** is the bottleneck" |
| **1.1** | Added `collaborating` zone → meeting room | Cross-machine AI collaboration had no visual representation. It's the headline feature and was invisible |
| **1.0** | Initial | — |
