# Lovable redesign brief — LogBridge

**How to use this file.** Everything below the line is the prompt. Paste **§0–§5 first** (context, constraints, palette, component system) and let Lovable build the shell. Then paste **one screen section at a time** from §6. Lovable degrades badly if you paste 2,000 lines at once — it will stub half the screens and you'll lose the detail that makes this specific.

The single most important paragraph is **§2**. If Lovable ignores it, it will try to draw an office out of `<div>`s and you'll have to start over.

---

# LogBridge — visual redesign of the web client

## 0. What this product is

LogBridge is a **shared virtual office for humans and AI coding agents**. Several people run AI agents (Claude Code, opencode, and other CLIs) on their own laptops. A small always-on server coordinates them. The web client is a **pixel-art office floor** where every character on screen is a real agent or a real person, and **where a character is standing tells you what is actually happening**:

| Room | Means |
|---|---|
| Boss cabin (corner office, biggest) | agents waiting on the repo admin's decision |
| Senior cabins ×3 | agents waiting on those three people |
| Open office — desk pods | agents actively working right now |
| Atrium (central corridor) | upper half: blocked on CI/build · lower half: reviewing code |
| Meeting room | agents on **two different laptops** collaborating |
| Cafeteria | idle, nothing to do |
| Chill room | just finished a job |
| Lobby | reception, where people arrive |

**Nothing on screen moves unless a real event caused it.** There is no idle animation loop. Position is computed from real task state. Glance at the floor and you know the day: *cafeteria full = quiet · one person's cabin crowded = that person is the bottleneck · atrium busy = stuck or under review.*

Around that office floor sits a dense, developer-grade console: task boards, live agent terminals, chat with approval flows, per-agent command centers, team memory, GitHub PR/CI state.

The audience is developers, in long sessions, often with the window open all day on a second monitor.

---

## 1. What I want you to build

A **complete visual redesign of the web client**. Frontend only.

- **React + TypeScript + Tailwind + shadcn/ui**
- **All data mocked.** No fetch, no backend, no auth logic. Put every mock in `src/mock/` as typed fixtures matching §7 exactly. I will wire the real WebSocket myself.
- **Dark theme is the primary.** Build light as a secondary only if it costs nothing — this tool lives on dark.
- **Desktop-first.** Real minimum is 1280px. It should not break at 1024px, but do not spend effort on mobile — nobody runs an agent fleet from a phone.
- Route-per-screen, so I can deep-link.

This is a **redesign of an app that already works**, not a greenfield concept. Every screen listed in §6 exists today and has real data behind it. Design for the density that real data creates: 20 agents, 60 tasks, a terminal streaming 2,000 lines. Empty-state-only designs are the failure mode here — every screen must be shown with **realistic, full, slightly-messy data**.

---

## 2. ⛔ The office map is ALREADY DESIGNED AND BUILT — do not redesign it

**This is the hard constraint. Read it twice.**

The pixel office floor is finished work. It is a real tile-based renderer drawing a 64×46 grid of 32px tiles (2048×1472px) from a `office.json` map file, using licensed LimeZu pixel-art tilesets, with sprite-atlas characters, zoom and pan. It took days and it is done.

In your build, the office is **exactly this and nothing more**:

```tsx
<div id="canvas-container" className="...your framing...">
  <canvas id="canvas" />
</div>
```

You must:
- ✅ Render that `<canvas>` element with that exact id, sized to fill its container
- ✅ Design **the chrome around it** — the frame, the floating HUD, overlays, panels listed in §6.3
- ✅ Use a **static placeholder image** in the canvas area for your preview screenshots if you need something to look at

You must **NOT**:
- ❌ Draw an office, floor plan, room, or desk using divs, SVG, CSS grid, emoji, or icons
- ❌ Replace the canvas with an illustration, a 3D scene, or an isometric mockup
- ❌ Redesign the pixel art, the tiles, the characters, the rooms, or the map layout
- ❌ Restyle the canvas with filters, blend modes, borders that overlap the art, or rounded corners that clip sprites
- ❌ Change the room names, the room meanings, or the status→room mapping in the table above

