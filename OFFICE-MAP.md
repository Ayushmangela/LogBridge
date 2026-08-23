# Build Doc — The Office Map & Assets
### Your job: design and build the pixel office. No code.

You are building the **place**. Someone else writes the code that puts characters in it.

You deliver **three files**. That's the whole job.

| # | File | What it is |
|---|---|---|
| 1 | `tileset.png` | One image containing every floor, wall and furniture tile |
| 2 | `characters.png` | One image containing every character sprite |
| 3 | `office.json` | The map itself, exported from Tiled |

Drop them in `public/assets/` and you're done. Estimated time: **3–4 days.**

---

## Tools — install these first

| Tool | Cost | What for | Link |
|---|---|---|---|
| **Tiled** | Free | Drawing the map. Your main tool | [mapeditor.org](https://www.mapeditor.org/) |
| **Aseprite** | ~$20 | Editing/making sprites *(optional)* | [aseprite.org](https://www.aseprite.org/) |
| **LibreSprite** | Free | Free Aseprite alternative | [libresprite.github.io](https://libresprite.github.io/) |
| **Piskel** | Free | Browser-based, zero install | [piskelapp.com](https://www.piskelapp.com/) |

You only need Tiled. The rest are for touching up sprites the asset pack is missing.

---

## Where to get the art

**Check the license on every page before downloading.** Some are free, some cost a few dollars, some need credit.

| What | Link | Notes |
|---|---|---|
| **Office tileset** ★ best | [LimeZu — Modern Office 16×16](https://limezu.itch.io/modernoffice) | Purpose-built: desks, cubicles, glass walls, meeting rooms. Free and paid tiers |
| | [LimeZu — Modern Interiors](https://limezu.itch.io/moderninteriors) | Same artist. Kitchen/cafeteria/sofa props live here |
| **Alternative** | [Pixel Office 32×32](https://masalimov-ilnur.itch.io/pixel-office) | Simpler, 32×32 |
| **Zero-license-worry** | [Kenney.nl](https://kenney.nl/assets) | **CC0, no attribution.** Less office-y, but you'll never have a license problem |
| **Characters** | LimeZu packs include matching characters — **prefer these** | Same art style as the tiles |
| | [LPC Character Generator](https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/) | Free, unlimited characters. **CC-BY-SA — you must credit.** Keep a `CREDITS.md` |

> **Two things you'll probably have to draw yourself:** a **table tennis table** (green rectangle, white centre line, small net — twenty minutes in Piskel) and possibly **glass wall tiles** if your pack lacks them. Glass matters here — see the design notes.

---

## Decisions already made — don't change these

| | |
|---|---|
| **Tile size** | **16 × 16 px** |
| **Map size** | **64 × 40 tiles** |
| **Orientation** | Orthogonal, top-down |
| **Render order** | Right Down |
| **Export** | JSON, tileset embedded |

**Never mix tile sizes.** If your pack is 32×32, use 32×32 for *everything* and tell the coder.

---

# The floor plan

Four bands: a **lobby** down the west side, **private cabins** along the north, the **work floor** through the middle, and the **social wing** along the south.

```
  x0  x2       x14 x15     x23 x24 x25    x33 x34 x35    x43 x44 x45          x61 x63
  ┌───┬──────────┬────────────┬─────────────┬────────────┬──────────────────────┐ y0
  │   │▤ RECEPT. │▓▓▓▓▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
  │   │          │            │             │            │                      │ y2
  │   │  ✿    ✿  │  SENIOR 1  │  SENIOR 2   │  SENIOR 3  │      BOSS CABIN      │
  │   │          │            │             │            │    ★ corner office   │
  │   │  ▬▬▬▬▬   │  cabin 1   │   cabin 2   │  cabin 3   │       cabin 0        │
  │   │  sofas   │            │             │            │                      │
  │   │          │   9 × 12   │   9 × 12    │   9 × 12   │       17 × 12        │
  │   │  ✿       │            │             │            │   (nearly 2× a       │
  │   │          │▓▓▓╡ ╞▓▓▓▓▓▓│▓▓▓▓╡ ╞▓▓▓▓▓▓│▓▓▓╡ ╞▓▓▓▓▓▓│▓▓▓▓▓▓▓╡ ╞▓▓▓▓▓▓▓▓▓▓▓▓│ y13
  │ L │          ├──────────────────────────────────────┬──────────────────────-│ y14
  │ O │  ✿       │       ←   NORTH CORRIDOR   →         │                       │ y16
  │ B │          ├───────────────────────────┬──────────┼───────────────────────│ y17
  │ B │  ▬▬▬▬▬   │  ┌──────┐    ┌──────┐     │  REVIEW  │                       │
  │ Y │          │  │ POD A│    │ POD B│     │   ROOM   │     MEETING ROOM      │
  │   │          │  └──────┘    └──────┘     │   8 × 6  │        17 × 13        │ y22
  │12 │  ✿       │     OPEN OFFICE           ╞══════════╡                       │ y23
  │wid│          │        20 × 13            │  LOUNGE  │      ▬▬▬▬▬▬▬▬▬        │
  │   │  ★spawn  │  ┌──────┐    ┌──────┐     │ (waiting)│      conference       │
  │   │          │  │ POD C│    │ POD D│     │   8 × 6  │                       │ y29
  │   │          │  └──────┘    └──────┘     │          │                       │
  │   │          ├──────────────────────────────────────┴───────────────────────│ y30
  │   │  ✿       │       ←   SOUTH CORRIDOR   →                                 │ y31
  │   │          ├─────────────────────────────┬────────────────────────────────│ y32
  │   │  ▤ ▤     │        CAFETERIA            │       TABLE TENNIS             │
  │   │          │          23 × 7             │           23 × 7               │ y38
  └───┴──────────┴─────────────────────────────┴────────────────────────────────┘ y39
                                             x38 x39

    ▓ = glass wall (see into the cabins)    ✿ = plant    ▬ = seating    ▤ = counter
```

### Exact coordinates

| Area | x range | y range | Size |
|---|---|---|---|
| **Lobby / reception** | 2 – 13 | 2 – 38 | 12 × 37 |
| **Senior cabin 1** *(cabin 1)* | 15 – 23 | 2 – 13 | 9 × 12 |
| **Senior cabin 2** *(cabin 2)* | 25 – 33 | 2 – 13 | 9 × 12 |
| **Senior cabin 3** *(cabin 3)* | 35 – 43 | 2 – 13 | 9 × 12 |
| **★ BOSS CABIN** *(cabin 0)* | **45 – 61** | **2 – 13** | **17 × 12** |
| North corridor | 15 – 61 | 14 – 16 | 47 × 3 |
| **Open office** | 15 – 34 | 17 – 29 | 20 × 13 |
| **Review room** | 36 – 43 | 17 – 22 | 8 × 6 |
| **Lounge** | 36 – 43 | 24 – 29 | 8 × 6 |
| **Meeting room** | 45 – 61 | 17 – 29 | 17 × 13 |
| South corridor | 15 – 61 | 30 – 31 | 47 × 2 |
| **Cafeteria** | 15 – 37 | 32 – 38 | 23 × 7 |
| **Table tennis** | 39 – 61 | 32 – 38 | 23 × 7 |

**Walls:** outer x0–1, x62–63, y0–1, y39 · lobby divider **x14** · cabin dividers **x24, x34** · cabin fronts along **y13** · open-office/review divider **x35** · review/lounge divider **y23** · **x44 runs continuously from y2 to y29** · cafeteria/TT divider **x38** · south-band front wall **y31**.

### Why it's laid out this way

- **The boss cabin is a corner office at nearly double the size** — 17 × 12 against 9 × 12. Best corner, glass on two sides, its own wing. It should read as the boss's office with no label at all.
- **`x44` is one continuous wall from the top of the map to y29**, separating the boss cabin *and* the meeting room from everything else. That single architectural line creates a legible "executive wing" and stops the map looking like a grid of boxes.
- **The lobby is a full-height band, not a corner.** Strong vertical anchor, somewhere for people to arrive, and a real home for sofas and plants instead of wasted floor.
- **Cabin fronts are glass.** You see who's in their office from the corridor — that's the entire point of a presence display.
- **Desks are pods of four, not long rows.** Real offices cluster; long rows read as a spreadsheet. Four pods also give four separate `working` zones, so agents spread out instead of stacking in one line.
- **Review room above, lounge below, split by a half-wall.** Quiet work over waiting.
- **The social wing is the whole south band** — cafeteria and table tennis side by side, away from the desks, like a real office.

---

# The zone system

Characters stand where they stand because of what's **actually happening**. That mapping is the whole reason this office is useful rather than decorative.

## The cabins belong to real people

The four cabins are **personal offices for the four humans on the team.** They are not agent zones.

| Cabin | `index` | Who gets it |
|---|---|---|
| **Boss cabin** *(corner office)* | `0` | **The GitHub repo admin/owner.** Biggest room — that's the joke, and it's also true |
| Senior cabin 1 | `1` | second collaborator |
| Senior cabin 2 | `2` | third collaborator |
| Senior cabin 3 | `3` | fourth collaborator |

You just draw four rectangles named `cabin` with an `index` property. **The code decides which person sits in which cabin** — you never need their names.

Two things happen in a cabin:

- **That person's avatar** idles there when they're online but haven't moved.
- **An AI agent that needs a decision from that person walks into that person's cabin.**

> So you can see *who* is being waited on, not just that someone is. Three agents standing in Sam's office means **Sam is the bottleneck**, and you can read that from across the room. That's much better than one generic "needs a human" room.

## Everywhere else is a work state

| Room | Zone name | Rects | What it means |
|---|---|---|---|
| Open office — 4 desk pods | `working` | 4 *(`order` 0–3)* | Actively working right now |
| Review room | `reviewing` | 1 | Reviewing someone's code |
| **Meeting room** | `collaborating` | 1 | Agents on **different people's machines** working together |
| Lounge | `blocked` | 1 | Waiting on CI, a build, a dependency |
| Cafeteria | `idle` | 1 | Online, nothing to do |
| Table tennis | `done` | 1 | Just finished; fades after ~2 min |
| The 4 cabins | `cabin` | 4 *(`index` 0–3)* | People's offices — and where agents go to ask them something |

**13 rectangles, 7 distinct names.**

Someone glancing at this office should read the whole day instantly:

> **Cafeteria full** = quiet day · **one cabin crowded** = *that person* is the bottleneck · **lounge full** = stuck on builds · **meeting room busy** = the machines are talking to each other · **table tennis busy** = a lot just shipped

The meeting room is the best thing this office does. Cross-machine AI collaboration is the hardest feature in the project and normally completely invisible — here you watch two characters from two different laptops stand in a room together.

---

# BUILD STEPS

## Step 1 — Set up *(15 min)*

1. Install Tiled.
2. Make a folder `office-map/`, put your `tileset.png` in it.
3. **File → New → New Map:**

| Setting | Value |
|---|---|
| Orientation | Orthogonal |
| Tile layer format | CSV |
| Tile render order | Right Down |
| Map size | Fixed, **64 × 40** |
| Tile size | **16 × 16** |

Save as `office.tmx`.

---

## Step 2 — Load the tileset *(10 min)*

**Map → New Tileset:**

| Setting | Value |
|---|---|
| Name | `office` |
| Type | Based on Tileset Image |
| Source | your `tileset.png` |
| Tile width / height | 16 / 16 |
| Margin / Spacing | usually 0 / 0 — **check the pack's readme** |
| **Embed in map** | ✅ **ON** |

> **Embed must be ON** so the exported JSON is self-contained. If tiles look offset by a pixel, your margin/spacing is wrong — fix it on tile one, not after a day of drawing.

---

## Step 3 — Create the layers, named exactly *(5 min)*

Bottom to top, **exact lowercase names**:

| # | Layer | Type | Contains |
|---|---|---|---|
| 1 | `floor` | Tile layer | Every walkable surface |
| 2 | `walls` | Tile layer | Walls, glass, doors, windows |
| 3 | `props` | Tile layer | Desks, chairs, plants, sofas, TT table |
| 4 | `zones` | **Object layer** | The 13 named rectangles |
| 5 | `markers` | **Object layer** | `spawn` point |

The code reads these names literally. `Floor` will not work — it must be `floor`.

---

## Step 4 — The greybox *(1 hour — do this FIRST, hand it over immediately)*

**Before any art**, build a throwaway version: correct 64 × 40 size, every wall in place, all 13 zone rectangles named correctly, `spawn` marker — using a single flat colour tile for floors and another for walls.

It will look terrible. **Export it and hand it over on day 2.** It unblocks all the code work while you spend the next three days on art, and the real tileset drops straight in on top with zero code changes.

Do not skip this to make something pretty first.

---

## Step 5 — Floors *(2 hours)*

Fill all 64 × 40. **No gaps** — a hole renders as a black square.

Give each area its own floor so rooms are distinguishable without reading labels:

| Area | Floor |
|---|---|
| **Boss cabin** | Dark hardwood or premium carpet — visibly the nicest floor in the building |
| Senior cabins | Grey or blue carpet |
| Lobby | Polished marble or large tile |
| Open office | Light neutral carpet |
| Review room | Muted darker carpet — quiet room |
| Lounge | Warm rug tones |
| Meeting room | Dark carpet or wood, matching the boss cabin's wing |
| Corridors | Polished concrete |
| Cafeteria | Checkerboard or kitchen tile |
| Table tennis | Sports wood or green |

Sprinkle 2–3 variant tiles into large areas so they don't look like a spreadsheet.

---

## Step 6 — Walls, glass and doors *(2–3 hours)*

- Outer wall around the whole map.
- **Lobby divider x14**, full height, with door gaps around y8, y22 and y35.
- **Cabin dividers x24, x34**, and **x44 running continuously y2 → y29.**
- **Cabin fronts along y13**, each with a 2-tile door gap.
- **Open-office/review divider x35** (y17–29), door gap around y20.
- **Review/lounge half-wall y23** (x36–43) — waist height or a glass partition.
- **Meeting-room door** in the x44 wall, around y23.
- **Cafeteria/TT divider x38** (y32–38).
- **South front wall y31**, door gaps into each room.

**Glass matters.** Use window/glass tiles for the cabin fronts and the meeting room's north wall. You should be able to see people inside their offices from the corridor — this is a presence display, and glass is how it reads.

**Doors:** just a 2-tile gap. Add a frame tile if the pack has one. Don't build opening doors.

Every room fully enclosed except its door. Walk each perimeter in Tiled and check for holes.

---

## Step 7 — Furniture *(5–7 hours — the fun part)*

All decoration. Make it look like a real office.

### ★ Boss cabin *(x45–61, y2–13 — 17 × 12, the biggest room)*
Large executive desk facing the door, ideally angled into the corner · high-backed chair · **two visitor chairs** · a small meeting table with 4 chairs (it's big enough) · bookshelves along the back wall · two large plants · art or a big whiteboard · **a rug under the desk** · a drinks cabinet or awards shelf if the pack has one.

**Spend the most time here.** It's the biggest room and the one people will look at first. It must be obviously nicer than the seniors' cabins — not just bigger.

### Senior cabins ×3 *(9 × 12 each)*
Desk + chair · monitor · small bookshelf · one plant · a poster · a visitor chair.

**Make them clearly different from each other** — different plant, different poster, desk against a different wall, a guitar in one, a bike in another. Three identical rooms look like a rendering bug.

### Lobby *(x2–13, full height)*
Reception desk with a counter near the top · a waiting sofa cluster with a coffee table · **several large plants** · a rug · wall clock · noticeboard · maybe a water cooler. This is the first thing anyone sees — make it welcoming and keep the centre clear.

### Open office *(x15–34, y17–29)*
**Four pods of 4 desks** — desks facing each other in pairs, like real offices:

| Pod | Desks occupy |
|---|---|
| A | x17–23, y18–21 |
| B | x27–33, y18–21 |
| C | x17–23, y25–28 |
| D | x27–33, y25–28 |

Keep **x24–26 clear** as a vertical walking lane and **y22–24 clear** horizontally. Monitors, keyboards, mugs, papers, a chair per desk. Add a printer, a water cooler, 2–3 plants between pods.

### Review room *(x36–43, y17–22)*
2 desks with large monitors · a whiteboard · one plant. Quiet and sparse — it should feel different from the busy open office.

### Lounge *(x36–43, y24–29)*
2–3 sofas or armchairs around a low table · **a big plant** · a magazine rack or coffee machine · a rug. Somewhere you'd genuinely wait.

### Meeting room *(x45–61, y17–29 — 17 × 13)*
**Long conference table down the centre**, roughly x49–57, y21–25, with **8 chairs** around it · large screen or projector on the far wall · whiteboard · a plant in each corner · water jug and glasses on the table.

This is the only room where characters from *different machines* stand together. Make it feel like a proper boardroom.

### Cafeteria *(x15–37, y32–38)*
3 tables with chairs · counter with stools · fridge · coffee machine · microwave · vending machine · a plant. Warm and social.

### Table tennis room *(x39–61, y32–38)*
**Table tennis table around x48–54, y33–34** — draw one if your pack lacks it · paddles and ball on it · bench along the wall · sports poster · water bottle · a plant. **Keep the floor south of the table clear** so characters can stand there.

> **Leave open floor everywhere.** Check the capacity numbers in Step 8 — that many characters must fit without standing on furniture.

---

## Step 8 — The 13 zone rectangles *(45 min — the most important step)*

Select the `zones` object layer, use **Insert Rectangle (R)**. For each: draw over **open floor**, set the **Name**, and add the custom property where noted.

| Draw over | Name | Property | Rect | Fits |
|---|---|---|---|---|
| Boss cabin open floor | `cabin` | `index` = `0` | x48 y5 · 11×6 | 5 |
| Senior 1 floor | `cabin` | `index` = `1` | x17 y5 · 5×5 | 2 |
| Senior 2 floor | `cabin` | `index` = `2` | x27 y5 · 5×5 | 2 |
| Senior 3 floor | `cabin` | `index` = `3` | x37 y5 · 5×5 | 2 |
| Pod A desks | `working` | `order` = `0` | x17 y19 · 6×2 | 3 |
| Pod B desks | `working` | `order` = `1` | x27 y19 · 6×2 | 3 |
| Pod C desks | `working` | `order` = `2` | x17 y26 · 6×2 | 3 |
| Pod D desks | `working` | `order` = `3` | x27 y26 · 6×2 | 3 |
| Review room floor | `reviewing` | — | x37 y19 · 6×3 | 4 |
| Lounge floor | `blocked` | — | x37 y25 · 6×4 | 4 |
| Meeting room, around the table | `collaborating` | — | x47 y20 · 13×7 | 8 |
| Cafeteria open floor | `idle` | — | x17 y34 · 19×4 | 8 |
| TT room, south of the table | `done` | — | x41 y35 · 19×3 | 6 |

### Rules

- ✅ **Names exact and lowercase.** `cabin`, not `Cabin` or `boss_cabin`.
- ✅ Snap to the tile grid (View → Snapping → Snap to Grid).
- ✅ Over **empty floor only** — never a desk, a wall, or the TT table.
- ✅ Zones must **not overlap each other**.
- ✅ `cabin` rects need `index` 0–3, no duplicates. `working` rects need `order` 0–3.
- ❌ Nothing outside this table. Exactly **13 rectangles, 7 distinct names**.

> There is **no rectangle named `needs_human`.** Agents that need a person go to that person's `cabin` — the code works out which one.

---

## Step 9 — Spawn point *(2 min)*

On the `markers` layer, place a **Point** object in the lobby (around x8, y27). Name it `spawn`. That's where people appear when they arrive — walking in through reception, which is the point of having a lobby.

---

## Step 10 — Characters *(3–4 hours)*

One PNG, `characters.png`, on a strict grid. Tell the coder the exact frame size.

### Humans — 8 characters, walk animation

Per character: **4 directions × 4 frames = 16 frames.** Row order **must** be: down, left, right, up. Frame 0 of each row is the standing pose.

```
        frame0   frame1   frame2   frame3
down   [ idle ][ walk ][ idle ][ walk ]
left   [      ][      ][      ][      ]
right  [      ][      ][      ][      ]
up     [      ][      ][      ][      ]
```

Lay the 8 characters out in a vertical strip (character 0 = rows 0–3, character 1 = rows 4–7, …) so the coder indexes them by number. The [LPC generator](https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/) exports this layout directly.

### AI agents — 6 characters, **no animation**

AI characters never walk. **One standing frame each.** This saves you most of the character work.

Make them clearly distinguishable from humans at a glance — a subtle glow, a headset, a cooler palette, a small badge.

| # | Role | Suggestion |
|---|---|---|
| 0 | developer | Hoodie, headphones |
| 1 | research | Glasses, notebook |
| 2 | qa | Clipboard, magnifier |
| 3 | review | Formal, arms crossed |
| 4 | docs | Books |
| 5 | planner | Tablet |

---

## Step 11 — Export *(5 min)*

**File → Export As… → JSON map files (*.tmj, *.json)** → save as `office.json`.

Deliver:
```
public/assets/
├── office.json
├── tileset.png
└── characters.png
```
Plus `CREDITS.md` if anything needs attribution.

### Sanity-check the export

```json
{ "width": 64, "height": 40, "tilewidth": 16, "tileheight": 16,
  "layers": [
    { "name": "floor",   "type": "tilelayer",   "data": [ ... ] },
    { "name": "walls",   "type": "tilelayer",   "data": [ ... ] },
    { "name": "props",   "type": "tilelayer",   "data": [ ... ] },
    { "name": "zones",   "type": "objectgroup", "objects": [
        { "name": "cabin", "properties": [{ "name": "index", "value": 0 }],
          "x": 768, "y": 80, "width": 176, "height": 96 },
        { "name": "working", "properties": [{ "name": "order", "value": 0 }], ... }
    ]},
    { "name": "markers", "type": "objectgroup", "objects": [{ "name": "spawn", ... }] }
  ],
  "tilesets": [ { "image": "tileset.png", ... } ]
}
```

If any of the five layer names is missing, or `zones` has fewer than **13** objects, fix it before handing over.

> Object `x`/`y` are in **pixels**, not tiles — Tiled does this automatically. The coder divides by 16. Don't "fix" it.

---

# Definition of done

- [ ] Map exactly 64 × 40, tiles exactly 16 × 16
- [ ] All five layers, exact lowercase names
- [ ] Floor filled everywhere — **zero gaps**
- [ ] All 11 rooms enclosed, each with a visible door gap
- [ ] Cabin fronts and the meeting room use **glass** — you can see inside
- [ ] Each area has a distinct floor, recognisable without labels
- [ ] **Boss cabin is 17 × 12 and obviously the nicest room in the building**
- [ ] The 3 senior cabins are visibly different from each other
- [ ] Open office has 4 pods of 4 desks with clear walking lanes at x24–26 and y22–24
- [ ] Lobby has reception, sofas and plants; centre kept clear
- [ ] Meeting room has a long table with 8 chairs and a screen
- [ ] Cafeteria has tables, counter, fridge, coffee machine
- [ ] TT room has a table with clear floor to the south
- [ ] Exactly **13 zone rectangles**, exact lowercase names, on open floor, non-overlapping
- [ ] `cabin` rects have `index` 0–3; `working` rects have `order` 0–3
- [ ] `spawn` point in the lobby
- [ ] Tileset **embedded**; exported as JSON
- [ ] `CREDITS.md` if anything needs attribution
- [ ] **Greybox was delivered on day 2**

---

# Things you do NOT build

| Don't | Why |
|---|---|
| Collision data | Nobody's checking. Walking over a desk is fine |
| Opening/closing doors | A gap in the wall is a door |
| Multiple floors, stairs, lifts | One floor |
| Day/night, lighting, shadows | No |
| Any animation except the human walk cycles | AI characters need one frame each |
| Sound | No |
| More rooms than the eleven listed | Ask first |
| A second map | Finish this one |

---

# Common mistakes, in the order people make them

1. **Skipping the greybox** to make something pretty first → the coder is blocked for three days. Greybox on day 2, always.
2. **Wrong margin/spacing on the tileset** → everything offset by a pixel. Check on tile one.
3. **Gaps in the floor** → black squares. Fill every tile, including under walls and furniture.
4. **Zone names with capitals or spaces** → silently ignored; characters pile up in a corner. Exact lowercase.
5. **Missing `index` / `order` properties** → cabins and pods can't be told apart.
6. **Zones drawn over furniture** → characters stand on desks.
7. **Rooms too cramped** → 5 characters won't fit in the boss cabin. Check the "Fits" column.
8. **Forgetting to embed the tileset** → broken map.
9. **Mixing 16×16 and 32×32** → nothing lines up. Pick one, forever.

---

**If you're short on time:** Step 4 (greybox) is non-negotiable and comes first. Then floors, walls, zones — that's a working office. Furniture and characters are the polish, and they're what make it feel real.
