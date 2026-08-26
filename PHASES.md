# Phases & Parallel Work Plan
### Two people, two tracks, six weeks, six merge points.

**Track A — your friend:** the pixel office map and art. *(→ `OFFICE-MAP.md`)*
**Track B — you:** protocol, server, runner, agents, renderer, integrations. *(→ `SYSTEM.md`, `OFFICE.md`)*

The tracks are designed so **neither of you can block the other, ever.**

---

## The trick that makes parallel work actually work

### 1. Zero file overlap

| Who | Owns these paths | Never touches |
|---|---|---|
| **Friend** | `public/assets/**` — and nothing else | everything else |
| **You** | everything else | `public/assets/**` |

No shared file means **no merge conflicts, ever.** Not "few" — zero. He can commit whenever he likes and it will always merge clean.

### 2. Greybox first, art later

His very first deliverable — **day 2, not week 3** — is a *greybox map*: correct 60×40 dimensions, all 9 zone rectangles named correctly, plain coloured squares for tiles. It looks terrible and that's the point.

With the greybox in the repo on day 2, you can build the entire renderer without waiting for a single piece of art. When the real tileset lands in week 3, it's a **drop-in replacement** — same filenames, same layer names, same zone names. Nothing in your code changes.

> This is standard game-dev practice and it's the single highest-leverage decision in this plan. Do not let him start on beautiful desks before the greybox exists.

### 3. One contract, one file

`CONTRACT.md` is the source of truth for the data you exchange. Copies appear inside `OFFICE.md` and `SYSTEM.md` for convenience, but **if they ever disagree, `CONTRACT.md` wins.** Change it only in a call where you're both present.

---

# The timeline

| Week | **Track A — Friend** *(office)* | **Track B — You** *(system)* | Merge |
|---|---|---|---|
| **0** | *Together: read `CONTRACT.md` out loud. 2 hours.* | | |
| **1** | **Greybox map** (day 2) → pick tileset → floor tiles all 8 rooms | `packages/protocol` + tests → server skeleton, SQLite, WS gateway | **M1** |
| **2** | Walls, doors, dividers → start furniture | Node runner: enroll, auth, lease, heartbeat, outbox, resume. Echo agent. **The Wi-Fi-drop test** | **M2** |
| **3** | Furniture all 8 rooms → **real tileset ships** | Real agent adapter, tool allowlist, budget caps, `buildView()` → **Pixi renderer** on the greybox | **M3** ★ |
| **4** | Characters: 8 humans (walk), 6 agents (static) | Chat, natural-language spec proposal, approval inbox, board view | **M4** |
| **5** | Polish: floor variants, props, `CREDITS.md`. Then free | Second machine, MCP tools, delegation, review, consent | **M5** ★ |
| **6** | Optional: 2nd room layout, or help test | GitHub mirror, cost ledger, hardening | **M6** |

★ = the two demos worth showing people.

---

# Merge points

Each one has a hard acceptance test. **If it doesn't pass, don't move to the next week** — fix it. Everything downstream stands on these.

## M1 — End of week 1 · *"the pipes connect"*

| | |
|---|---|
| **Friend delivers** | `public/assets/office.json` — greybox. **64×40**, five layers, **13 named zone rects** (4 `cabin` with `index`, 4 `working` with `order`, plus 5 singles), `spawn` marker. Ugly is correct |
| **You deliver** | Server runs on the spare laptop. Browser connects over Tailscale, receives a valid `WorkspaceView` with zero agents |
| **Test** | `curl` the server; open the office JSON in a script and confirm all 13 rects parse with their `index`/`order` properties |
| **Demo** | Nothing visual. That's fine — this week is plumbing |

## M2 — End of week 2 · *"it survives reality"*

| | |
|---|---|
| **Friend delivers** | All 11 areas enclosed with walls and door gaps; atrium open at both ends. Still greybox art |
| **You deliver** | A machine enrolls. A fake `echo` task runs, leases, heartbeats. **The Wi-Fi-drop test is automated and green** |
| **Test** | Kill Wi-Fi 10s into a 60s task, restore after 90s → complete ordered event stream, visible reconnect marker, **exactly one result** |
| **Demo** | Still nothing visual. This is the most important week of the project and it has nothing to show. Accept that |

> If you only get one thing right in six weeks, make it M2. Everything after it assumes the system tells the truth about what happened.

## M3 — End of week 3 · ★ *"the office comes alive"*