Think of the canvas as a **video player**: you are designing the player chrome, not the film.

---

## 3. Design direction: "warm control room"

The current design is OLED-black with a pure-white accent — competent, but it is generic dark-SaaS and it **fights the warm pixel art it wraps**. The office floor is sage carpet, teal lounges, tan cafeteria, plum chill room, wood desks. Dropping that into a cold monochrome console makes the art look like a foreign object pasted into a dashboard.

**The concept: the UI and the office floor should speak the same visual language, because they are describing the same thing.**

Go dark, but **warm-neutral dark** — a base with a slight brown/stone cast rather than blue-black or pure black. Then take the semantic status colors **directly from the rooms those statuses map to**, so a "working" pill in the sidebar is the same sage as the desk carpet the character is standing on. This is not decoration — the entire premise of the product is that location encodes state, so the console encoding state in *the same colors* makes the two halves reinforce each other instead of competing.

Feel: **precise like Linear, live like a mission-control HUD, warm like the office it is watching.** Dense but not cramped. Fast, quiet, no decorative gradients, no glassmorphism-for-its-own-sake, no purple-blue AI-startup gradient. It should look like a tool someone chose, not a template.

Typography: one clean geometric or neo-grotesque sans for UI, one good mono for terminals, task IDs, costs, timestamps, and file paths. Mono is load-bearing here — a lot of this screen is machine output.

---

## 4. Palette — harmonize with the pixel art that already exists

These are the **actual RGB values of the carpet tiles in the shipped office map**. Build the semantic palette from them so the console and the floor agree.

| Office area | RGB | Use in the UI for |
|---|---|---|
| Base floor (light grey) | `204,204,204` | neutral / muted text on dark |
| **Employee desks — sage** | `156,169,158` | **status: working** |
| **Meeting room — light blue** | `134,184,223` | **status: collaborating / reviewing** |
| **Lobby + boss cabin — teal** | `137,188,198` | **accent, links, focus rings, primary action** |
| **Senior cabins — warm grey** | `212,210,198` | **status: needs human input** |
| **Cafeteria — tan** | `192,164,140` | **status: idle** |
| **Chill room — plum** | `131,112,180` | **status: just finished / done** |

Treat those as seeds, not literals — lift saturation and adjust lightness so they read correctly as UI accents on a dark warm-neutral base and pass **WCAG AA (4.5:1)** for text, 3:1 for borders and icons. Keep the hue relationships intact so the mapping stays legible.

Reserve a true red **only** for genuinely destructive or failed states (halt, delete, CI failure, dead-letter). It should not appear anywhere in normal operation, so that when it appears it means something.

Define the whole thing as CSS custom properties / Tailwind theme tokens. Every color in every component comes from a token — no hardcoded hex in components.

---

## 5. Build the component system first

Before any screen, establish these primitives. They repeat everywhere and getting them right once is most of the work:

1. **StatusPill** — agent status. Variants: `idle · working · needs_input · blocked · reviewing · done · paused · retired · offline`. Small dot + label. Colors from §4.
2. **TaskStateBadge** — task lifecycle. Variants: `submitted · working · input-required · auth-required · blocked · completed · failed · canceled · rejected`.
3. **AgentAvatar** — square pixel-sprite portrait (I supply the PNG), with a status ring and an optional "paused" or "offline" treatment. Sizes: 20 / 28 / 44px. **Must not smooth the pixels — `image-rendering: pixelated`.**
4. **Panel / PanelHeader** — the card shell every non-office screen sits in. Title, one-line subtitle, right-aligned actions.
5. **DataRow** — the dense repeating list row used by activity, traces, memory, PRs, messages. Leading icon/badge, primary line, secondary meta line, trailing action.
6. **MonoMeta** — timestamps, elapsed, cost (`$0.0412`), token counts, step counts, short SHAs.
7. **TabBar** — horizontal, scrollable, ~21 tabs (see §6.6). This one is genuinely hard — solve it properly rather than letting it wrap into four ragged rows.
8. **EmptyState** — one honest line, no illustration, no "Get started!" copy.
9. **Terminal frame** — the chrome around an xterm.js canvas (again: I own the terminal itself, you own the frame, the toolbar, the queue strip, and the composer).

