# How to Design the Office Yourself
### Software, workflow, and a generated starting point.

---

## The thing nobody tells you first

**Level design is not pixel art.** You are not going to draw a desk. You buy or download a tileset — someone else already drew 500 beautiful office objects — and you *arrange* them. It's closer to interior decorating than to illustration.

That means you can build a genuinely good-looking office **without drawing a single pixel**, and it's the reason this is a 2–3 day job and not a 3-week one.

Only two things here you might have to draw yourself: a table-tennis table, and glass wall tiles if your pack lacks them. Both are twenty-minute jobs.

---

## Which software

| Tool | Use it for | Cost | Verdict |
|---|---|---|---|
| **[Tiled](https://www.mapeditor.org/)** | Building the map | Free | ★ **This is the one.** Industry standard, exports the JSON the code reads, works on everything |
| **[LDtk](https://ldtk.io/)** | Building the map | Free | Prettier, more modern. Genuinely good — but its export shape differs and you'd have to adapt the loader. Use Tiled unless you fall in love with it |
| **[Aseprite](https://www.aseprite.org/)** | Drawing/editing tiles | ~$20 | The standard pixel-art tool. Worth it if you'll do this more than once |
| **[LibreSprite](https://libresprite.github.io/)** | Same | Free | Aseprite fork from before it went paid. Slightly clunkier, fully capable |
| **[Piskel](https://www.piskelapp.com/)** | Quick sprite edits | Free | Runs in a browser, zero install. Fine for a TT table and a few glass tiles |
| **[TexturePacker](https://www.codeandweb.com/texturepacker)** | Packing character sheets | Free tier | Only if your characters come as separate files |

**Minimum viable:** Tiled + a downloaded tileset. That's it.

---

## The office is already built

```bash
python3 tools/build_office.py
```

Writes the office **structure** — floors, walls, glass, doors — using your real LimeZu + Desk Essentials tiles. Furniture is left to you in Tiled:

| File | What |
|---|---|
| `assets/office.json` | 64×40, 6 layers, **13 zone rects** with `index`/`order`, spawn point, 4 tilesets registered. `props` layer is empty — that's yours |
| `assets/preview.png` | A true render — actual tiles composited, so what you see is what Tiled shows |

**Verified: zero floor holes, 13 zones, all layer names correct.** Open `assets/office.json` in Tiled and everything's there.

`tools/make_greybox.py` still exists if you ever want the flat-colour stencil back.

### How to change it

Everything lives in plain lists at the top of `build_office.py`:

| Edit | To change |
|---|---|
| `ROOMS` | room bounds and which floor each uses |
| `WALLS` / `GLASS` / `DOORS` | structure |
| `ZONES` | the 13 zone rectangles |
| `P` | the furniture catalogue — `(tileset, col, row, w, h)` |
| the `# FURNISH` block | what goes where |

Change a number, re-run, look at `preview.png`. That loop is seconds long and much faster than dragging tiles in Tiled — **do structure and bulk furniture in the script, fine detail in Tiled.**

### The wall system

Everything is now **LimeZu Modern Tiles** — no hand-drawn tiles at all.

| Part | Tileset | Tile | Height |
|---|---|---|---|
| Horizontal walls | `Room_Builder_Walls` | group 1, **col 1**, rows 34 + 35 (charcoal) | 2 tiles — face + base |
| Vertical walls | `Room_Builder_Walls` | group 1, **col 5**, row 34, rotated 90° | 1 tile |
| Cabin front glass | `Room_Builder_Walls` | group 3, **col 27**, rows 8 + 9 | 2 tiles |
| Door leaves | `Room_Builder_Walls` | group 2, **col 16**, row 22 (wood) | 1 tile |
| Floors | `Room_Builder_Floors` | 4 column groups × ~18 styles | — |
| Furniture | `Modern_Office_Black_Shadow` | see `P` in the build script | — |

**Two prop layers.** `props` holds the furniture; `props2` holds what sits *on top of* it — monitors, keyboards, papers, and wall posters. A workstation is desk (3×2 on `props`) + a clutter cluster (on `props2`, same cell) + a swivel chair one row below. `station()` in the build script does all three.

**Everything is 32 × 32 now.** The map is 64 × 40 tiles = 2048 × 1280 px.

`Room_Builder_Walls` is **3 column groups of 10** — group 1 = cols 0–9, group 2 = 11–20, group 3 = 22–31 — each a stack of ~18 styles in **row pairs**. Change `CHARCOAL = 34` in the build script to try another style.

**Which column matters more than which row.** Inside every group of 10: the **2nd column** is the 2-tall middle and the **6th** is the 1-tall middle. Everything either side is an **end cap**. Put a cap in the middle of a run and you get a dark tick straight through the wall — I hit this twice before spotting it.

`Room_Builder_Floors` works the same way: 4 column groups (0–2, 4–6, 8–10, 12–14), styles stacked in row pairs, columns within a group are variants you can mix.

**Horizontal walls are 2 tiles tall.** The top tile is the wall face you look at, the one below is its base with skirting. That's LimeZu's own convention and it's what gives rooms depth instead of a flat blueprint. Only the outer top shell keeps the white ceiling cap (rows 17+18, col 1); interior walls use the capless face (col 5 row 17) over the base (col 1 row 18), because a white cap mid-building just reads as a stray line.

### The rotation trick

Those wall tiles only have outlines on their top and bottom edges, so a vertical run looks like a row of ticks. The fix is Tiled's rotation flags — `fill_wall()` detects a vertical run and ORs `FLIP_D | FLIP_H` into the gid, rotating it 90°. Tiled reads this natively and so does the renderer (see `OFFICE.md` step 3.5).

### Two gotchas I hit, so you don't

1. **Tables are cap tiles, not blocks.** `Interiors` col 5 and col 8 are *empty*. The beige table is left=6, middle=9, right=7; the brown is left=1, middle=4, right=2. Tiling a "4-wide table" leaves gaps. `long_table()` handles it.
2. **Character frames are 16 × 32**, not 16×16 — and `run` has 6 frames per direction, not 4.
3. **Mask the gid** before looking up a tile — 180 of them carry rotation bits.

---

## The workflow

### Step 1 — Look at what you have
Open `assets/preview.png`. Each flat colour is a room, each bright outline is a zone rectangle. Decide now if you want the structure changed — that's cheap today and expensive after you've furnished it.

### Step 2 — Open it in Tiled
`File → Open → assets/office.json`. You'll see five layers: `floor`, `walls`, `props`, `zones`, `markers`.

Turn `zones` and `markers` visibility **off** while you decorate — they'll get in the way. Turn them back on to check placement.

### Step 3 — Add the real tileset
Download a pack (see below), then **Map → New Tileset → Based on Tileset Image**, embed it in the map. You now have two tilesets: `greybox` and your real one.

### Step 4 — ★ The trick that saves you a day

**Use the bucket fill tool.** Every greybox room is one solid flat colour, so:

1. Select the `floor` layer
2. Pick your real carpet tile from the real tileset
3. Bucket fill (**F**) → click once inside a room

The whole room fills with the real tile, **exactly to the greybox boundaries.** One click per room. Eleven clicks and your entire floor is real art with perfect edges.

Same for walls: pick the real wall tile, bucket fill each wall run.

> This is why the greybox is worth generating even though it looks terrible. It's a stencil.

### Step 5 — Refine floors
Bucket fill gives you a flat single tile. Now scatter 2–3 variant tiles by hand so it doesn't look like a spreadsheet, and lay proper edge/corner tiles where floor types meet if your pack has them.

### Step 6 — Walls and glass
Replace the flat wall runs with the pack's proper wall tiles — most have separate top/side/corner pieces. **Use glass tiles for the cabin fronts and the meeting room's north wall.** You should be able to see people inside their offices from the corridor; that's the whole point of a presence display.

### Step 7 — Furniture, on the `props` layer
This is the fun part and where the office gets its personality. Room-by-room lists are in `OFFICE-MAP.md` Step 7. Priority order:

1. **Boss cabin** — biggest room, first thing anyone looks at. Executive desk angled into the corner, its own small meeting table, bookshelves, rug, two big plants. Must look *nicer*, not just bigger.
2. **Open office** — 4 pods of 4 desks, monitors, mugs, chairs. Keep x24–26 and y22–24 clear as walking lanes.
3. **Meeting room** — long table, 8 chairs, screen on the far wall.
4. **Lobby** — reception counter, sofa cluster, several big plants. Keep the centre clear.
5. Everything else.

### Step 8 — Check your zones still work
Turn the `zones` layer back on. Every rectangle must sit on **open floor** — not on a desk you just placed. If a desk landed inside a zone, move the desk, not the zone.

### Step 9 — Delete the greybox
Once every greybox colour is gone, remove the `greybox` tileset from the map (**Tileset panel → right-click the tab → Remove**). Then export: **File → Export As → JSON**, overwriting `assets/office.json`.

---

## Where to get tilesets

| Pack | Link | Note |
|---|---|---|
| **LimeZu — Modern Office** | [limezu.itch.io/modernoffice](https://limezu.itch.io/modernoffice) | ★ Purpose-built: desks, cubicles, glass walls, meeting rooms. Free + paid tiers |
| **LimeZu — Modern Interiors** | [limezu.itch.io/moderninteriors](https://limezu.itch.io/moderninteriors) | Kitchen, cafeteria, sofas, plants live here |
| **Kenney** | [kenney.nl/assets](https://kenney.nl/assets) | **CC0, no attribution.** Less office-specific, zero license worry |
| **Pixel Office 32×32** | [masalimov-ilnur.itch.io/pixel-office](https://masalimov-ilnur.itch.io/pixel-office) | 32×32 alternative |
| **Characters** | [LPC Generator](https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/) | Free, unlimited characters, exports the right layout. **CC-BY-SA — credit required** |

**Check the license on every page.** Keep a `CREDITS.md` for anything requiring attribution.

> If you pick a 32×32 pack, change `TS = 16` to `TS = 32` at the top of `make_greybox.py`, re-run, and tell the coder. **Never mix sizes.**

---

## Design principles for top-down offices

Things that separate a good pixel office from a grid of boxes:

**Vary room sizes deliberately.** The boss cabin at 17×12 against seniors at 9×12 reads as hierarchy without a single label. Four identical rooms read as a bug.

**Give the map one strong architectural line.** Here it's `x44`, running from the top of the map down to y29, separating the boss cabin and meeting room into their own wing. One confident line does more than a dozen fussy details.

**Cluster desks, never row them.** Pods of four facing each other look like a workplace. Long rows look like a spreadsheet.

**Leave real negative space.** Corridors, the lobby centre, the floor around the TT table. Beginners fill every tile; empty floor is what makes the full parts read.

**Use floor colour to zone the space.** Someone should identify every room by its floor alone, with the walls hidden.

**Glass where you want to see through.** Cabin fronts, meeting room. It's the difference between "rooms" and "an office you can observe."

**Plants in every corner and along every corridor.** The cheapest thing that makes a pixel office look inhabited. Genuinely — corners look broken without them.

**Asymmetry in the details, symmetry in the structure.** Rooms line up; what's inside them shouldn't. Different plant, different poster, desk against a different wall.

---

## If you want to draw your own tiles

You probably shouldn't for v1 — but if you do:

1. Open Aseprite/LibreSprite, new file **16×16**, grid on.
2. Work in a **limited palette** — 4–6 colours per object. Restraint is what makes pixel art read at small sizes.
3. Light from one consistent direction (top-left is conventional).
4. Export tiles into one sheet, no margin, no spacing, on a strict grid.
5. **Nearest-neighbour scaling everywhere.** Any smoothing and it turns to mush.

Start with the table-tennis table: green rectangle, white centre line, small net, two paddles. It's the easiest possible first tile and you'll need it regardless.

---

## Iterating

The loop is short, use it often:

```bash
# change ROOMS / WALLS / DOORS / ZONES in tools/make_greybox.py
python3 tools/make_greybox.py
open assets/preview.png          # see it instantly
```

**Structural changes go in the script. Decoration goes in Tiled.** Once you start furnishing, re-running the generator overwrites your work — so lock the structure *first*, then decorate. If you must change structure later, do it in Tiled by hand.

---

## Quick reference — the layout

| Area | x | y | Size |
|---|---|---|---|
| Lobby | 2–13 | 3–38 | 12 × 36 |
| Senior cabin 1 · 2 · 3 | 15–23 · 25–33 · 35–43 | 3–12 | 9 × 10 each |
| **Boss cabin** | **45–61** | **3–12** | **17 × 10** |
| North corridor | 15–61 | 15–16 | 47 × 2 |
| Open office | 15–34 | 19–29 | 20 × 11 |
| **Atrium** | **36–43** | **15–31** | **8 × 17** |
| Meeting room | 45–61 | 19–29 | 17 × 11 |
| Cafeteria | 15–37 | 32–38 | 23 × 7 |
| Chill room | 39–61 | 32–38 | 23 × 7 |

**13 zone rectangles, 7 names:** `cabin`×4 *(index 0–3, 0 = boss)* · `working`×4 *(order 0–3, the desk pods)* · `blocked` *(atrium upper)* · `reviewing` *(atrium lower)* · `collaborating` *(meeting room)* · `idle` *(cafeteria)* · `done` *(chill room)*. Plus a `spawn` point in the lobby.

> **The atrium must stay open at both ends.** It is the only route from the offices to the cafeteria and chill room. Furnish its edges, never its middle.
