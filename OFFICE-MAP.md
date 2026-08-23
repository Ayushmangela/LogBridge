# Build Doc — The Office Map & Assets
### Your job: design and build the pixel office. No code.

You are building the **place**. Someone else writes the code that puts characters in it.

You deliver **three files**. That's the whole job.

| # | File | What it is |
|---|---|---|
| 1 | `tileset.png` | One image containing every floor, wall and furniture tile |
| 2 | `characters.png` | One image containing every character sprite |
| 3 | `office.json` | The map itself, exported from Tiled |

Drop them in `public/assets/` and you're done. Estimated time: **2–3 days.**

---

## Tools — install these first

| Tool | Cost | What for | Link |
|---|---|---|---|
| **Tiled** | Free | Drawing the map. This is your main tool | [mapeditor.org](https://www.mapeditor.org/) |
| **Aseprite** | ~$20 | Editing/making sprites *(optional)* | [aseprite.org](https://www.aseprite.org/) |
| **LibreSprite** | Free | Free Aseprite alternative | [libresprite.github.io](https://libresprite.github.io/) |
| **Piskel** | Free | Browser-based, zero install | [piskelapp.com](https://www.piskelapp.com/) |

You only need Tiled. The others are for touching up sprites if the asset pack is missing something.

---

## Where to get the art

**Check the license on every page before downloading.** Some are free, some cost a few dollars, some need credit.

| What | Link | Notes |
|---|---|---|
| **Office tileset** ★ best choice | [LimeZu — Modern Office 16×16](https://limezu.itch.io/modernoffice) | Purpose-built office: desks, chairs, cubicles, meeting rooms. Free and paid tiers — check which files you get |
| | [LimeZu — Modern Interiors](https://limezu.itch.io/moderninteriors) | Same artist, wider set. Kitchen/cafeteria props live here |
| **Alternative** | [Pixel Office 32×32](https://masalimov-ilnur.itch.io/pixel-office) | Simpler, 32×32 |
| **Zero-license-worry fallback** | [Kenney.nl](https://kenney.nl/assets) | **CC0 — no attribution needed.** Less office-y but you'll never have a license problem |
| **Characters** | LimeZu packs include matching characters — **prefer these** | Same art style as the tiles |
| | [LPC Character Generator](https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/) | Free, make unlimited characters. **CC-BY-SA — you must credit.** Keep a `CREDITS.md` |

> **Table tennis table:** unlikely to be in an office pack. Either pull one from a general furniture pack, or draw it yourself — it's a green rectangle with a white line and a net. Twenty minutes in Piskel.

---

## Decisions already made — don't change these

| | |
|---|---|
| **Tile size** | **16 × 16 px** |
| **Map size** | **60 × 40 tiles** (960 × 640 px, renders at 2× = 1920 × 1280) |
| **Orientation** | Orthogonal, top-down |
| **Render order** | Right Down |
| **Export format** | JSON |

**Never mix tile sizes.** If your pack is 32×32, use 32×32 for *everything* and tell the coder. Mixing 16 and 32 in one map will waste a day.

---

# The floor plan

Seven areas. Here's the whole map — build exactly this.

```
   x0        x16      x30      x44          x57
   ┌─────────────────────────────────────────────┐ y0
   │ ╔══════════╗ ╔═══════╗ ╔═══════╗ ╔═══════╗ │
   │ ║          ║ ║       ║ ║       ║ ║       ║ │
   │ ║   BOSS   ║ ║SENIOR ║ ║SENIOR ║ ║SENIOR ║ │
   │ ║  CABIN   ║ ║   1   ║ ║   2   ║ ║   3   ║ │ y2–y11
   │ ║  14×10   ║ ║ 13×10 ║ ║ 13×10 ║ ║ 13×10 ║ │
   │ ║          ║ ║       ║ ║       ║ ║       ║ │
   │ ╚═══╡ ╞════╝ ╚══╡ ╞══╝ ╚══╡ ╞══╝ ╚══╡ ╞══╝ │
   │      door         door      door      door  │
   │  ▭▭▭  ← waiting bench                       │ y12–y14  CORRIDOR
   │─────────────────────────────────────────────│
   │                                             │
   │   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   │
   │                                             │
   │            OPEN OFFICE  56×15               │ y15–y29
   │        (employee desks — the work floor)    │
   │   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   ▤▤   │
   │                                             │
   │                              ★ spawn        │
   │─────────────────────────────────────────────│ y30–y31  CORRIDOR
   │ ╔════════════════════╗ ╔══════════════════╗ │
   │ ║                    ║ ║                  ║ │
   │ ║     CAFETERIA      ║ ║  TABLE TENNIS    ║ │ y32–y38
   │ ║       26×7         ║ ║      28×7        ║ │
   │ ╚════════════════════╝ ╚══════════════════╝ │
   └─────────────────────────────────────────────┘ y39
```

### Exact coordinates

| Area | x range | y range | Size |
|---|---|---|---|
| Boss cabin | 2 – 15 | 2 – 11 | 14 × 10 |
| Senior cabin 1 | 17 – 29 | 2 – 11 | 13 × 10 |
| Senior cabin 2 | 31 – 43 | 2 – 11 | 13 × 10 |
| Senior cabin 3 | 45 – 57 | 2 – 11 | 13 × 10 |
| Corridor (top) | 2 – 57 | 12 – 14 | 56 × 3 |
| Open office | 2 – 57 | 15 – 29 | 56 × 15 |
| Corridor (bottom) | 2 – 57 | 30 – 31 | 56 × 2 |
| Cafeteria | 2 – 27 | 32 – 38 | 26 × 7 |
| Table tennis room | 30 – 57 | 32 – 38 | 28 × 7 |

Walls sit at x=0–1, x=58–59, y=0–1, y=39, and on the cabin dividers at x=16, 30, 44 and the cafeteria/TT divider at x=28–29.

---

# The one thing you need to know about the system

Characters appear in rooms based on **what they're actually doing**. The code needs to know which rectangle of floor belongs to which activity — so you draw a named rectangle in each room.

**This mapping is why the office is useful and not just decoration:**

| Room you build | Zone name to use | What it means when someone's standing there |
|---|---|---|
| Boss cabin | `needs_human` | An AI is stuck and needs a person to decide. **The most important room** |
| Senior cabin 1 | `reviewing` *(order 0)* | An AI is reviewing someone's code |
| Senior cabin 2 | `reviewing` *(order 1)* | same |
| Senior cabin 3 | `reviewing` *(order 2)* | same |
| Open office | `working` | An AI is actively working right now |
| Waiting bench in corridor | `blocked` | Waiting on a test run, a build, or another AI |
| Cafeteria | `idle` | Online, nothing to do |
| Table tennis room | `done` | Just finished a job |

> Someone glancing at this map should instantly read the state of the whole team: **cafeteria full = quiet day. Boss cabin full = people are needed. Bench full = something's stuck.**
>
> That's the whole design goal. Make those rooms visually distinct enough to tell apart at a glance from across the room.

Three cabins share the name `reviewing` — that's intentional. The code fills them in `order` sequence.

---

# STEP BY STEP

## Step 1 — Set up the project *(15 min)*

1. Install Tiled.
2. Make a folder `office-map/`.
3. Download your tileset, put the PNG in `office-map/`.
4. Open Tiled → **File → New → New Map**:

| Setting | Value |
|---|---|
| Orientation | Orthogonal |
| Tile layer format | CSV |
| Tile render order | Right Down |
| Map size | Fixed, **60 × 40** |
| Tile size | **16 × 16** |

Save as `office.tmx`.

---

## Step 2 — Load the tileset *(10 min)*

**Map → New Tileset**:

| Setting | Value |
|---|---|
| Name | `office` |
| Type | Based on Tileset Image |
| Source | your `tileset.png` |
| Tile width / height | 16 / 16 |
| Margin / Spacing | usually 0 / 0 — **check the pack's readme** |
| **Embed in map** | ✅ **ON** |

> **Embed in map must be ON.** It makes the exported JSON self-contained, so the coder gets one file instead of chasing a missing `.tsx`. If the tiles look offset by a pixel, your margin/spacing is wrong — fix it now, not after you've drawn everything.

---

## Step 3 — Create the layers, named exactly *(5 min)*

In the Layers panel, create these **in this order, bottom to top**, with these **exact lowercase names**:

| # | Layer | Type | Contains |
|---|---|---|---|
| 1 | `floor` | Tile layer | Carpet, tiles, grass — every walkable surface |
| 2 | `walls` | Tile layer | All walls, doors, windows |
| 3 | `props` | Tile layer | Desks, chairs, plants, fridge, TT table |
| 4 | `zones` | **Object layer** | The named rectangles from the table above |
| 5 | `markers` | **Object layer** | Spawn point |

The code reads these names literally. `Floor` or `floor_layer` will not work — it must be `floor`.

---

## Step 4 — Draw the floor *(2 hours)*

Fill the entire 60 × 40 map. **No gaps anywhere** — a hole in the floor renders as a black square.

Give each area a different floor so rooms are distinguishable without reading labels:

| Area | Suggested floor |
|---|---|
| Boss cabin | Dark wood / premium carpet |
| Senior cabins | Grey or blue carpet |
| Open office | Light neutral carpet |
| Corridors | Polished concrete or tile |
| Cafeteria | Checkerboard or kitchen tile |
| Table tennis room | Sports wood / green |

Sprinkle 2–3 variant tiles into large areas so it doesn't look like a spreadsheet.

---

## Step 5 — Draw the walls *(2 hours)*

- Outer wall around the whole 60 × 40 map.
- Cabin walls at x=16, 30, 44 (y2–y11).
- Cabin fronts along y=11, **with a 2-tile door gap in each**.
- Cafeteria/TT divider at x=28–29 (y32–y38).
- Cafeteria and TT front walls along y=31, with door gaps.

**Doors:** just leave a 2-tile gap in the wall. Add a door-frame tile if the pack has one. Don't build opening doors.

Every room must be **fully enclosed except its door**. Walk the perimeter of each room in Tiled and check for holes.

---

## Step 6 — Furniture *(4–6 hours — the fun part)*

Everything here is decoration. It doesn't affect gameplay. Make it look like a real office.

### Boss cabin
Large executive desk facing the door · high-backed chair · 2 visitor chairs · bookshelf · large plant · whiteboard or wall art · rug. **Should feel noticeably more expensive than the other cabins.**

### Senior cabins ×3
Desk + chair · monitor · small shelf · a plant · a poster. **Vary them** — different plant, different poster, desk on a different wall. Three identical cabins look like a bug.

### Open office
**8–10 desks in 2 rows** — this is the main work floor and should look busy. Monitors, keyboards, mugs, papers. Add a couple of plants, a printer, a water cooler. Leave clear walking lanes between desk rows.

### Waiting bench *(corridor, outside the boss cabin, around x4–x10, y13)*
A bench or 3–4 chairs against the wall. Small area, but it's a real zone — people wait here when they're blocked.

### Cafeteria
2–3 tables with chairs · counter or kitchen units · fridge · coffee machine · microwave · vending machine · a plant. Warm and social.

### Table tennis room
**Table tennis table in the centre** — draw one if your pack lacks it (green rectangle, white centre line, small net). Paddles/ball on the table · a bench along the wall · sports poster · water bottle. Keep the area around the table clear so characters can stand there.

> **Leave open floor.** Every room needs empty space for characters to stand — check the capacity numbers in Step 7 and make sure that many characters fit without sitting on the furniture.

---

## Step 7 — The zone rectangles *(30 min — the most important step)*

Select the `zones` object layer. Use the **Insert Rectangle** tool (R).

For each rectangle: draw it over the **open floor** of the room, then in the Properties panel set the **Name** field, and add a custom property `order` (int) where noted.

| Draw over | Name (exact) | `order` | Suggested rect | Fits |
|---|---|---|---|---|
| Boss cabin open floor | `needs_human` | — | x4 y6 · 10×4 | 6 |
| Senior cabin 1 floor | `reviewing` | `0` | x19 y6 · 9×4 | 2 |
| Senior cabin 2 floor | `reviewing` | `1` | x33 y6 · 9×4 | 2 |
| Senior cabin 3 floor | `reviewing` | `2` | x47 y6 · 9×4 | 2 |
| Open office, between desk rows | `working` | — | x4 y17 · 50×10 | 12 |
| Corridor by the bench | `blocked` | — | x4 y13 · 8×2 | 4 |
| Cafeteria open floor | `idle` | — | x4 y33 · 22×5 | 8 |
| TT room around the table | `done` | — | x32 y33 · 24×5 | 6 |

### Rules for zone rectangles

- ✅ **Names must be exact and lowercase.** `needs_human`, not `Needs Human` or `boss_cabin`.
- ✅ Rectangles snap to the tile grid (View → Snapping → Snap to Grid).
- ✅ Draw over **empty floor only** — never over a desk, wall, or the TT table.
- ✅ Zones must **not overlap each other**.
- ✅ The three `reviewing` rects must have `order` 0, 1, 2 — no duplicates, no gaps.
- ❌ Don't add zones that aren't in this table. There are exactly **eight rectangles, six distinct names.**

---

## Step 8 — Spawn point *(2 min)*

On the `markers` layer, place a **Point** object in the open office (around x40, y27). Name it `spawn`. That's where people appear when they enter.

---

## Step 9 — Characters *(3–4 hours)*

One PNG, `characters.png`, laid out on a strict grid. Tell the coder the exact frame size.

### Humans — 8 characters, walk animation needed

Per character: **4 directions × 4 frames = 16 frames.**

```
        frame0  frame1  frame2  frame3
down   [ idle ][ walk ][ idle ][ walk ]
left   [      ][      ][      ][      ]
right  [      ][      ][      ][      ]
up     [      ][      ][      ][      ]
```

Row order **must** be: down, left, right, up. Frame 0 of each row is the standing pose.

Lay the 8 characters out in a vertical strip (character 0 rows 0–3, character 1 rows 4–7, and so on) so the coder can index them by number.

The [LPC generator](https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/) exports this layout directly — use it if your pack doesn't include enough characters.

### AI agents — 6 characters, **no animation at all**

The AI characters never walk. **One standing frame each** — that's it. This saves you most of the character work.

Make them visually distinct from humans — a subtle glow, a headset, a slightly different palette, a small badge. Someone should be able to tell human from AI at a glance without reading a name.

| # | Role | Suggestion |
|---|---|---|
| 0 | developer | Hoodie, headphones |
| 1 | research | Glasses, notebook |
| 2 | qa | Clipboard, magnifier |
| 3 | review | Formal, arms crossed |
| 4 | docs | Books |
| 5 | planner | Tablet |

---

## Step 10 — Export *(5 min)*

1. **File → Export As…**
2. Choose **JSON map files (*.tmj, *.json)**
3. Save as `office.json`

Deliver:

```
public/assets/
├── office.json
├── tileset.png
└── characters.png
```

Plus a `CREDITS.md` if any asset requires attribution.

### Sanity-check the export

Open `office.json` in a text editor. You should see:

```json
{ "width": 60, "height": 40, "tilewidth": 16, "tileheight": 16,
  "layers": [
    { "name": "floor",   "type": "tilelayer",   "data": [ ... ] },
    { "name": "walls",   "type": "tilelayer",   "data": [ ... ] },
    { "name": "props",   "type": "tilelayer",   "data": [ ... ] },
    { "name": "zones",   "type": "objectgroup", "objects": [
        { "name": "needs_human", "x": 64, "y": 96, "width": 160, "height": 64 },
        { "name": "reviewing", "properties": [{ "name": "order", "value": 0 }], ... }
    ]},
    { "name": "markers", "type": "objectgroup", "objects": [ { "name": "spawn", ... } ] }
  ],
  "tilesets": [ { "image": "tileset.png", ... } ]
}
```

If `layers` is missing any of the five names, or `zones` has fewer than 8 objects, fix it before handing over.

> Object `x`/`y` are in **pixels**, not tiles — Tiled does this automatically. The coder divides by 16. Don't try to "fix" it.

---

# Definition of done

- [ ] Map is exactly 60 × 40, tiles exactly 16 × 16
- [ ] All five layers exist with exact lowercase names
- [ ] Floor is filled everywhere — **zero gaps**
- [ ] All 7 rooms fully enclosed, each with a visible door gap
- [ ] Each room has a distinct floor — recognisable without labels
- [ ] Boss cabin looks more expensive than the senior cabins
- [ ] The 3 senior cabins are visibly *different from each other*
- [ ] Open office has 8–10 desks in clear rows with walking lanes
- [ ] Cafeteria has tables, counter, fridge, coffee machine
- [ ] TT room has a table tennis table with clear floor around it
- [ ] Waiting bench exists in the corridor outside the boss cabin
- [ ] Exactly **8 zone rectangles**, exact lowercase names, on open floor, non-overlapping
- [ ] The 3 `reviewing` rects have `order` 0, 1, 2
- [ ] `spawn` point in the open office
- [ ] Tileset **embedded** in the map
- [ ] Exported as JSON; all three files in one folder
- [ ] `CREDITS.md` if anything needs attribution

---

# Things you do NOT build

| Don't | Why |
|---|---|
| Collision data | Nobody's checking. Walking over a desk is fine |
| Opening/closing doors | A gap in the wall is a door |
| Multiple floors, stairs, lifts | One floor |
| Day/night, lighting, shadows | No |
| Any animation except human walk cycles | AI characters need one frame each |
| Sound | No |
| More rooms than the seven listed | Ask before adding anything |
| A second map | Get this one finished first |

---

# Common mistakes, in the order people make them

1. **Wrong margin/spacing on the tileset** → everything is offset by a pixel. Check on tile one, not after a day of drawing.
2. **Gaps in the floor** → black squares in the game. Fill every tile, including under walls and furniture.
3. **Zone names with capitals or spaces** → the code silently ignores them and characters pile up in the corner. Exact, lowercase, from the table.
4. **Zones drawn over furniture** → characters stand on top of desks.
5. **Rooms too cramped** → 6 characters won't fit in the boss cabin. Check the "Fits" column and leave the floor open.
6. **Forgetting to embed the tileset** → the coder gets a broken map.
7. **Mixing 16×16 and 32×32 tiles** → nothing lines up. Pick one, forever.

---

**Suggested order if you're short on time:** Steps 1–5 give a working office shell. Step 7 (zones) makes it *usable* — do that before the furniture if you need to hand something over early. Furniture and characters are the polish, and they're what make it feel real.
