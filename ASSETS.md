# Asset Review

**The project now runs on the full LimeZu Modern Interiors / Modern Office set at 32 × 32 px.** Everything below is what's in `assets/` and how it's used.

---

## Tilesets

| File | Tiles | Used for |
|---|---|---|
| `archive/Room_Builder_Walls.png` | 32 × 40 | **All walls.** 3 column groups of 10, ~18 styles each in row pairs. Currently: charcoal (group 1, rows 34–35), glass (group 3, rows 8–9), wood doors (group 2, row 22) |
| `archive/Room_Builder_Floors.png` | 15 × 40 | **All floors.** 4 column groups (0–2, 4–6, 8–10, 12–14), ~18 styles each |
| `archive/Room_Builder_Office.png` | 16 × 14 | Office-specific wall + floor styles (spare) |
| `tilesets/Modern_Office_Black_Shadow.png` | 16 × 53 | **Furniture.** Desks, swivel chairs (dark + orange), sofas, low tables, shelves, screens, printers, server racks, cabinets, counters, plants, glass partitions |
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
