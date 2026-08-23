# Asset Review

**The project now runs on the full LimeZu Modern Interiors / Modern Office set at 32 × 32 px.** Everything below is what's in `assets/` and how it's used.

---

## Tilesets

| File | Tiles | Used for |
|---|---|---|
| `archive/Room_Builder_Walls.png` | 32 × 40 | **All walls.** 3 column groups of 10, ~18 styles each in row pairs. Currently: charcoal (group 1, rows 34–35), glass (group 3, rows 8–9), wood doors (group 2, row 22) |
| `tilesets/agentroom/FloorAndGround.png` | 64 × 40 | **All floors.** 4 column groups of 3 (cols 1–3, 5–7, 9–11, 13–15), ~18 styles each in row pairs. Currently using **cols 5–7 rows 36–37** — light grey — for every room |
| `archive/Room_Builder_Floors.png` | 15 × 40 | Alternate floor library, unused |
| `archive/Room_Builder_Office.png` | 16 × 14 | Office-specific wall + floor styles (spare) |
| `tilesets/Modern_Office_Black_Shadow.png` | 16 × 53 | **Furniture.** Key coordinates: desks `(6,1)/(1,5)/(6,5)/(11,1)` 3×2 · overhead hutch `(7,12)` with items, `(7,15)` plain · swivel chairs seen from behind `(0..3,8)` dark and `(0..3,10)` orange · desktop clutter `(8,26)/(10,26)/(13,28)/(10,30)/(10,32)/(14,26)` · whiteboard `(15,0)` · corkboard `(15,2)` · screens `(10,12)/(10,14)` · sofas `(0,17)` · plants `(6,8)/(6,12)` · printer `(9,23)` · server rack `(0,23)` |
| `tilesets/Generic.png` | 16 × 78 | Spare general furniture |
| `tilesets/Basement.png`, `Classroom_and_library.png` | — | Unused, available |
| `map/FloorAndGround.png` | 64 × 40 | Unused |

## Characters

`characters/` — Adam, Alex, Amelia, Bob (LimeZu) plus `adam/ash/lucy/nancy` TexturePacker atlases.

**Frames are 32 × 48**, 52 per atlas, JSON in TexturePacker format:

```json
{"filename":"Adam_idle_anim_1.png","frame":{"x":0,"y":0,"w":32,"h":48}}
```

`characters/single/` holds 208 individual frames if you'd rather not use the atlas.

## The two column rules — read before touching tiles

1. **Walls:** inside each group of 10 columns, the **2nd column** is the 2-tall middle and the **6th** is the 1-tall middle. Everything either side is an **end cap** — using one mid-run puts a dark tick through the wall.
2. **Vertical wall runs are rotated 90°** via Tiled's flip bits. Mask `gid & 0x1FFFFFFF` before any lookup.

## Licensing

`assets/LICENSE-LimeZu.txt` covers the original free download. The larger tilesets here came from the repos you supplied — keep the project private and non-commercial, and if it ever ships, buy the packs ($1.50 Modern Interiors / $2.50 Modern Office) and swap the files. Same filenames, no code change.