| | |
|---|---|
| **Friend delivers** | **Real tileset.** Floors, glass walls and furniture for all 11 areas — boss cabin done properly. Drop-in over the greybox |
| **You deliver** | Renderer draws the map, places agents by `zone` and `slot`, tweens on change. Real agents doing real work in a real repo |
| **Test** | Start a real task on your laptop → the character walks into the open office → finishes → moves to the table tennis room. Nothing else in the room moves |
| **Demo** | **First real demo.** Show someone the office while an agent actually edits a file |

## M4 — End of week 4 · *"you can talk to it"*

| | |
|---|---|
| **Friend delivers** | Characters — 8 humans with 4-direction walk, 6 agent sprites |
| **You deliver** | Room chat. `@dev-api do X` → agent proposes a spec → you confirm → it runs. Approval inbox with approve/edit/reject/answer. Board ↔ office toggle |
| **Test** | Ask an agent something in chat, get a spec, confirm, watch it run, answer its question mid-task from another browser |
| **Demo** | Type a sentence, watch a character start working |

## M5 — End of week 5 · ★ *"the meeting room fills up"*

| | |
|---|---|
| **Friend delivers** | Polish and `CREDITS.md`. His track is essentially done |
| **You deliver** | Friend's machine enrolled. `delegate_task`, `request_review`, `share_context`, consent flow |
| **Test** | Your agent delegates a test run to his machine. He approves once. It runs on **his** hardware. **Both characters appear in the meeting room together** |
| **Demo** | **The money demo.** Two laptops, two agents, one meeting room. This is the thing nobody else has |

## M6 — End of week 6 · *"it's connected to real work"*

| | |
|---|---|
| **Friend delivers** | Optional second room layout, or nothing |
| **You deliver** | GitHub mirror. Rooms named from repos, tasks from issues, PR and CI state on the board, commits aggregated |
| **Test** | Assign issue #N to an agent; watch the PR and check status appear without a refresh |
| **Demo** | End-to-end: issue → agent → cross-machine review → PR |

---

# Git workflow

Deliberately boring. Two people don't need GitFlow.

```
main            ← always working. Both merge here.
 ├── feat/xxx   ← your branches, short-lived
 └── assets     ← his long-running branch, only ever touches public/assets/**
```

**His loop:**
```bash
git checkout assets
git pull origin main --rebase     # always clean: he touches nothing you own
# ...update office.json / tileset.png / characters.png in Tiled...
git add public/assets
git commit -m "office: furniture in cafeteria + TT room"
git push origin assets
```
Then a PR into `main`. **You merge it without reviewing the art** — you can't review a PNG in a diff. Review it by *looking at the office*.

**Your loop:** normal short-lived feature branches into `main`. Merge his `assets` PRs as soon as they arrive; a broken map is instantly visible and instantly revertible.

**Rule:** `main` always runs. If `main` is broken for more than an hour, that's the only thing either of you works on.

---

# If someone slips

| Situation | Do this |
|---|---|
| **Friend is late on the greybox** | Generate one yourself in 20 minutes — a script that writes a valid `office.json` with flat-colour tiles. Never wait for it |
| **Friend is late on art** | Nothing blocks. Greybox works forever; art is a swap. Ship M3 grey if you have to |
| **Friend finishes early (likely)** | Give him: extra character variants, a second room layout, or testing M4/M5 with you on his machine — you need a second human for M5 anyway |
| **You're late on the renderer** | He can't see his own map in-game. Give him a tiny standalone HTML page that draws the tilemap and nothing else — one hour of work, unblocks his art loop completely |
| **You're late on the server** | He keeps using the mock server from `OFFICE.md` step 2. Indefinitely |
| **A week slips entirely** | Cut M6 (GitHub). It's the most detachable phase and the least impressive |

---

# What "done" means for the MVP

All six merge points passed, plus:

- [ ] Server runs unattended on the spare laptop for a week without intervention
- [ ] Both machines reconnect cleanly after sleep, every time
- [x] A looping agent gets killed by its budget cap — `wifiDrop.test.ts`, "the budget cap kills a deliberately looping task"
- [x] Every state in the office traces to a real event in the log — audited in `apps/server/src/traces.test.ts`, with **one recorded exception**: idle roaming is motion with no event, admissible because it is confined to the idle zone and deterministic. See D11's reconciled exception
- [ ] A stranger can watch the office for 60 seconds and correctly say what the team is doing

That last one is the real test. If they can't, the office is decoration and something in the state mapping is wrong.

---

# Deliberately not in any phase

Voice/video · multi-hop delegation · agent memory · mobile app · more than 2 machines · authentication beyond GitHub OAuth · a second workspace · collision detection · Docker · Postgres.

If either of you starts one of these, the other should say so out loud.
