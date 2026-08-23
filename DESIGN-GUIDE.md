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
| Floors | `agentroom/FloorAndGround.png` | **cols 5–7, rows 36–37** — one light grey tile everywhere | — |
| Furniture | `Modern_Office_Black_Shadow` | see `P` in the build script | — |

**Two prop layers.** `props` holds the furniture; `props2` holds what sits *on top of* it — monitors, keyboards, papers, and wall posters.

**A workstation is four pieces stacked, 6 rows tall.** `station()` in the build script assembles them:

| Rows | Piece | Layer | Tile |
|---|---|---|---|
| y, y+1 | desk, 3 wide | `props` | `MO(6,1)` tan · `MO(1,5)` wood · `MO(6,5)` white · `MO(11,1)` dark |
| y, y+1 | desktop clutter — monitor, keyboard, papers, photo | `props2` | `MO(8,26)` `MO(10,26)` `MO(13,28)` `MO(10,30)` `MO(10,32)` `MO(14,26)` |
| y+1, y+2 | swivel chair, tucked in | **`props3`** | `MO(0..3, 8)` dark · `MO(0..3, 10)` orange |

### Room sizes: grow the map, don't shrink a neighbour

The cafeteria and chill room went from 7 to 9 rows by **raising the map height from 40 to 46**, not by taking rows from the open office. Everything above `y33` kept its coordinates; only the south wing moved down. That's the cheap direction — shifting the whole middle band would have moved every workstation, zone rect and carpet with it.

| Area | y range | Rows | State |
|---|---|---|---|
| Cabins | 3–12 | 10 | furnished |
| Corridor | 15–22 | 8 | open circulation |
| Open office (open plan) | 17–35 | 19 | furnished |
| **Meeting room** (walled) | **23–33** | 11 | furnished |
| **Cafeteria** (walled) | 36–44 | 9 | **empty — carpet only** |
| **Chill room** (walled) | 36–44 | 9 | **empty — carpet only** |
| **Lobby / reception** | 3–44 | 42 | **empty — carpet only** |

**Three rooms are deliberately empty** — lobby, cafeteria and chill room carry their carpet and nothing else. Their furniture calls were stripped, not commented out; the catalogue entries all still exist if you want to refurnish them.

### The employee desk floor is open plan

There are **no walls around the desk area** — it's defined entirely by its sage carpet, the way a real open-plan floor is. The walls at `y17`, `y30` and `x35` were removed, so the desks, the corridor and the atrium are one continuous space.

Consequence: `HWALL` now only carries the meeting room's two runs, and the open-office doors are gone from `DOORS_H` / `DOORS_V`. The `working`, `blocked` and `reviewing` zone rectangles are unchanged — they never depended on walls.

### Workstations

`cubicle_row(xs, y, desk, tops, chairs)` builds a run of plain workstations — **desk, monitor, chair, nothing else**. Desks sit 4 tiles apart.

Partition posts (`POST`, `POST_L`, `POST_R` from `MO` rows 26–28) and the overhead hutch are still in the catalogue but **deliberately unused** — they crowded the desks and made the rooms read as cramped. Pass `hutch="HUTCH"` to `station()` if you ever want one back.

**The chair overlaps the desk's lower row on purpose** — that's what makes it read as *pulled up* rather than parked two tiles away. It needs its own layer above the clutter, or it erases the keyboard underneath it.

**Verify sprite bounds before declaring them.** `tools/sprite_boxes.py` helps, but this sheet packs sprites edge-to-edge with drop shadows, so components merge — the reliable method is `tools/gl32.py`-style zoom on the region and read the extents. Three of my declarations were wrong at first: `CABINET` is 1×3 not 2×4, `PRINTER` is 1×2 not 2×2, and `SIDEBRD` pointed at a blank row entirely. A wrong box slices through the middle of a sprite and renders as a flat slab.

Pass `hutch=None` for a low open desk — that variant is only 4 rows tall, which is how the back row of the open office is built.

**Wall decor is removed.** Posters, whiteboards and wall screens all sat 2 tiles tall on a 2-tile wall, so their lower half overhung into the room and read as clutter hanging off the ceiling. `wall_dec()` is now a no-op; the sprites stay in the catalogue (`WHITEBOARD`, `CORKBOARD`, `SCREEN`, `SCREEN2`, `POSTER`, `TV`) if you want to revisit them with 1-tile-tall art.

### Carpets, not rug sprites

Ornate rug sprites look wrong in a modern office and never match the furniture they sit under. `carpet(x, y, w, h, tiles)` fills a **rectangle on the `deco` layer** with a real floor tile instead — so an area rug is any size you want and reads as zoning:

| Area | Colour | Tile | RGB |
|---|---|---|---|
| **Base floor, everywhere** | light grey | `FG(37,4)` | 204,204,204 |
| Employee desks | sage | `FG(59,20)` | 156,169,158 |
| Meeting room | light blue | `FG(59,8)` | 134,184,223 |
| Lobby lounges, boss cabin | teal | `FG(59,10)` | 137,188,198 |
| Senior cabins | warm grey | `FG(37,8)` | 212,210,198 |
| Cafeteria | tan | `FG(37,24)` | 192,164,140 |
| Chill room | plum | `FG(48,36)` | 131,112,180 |

**These are flat single-colour tiles — no grid, no pattern.** Found by scanning the sheet for tiles whose internal luminance variation is zero:

```bash
# sd = pixel variation inside the tile; 0.0 means a solid colour field
python3 - <<'EOF'  # see the scan in tools/, or re-run ad hoc
EOF
```

`FloorAndGround` is 64 × 40 tiles, and its flat swatches live well to the right of the patterned floors — around **cols 37, 48 and 59**. Easy to miss if you only survey the first 16 columns, which is what I did for several passes.

**Keep the base light and neutral and the carpets clean.** I tried a warm beige brick base to match a Gather screenshot and it read as dated and muddy — that sheet's beige/khaki tiles are its weakest. The bright large-format tiles (`g2 r28-31`, `g3 r32`, `g4 r30-33`) are the modern-looking ones.