---

## 6. Screens

### 6.1 Auth
Single centered card. Tabs: **Sign In** / **Create Account**. Fields: full name (signup only), email-or-username, password. Primary submit. Below a divider, a secondary **one-click demo access** button. Product wordmark + one-line tagline ("Autonomous multi-agent AI office"). Ambient background treatment is fine, keep it subtle. Show the error state.

### 6.2 App shell
- **Left sidebar (~260px, collapsible to icon rail):** brand mark; **AI Agents** roster grouped by folder with a count badge and a `+`; **People** roster with count and `+`; collapse control pinned to the bottom. Roster rows: avatar, name, status line (the human's note wins over machine chatter when present), status dot. This roster is the thing users scan most — make it excellent at 20+ agents.
- **Top bar:** workspace/project breadcrumb switcher on the left; center nav (**Office Map · Tasks · Chat · Memory · Projects · Settings**) with an unread count on Chat; right side an online-count pill and a user menu (project workspaces, sign out).
- Content area below.

### 6.3 Office Map — canvas chrome only (re-read §2)
Around the fixed `<canvas>`, design:
- **Floating top HUD island** — floor name · current zone readout · keyboard legend (`WASD` move, `Shift` run, `M` mic). Should feel like a game HUD, not a toolbar.
- **Zoom dock** — `+` / `1:1` / `−`, floating, bottom-right.
- **Legend / layer panel** — bottom-left: status color key + toggles for Agents / People / Task bubbles.
- **Inspector panel** — slides in when an agent is selected: name, status badge, active task card (title, elapsed, cost, step count), task controls (**Pause · Resume · Halt · Steer**), a sub-tab strip (Attempts · Artifacts · Routing · Context), a primary **Assign Task**, and a **Command Center →** link.
- **Agent hover popup** — small, fast: name, status, current task, human note, **Call here** (summon) and **Assign Task**.
- **Room comms bar** — appears when you walk into a private room: room name, occupants, mic toggle with a live level meter, in-room message history, and a talk composer. This is the spatial-voice surface; it should feel like walking into a room, not like opening a chat window.
- **Bottom strip — three cards:** *Current Task* (id, name, latest note, state pill, elapsed bar, assignee/elapsed/step meta), *Recent Activity* (live feed), *Quick Actions*.

> Note on the elapsed bar: it shows **elapsed time, not percent complete**. No CLI reports how many steps remain, so a percentage would be inventing its denominator. Never draw it as a progress-to-100% bar.

### 6.4 Tasks
Kanban board. Columns: **Proposed · In Progress · Blocked · Done · Closed**. Cards: title, task id (mono), assignee avatar + name, elapsed, cost, priority. Column counts in headers. Show it with ~40 cards unevenly distributed — that is what it actually looks like.

### 6.5 Chat
Room conversation. Message rows distinguish **human**, **agent**, and **system**. Two things make this screen non-generic — design both properly:
- **`@mention` autocomplete popup** — keyboard-navigable, shows agent avatar + name + status, filtered as you type.
- **Approval cards inline in the log** — an agent proposes a task spec and you act on it without leaving chat: **Approve · Edit · Reject · Answer**. Also used for mid-task questions, where an agent stops and asks the room. These cards are the product's most important interaction — give them real weight.

Composer with a tip line: *mention an idle agent — `@dev-api fix the login bug` — and it proposes a task you approve here.*

### 6.6 Command Center (per agent) — the biggest surface
Header: pixel portrait, name, status, tagline/description, **Meet with…**, **Call here**, back to floor.

Management row: **Assign Task · Delegate Epic · Pause Task · Resume Task · Halt Task · Edit · Note · Pause · Retire · Delete**. Delete is the only red one. There is a meaningful distinction to express visually: *Pause/Halt Task* act on the **current work**; *Pause/Retire/Delete* act on the **agent itself**.

Then a **21-tab bar**. Two agent kinds show different tab sets — an **orchestrator/commander** gets floor-management tabs, an **employee agent** gets its own working tabs, and some are shared. Surface that distinction in the header rather than making the user infer it from which tabs appear.

Full tab list: `Terminal · Code · Tasks · Goals · Approvals · System Ops · Sequence Flow · Workflows · Attempts · Artifacts · Messages · Memory · Steer · Traces · Monitor · Git · Commands · Activity · Triggers · Graph · Pull Requests`

**Do not design 21 unique tabs.** Design **six deeply** and let the rest inherit their patterns:
1. **Terminal** — live streaming CLI output (xterm.js canvas is mine), plus: live/pty status strip, font-size and fullscreen controls, restart, a **task queue strip** ("3 queued for dev-api"), and a message composer with file-attach and voice buttons.
2. **Monitor** — context tokens used vs limit, budget spend, tool-call count, engine/model swap control, live dispatch box.
3. **Traces** — the agent's tool calls and step boundaries as a timeline. Structured, scannable, mono.
4. **Pull Requests** — PR rows: number, title, state badge (`open · draft · merged · closed`), CI badge (`success · pending · failure`), author, relative time, external link.
5. **Memory** — what the agent recalls before starting work. Ranked list with relevance. **Label it honestly as keyword search (BM25), not semantic** — that wording matters, it is a real capability limit, don't design a UI that implies embeddings.
6. **Graph** — agent↔agent message graph. Nodes and edges, projected from routing metadata only.

The remaining fifteen reuse **Panel + DataRow + TabBar** with the right badges. Give them each a correct header and empty state; do not invent bespoke layouts for them.

### 6.7 Agents
Full roster page grouped by folder/repo. Per agent: avatar, name, role, status, machine, provider/model, current task, human note, health (last heartbeat, consecutive failures, machine online). Prominent **+ Add Agent**.

### 6.8 Memory
Team memory list — what agents learned, scope, source agent, recency, relevance. Search bar labeled honestly as keyword search.

### 6.9 Projects
Grid of workspace cards (`minmax(320px, 1fr)`). Per card: project name, repo, agent count, people count, activity sparkline or last-active, open action. Header action: **Create New Project**.

### 6.10 Settings
Machines list (name, owner, online, last seen, capabilities, whether it allows agent creation). A "working together" state block. An invites/accounts section that currently, honestly, says **not built yet** — design a credible "not built yet" block rather than a fake form.

---

## 6.11 Modals
1. **Add Agent** — 4-step wizard with a step rail: **1 Identity** (name · character sprite picker · color) → **2 Workspace** (folder picker · isolation: `shared` / `worktree` / `copy`) → **3 Engine** (provider · model · **live command preview** · a `bypassPermissions` toggle that is *disabled unless the machine allows it* and states plainly what it turns off) → **4 Briefing** (description · goal). Plus **Import hire…** which fills every field for review — **nothing is created until Create Agent is pressed**, and the UI should make that promise visible.
2. **Edit Agent** — same fields, no wizard.
3. **Note** — one short human annotation (120 chars).
4. **Create Project**
5. **Folder Picker** — server-side directory browser with breadcrumb + create-folder.
6. **Dispatch Task** — title, spec, target agent, budget caps (seconds and USD).
7. **Delegate Epic** — commander breaks a goal into tasks you approve as a set.

---

## 7. Mock these data shapes exactly

```ts
type AgentStatus = "idle" | "working" | "needs_input" | "blocked" | "reviewing" | "done" | "paused";
type Zone = "cabin" | "working" | "blocked" | "reviewing" | "collaborating" | "idle" | "done" | "lobby";

type AgentView = {
  id: string; name: string;
  role: "developer" | "research" | "qa" | "review" | "docs" | "planner";
  status: AgentStatus; zone: Zone;
  machineName: string; machineOnline: boolean;
  character: string | null;      // pixel sprite id
  color: string | null;          // accent hex
  folder: string | null;         // repo path — the roster groups by this
  note: string | null;           // a HUMAN's annotation; wins over machine chatter
  description: string | null; goal: string | null;
  provider: string | null;       // "claude" | "opencode" | ...
  model: string | null;
  paused: boolean; retired: boolean;
  health: { lastHeartbeat: string | null; consecutiveFailures: number; machineOnline: boolean };
  contextUsed: number | null; contextLimit: number | null; toolCalls: number | null;
  task: TaskBrief | null;
};

type TaskBrief = {
  id: string; title: string;
  elapsedSec: number; costUsd: number;
  note: string | null;   // the agent's most recent line of work
  steps: number;         // a COUNT, never a percentage — see §6.3
};

type BoardTask = {
  id: string; title: string;
  state: "submitted" | "working" | "input-required" | "auth-required" | "blocked"
       | "completed" | "failed" | "canceled" | "rejected";
  agentId: string | null; agentName: string | null;
  createdAt: string; startedAt: string | null; costUsd: number;
};

type PullView = {
  id: string; number: number; title: string;
  state: "open" | "draft" | "merged" | "closed";
  ci: "pending" | "success" | "failure" | null;
  author: string | null; updatedAt: string;
};

type ActivityItem = {
  seq: number; type: string;      // raw event type, so the UI can tint/filter
  actor: string | null;           // null = the system
  summary: string;                // ALREADY human-readable — render it, never rewrite it
  taskId: string | null; ts: string;
};

type MemoryView = { id: string; scope: "project" | "agent"; text: string; source: string; createdAt: string };
type MachineView = { id: string; name: string; ownerId: string; online: boolean; lastSeen: string };
```

Populate with **realistic, uneven** data: 12–20 agents across 3 folders, a few paused, one retired, one offline machine, 40+ tasks skewed toward done, a terminal buffer with real-looking CLI output, PRs including one failing CI, and an activity feed with 30 mixed entries.

---

## 8. Motion
Restrained and functional. Fast easing (~150–200ms), spring only on direct manipulation. Things that earn animation: panel slide-in, tab change, a status pill changing state, a new activity row arriving, the terminal's live indicator. Things that must not animate: the canvas frame, list rows on scroll, page transitions. **No skeleton shimmer loops** — this app is fed by a live socket, so it is either connected or it is not; design an honest disconnected state instead.

---

## 9. Don'ts
- ❌ Don't draw the office (§2). Canvas element, chrome only.
- ❌ Don't add a light-mode-first design. Dark is the product.
- ❌ Don't invent features that aren't in §6. This is a reskin of a working app — a screen you invent is a screen I have to delete.
- ❌ Don't design only empty states. Every screen full of realistic data.
- ❌ Don't use a purple→blue gradient, glassmorphism everywhere, or floating 3D blobs.
- ❌ Don't show progress as a percentage anywhere (§6.3).
- ❌ Don't label memory search "semantic" or "AI-powered" — it is keyword/BM25 and the UI must say so.
- ❌ Don't smooth the pixel sprites. `image-rendering: pixelated` on every avatar.
- ❌ Don't put marketing copy in empty states. One honest line.

## 10. Build order
1. Tokens + §5 component system, on a kitchen-sink page
2. App shell (§6.2) + Office chrome (§6.3)
3. Command Center (§6.6) — six deep tabs, rest inheriting
4. Tasks (§6.4) + Chat (§6.5)
5. Agents, Memory, Projects, Settings
6. Modals (§6.11)
7. Auth (§6.1)

Start with 1 and 2. Show me those before going further.
