#!/usr/bin/env python3
"""Generates a Tiled-compatible greybox office map + placeholder tileset.
Run:  python3 tools/make_greybox.py
Out:  assets/office.json   assets/tileset-greybox.png
Open office.json in Tiled, swap the tileset for real art, decorate."""
import json, zlib, struct, os

W, H, TS = 64, 40, 16
OUT = os.path.join(os.path.dirname(__file__), "..", "assets")

# ---------- tile palette (gid = index+1) ----------
PALETTE = [
    (24, 26, 32),    # 1  void
    (206, 208, 214), # 2  lobby marble
    (104, 72, 46),   # 3  boss dark wood
    (108, 124, 148), # 4  senior carpet
    (196, 190, 178), # 5  open office carpet
    (120, 118, 132), # 6  review carpet
    (176, 142, 112), # 7  lounge warm
    (86, 84, 104),   # 8  meeting carpet
    (150, 152, 156), # 9  corridor concrete
    (222, 214, 190), # 10 cafeteria tile
    (96, 148, 100),  # 11 table tennis sport floor
    (52, 56, 66),    # 12 wall
    (150, 200, 226), # 13 glass
    (232, 96, 160),  # 14 prop placeholder
    (250, 210, 90),  # 15 door threshold (visual aid only)
    (40, 42, 50),    # 16 spare
]
VOID,LOBBY,BOSS,SENIOR,OPEN,REVIEW,LOUNGE,MEET,CORR,CAFE,TT,WALL,GLASS,PROP,DOOR,_ = range(1,17)

# ---------- rooms: (name, x0,x1, y0,y1, floor) ----------
ROOMS = [
    ("lobby",     2,13,  2,38, LOBBY),
    ("senior1",  15,23,  2,12, SENIOR),
    ("senior2",  25,33,  2,12, SENIOR),
    ("senior3",  35,43,  2,12, SENIOR),
    ("boss",     45,61,  2,12, BOSS),
    ("corr_n",   15,61, 14,16, CORR),
    ("open",     15,34, 17,29, OPEN),
    ("review",   36,43, 17,22, REVIEW),
    ("lounge",   36,43, 24,29, LOUNGE),
    ("meeting",  45,61, 17,29, MEET),
    ("corr_s",   15,61, 30,31, CORR),
    ("cafeteria",15,37, 33,38, CAFE),
    ("tt",       39,61, 33,38, TT),
]
# ---------- wall runs: (x0,x1,y0,y1,tile) ----------
WALLS = [
    (0,63, 0, 1, WALL), (0,63,39,39, WALL),          # outer N/S
    (0, 1, 0,39, WALL), (62,63, 0,39, WALL),          # outer W/E
    (14,14, 2,38, WALL),                              # lobby divider
    (15,61,13,13, GLASS),                             # cabin fronts = glass
    (24,24, 2,13, WALL), (34,34, 2,13, WALL),         # cabin dividers
    (44,44, 2,13, WALL), (44,44,17,29, WALL),         # the executive-wing line
    (35,35,17,29, WALL),                              # open office / review
    (36,43,23,23, GLASS),                             # review / lounge half-wall
    (15,61,32,32, WALL),                              # south band front wall
    (38,38,33,38, WALL),                              # cafeteria / TT divider
    (15,61,17,17, WALL),                              # corridor / central band
]
# ---------- doors: (x0,x1,y0,y1) carved back to floor ----------
DOORS = [
    (14,14, 8, 9), (14,14,22,23), (14,14,35,36),      # lobby
    (18,19,13,13), (28,29,13,13), (38,39,13,13),      # senior cabins
    (51,52,13,13),                                    # boss cabin
    (35,35,20,21),                                    # open -> review
    (44,44,22,23),                                    # -> meeting room
    (20,21,32,32), (48,49,32,32),                     # cafeteria, tt
    (22,23,17,17), (30,31,17,17), (40,41,17,17), (52,53,17,17),
]
# ---------- zone rectangles (tile coords) ----------
ZONES = [
    ("cabin",         48, 5, 11, 6, {"index": 0}),
    ("cabin",         17, 5,  5, 5, {"index": 1}),
    ("cabin",         27, 5,  5, 5, {"index": 2}),
    ("cabin",         37, 5,  5, 5, {"index": 3}),
    ("working",       17,19,  6, 2, {"order": 0}),
    ("working",       27,19,  6, 2, {"order": 1}),
    ("working",       17,26,  6, 2, {"order": 2}),
    ("working",       27,26,  6, 2, {"order": 3}),
    ("reviewing",     37,19,  6, 3, {}),
    ("blocked",       37,25,  6, 4, {}),
    ("collaborating", 47,20, 13, 7, {}),
    ("idle",          17,34, 19, 4, {}),
    ("done",          41,35, 19, 3, {}),
]
SPAWN = (8, 27)

# ---------- build layers ----------
floor = [VOID]*(W*H)
walls = [0]*(W*H)
props = [0]*(W*H)
def fill(buf, x0,x1,y0,y1, t):
    for y in range(y0, y1+1):
        for x in range(x0, x1+1):
            if 0 <= x < W and 0 <= y < H: buf[y*W+x] = t

for _n,x0,x1,y0,y1,t in ROOMS: fill(floor, x0,x1,y0,y1, t)
for x0,x1,y0,y1,t in WALLS:    fill(walls, x0,x1,y0,y1, t)
for x0,x1,y0,y1 in DOORS:
    fill(walls, x0,x1,y0,y1, 0)
    for y in range(y0,y1+1):
        for x in range(x0,x1+1):
            if floor[y*W+x] == VOID: floor[y*W+x] = CORR

# ---------- tileset png (pure stdlib) ----------
COLS = 8
rows_of_tiles = (len(PALETTE)+COLS-1)//COLS
tw, th = COLS*TS, rows_of_tiles*TS
rows = []
for py in range(th):
    row = bytearray()
    for px in range(tw):
        idx = (py//TS)*COLS + (px//TS)
        r,g,b = PALETTE[idx] if idx < len(PALETTE) else (0,0,0)
        # 1px darker border so tile edges are visible in Tiled
        if px % TS in (0, TS-1) or py % TS in (0, TS-1):
            r,g,b = int(r*.72), int(g*.72), int(b*.72)
        row += bytes((r,g,b))
    rows.append(bytes(row))

def write_png(path, w, h, rows):
    raw = b"".join(b"\x00"+r for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t+d) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

os.makedirs(OUT, exist_ok=True)
write_png(os.path.join(OUT, "tileset-greybox.png"), tw, th, rows)

# ---------- real tilesets registered alongside the greybox ----------
# so Tiled opens with everything already loaded and you can paint immediately.
REAL_TILESETS = [
    # (name, file, cols, rows)  -- all 16x16
    ("RoomBuilder",    "tilesets/Room_Builder_free_16x16.png", 17, 23),
    ("Interiors",      "tilesets/Interiors_free_16x16.png",    16, 89),
    ("DeskEssentials", "tilesets/DeskEssentials_16x16.png",    18,  4),
]

def build_tilesets(tw, th):
    out = [{
        "firstgid": 1, "name": "greybox", "image": "tileset-greybox.png",
        "imagewidth": tw, "imageheight": th, "tilewidth": TS, "tileheight": TS,
        "margin": 0, "spacing": 0, "columns": COLS, "tilecount": COLS*rows_of_tiles,
    }]
    gid = 1 + COLS*rows_of_tiles
    for name, img, c, r in REAL_TILESETS:
        out.append({
            "firstgid": gid, "name": name, "image": img,
            "imagewidth": c*TS, "imageheight": r*TS,
            "tilewidth": TS, "tileheight": TS,
            "margin": 0, "spacing": 0, "columns": c, "tilecount": c*r,
        })
        gid += c*r
    return out

# ---------- tiled json ----------
def tilelayer(name, data, _id):
    return {"id": _id, "name": name, "type": "tilelayer", "visible": True, "opacity": 1,
            "x": 0, "y": 0, "width": W, "height": H, "data": data}

objs, oid = [], 1
for name,x,y,w,h,props_ in ZONES:
    o = {"id": oid, "name": name, "type": "", "visible": True, "rotation": 0,
         "x": x*TS, "y": y*TS, "width": w*TS, "height": h*TS}
    if props_:
        o["properties"] = [{"name": k, "type": "int", "value": v} for k, v in props_.items()]
    objs.append(o); oid += 1

markers = [{"id": oid, "name": "spawn", "type": "", "point": True, "visible": True,
            "rotation": 0, "x": SPAWN[0]*TS, "y": SPAWN[1]*TS, "width": 0, "height": 0}]

tmj = {
    "compressionlevel": -1, "infinite": False, "orientation": "orthogonal",
    "renderorder": "right-down", "tiledversion": "1.11.0", "type": "map", "version": "1.10",
    "width": W, "height": H, "tilewidth": TS, "tileheight": TS, "nextlayerid": 6, "nextobjectid": oid+1,
    "layers": [
        tilelayer("floor", floor, 1),
        tilelayer("walls", walls, 2),
        tilelayer("props", props, 3),
        {"id": 4, "name": "zones", "type": "objectgroup", "visible": True, "opacity": 1,
         "draworder": "topdown", "x": 0, "y": 0, "objects": objs},
        {"id": 5, "name": "markers", "type": "objectgroup", "visible": True, "opacity": 1,
         "draworder": "topdown", "x": 0, "y": 0, "objects": markers},
    ],
    "tilesets": build_tilesets(tw, th),
}
with open(os.path.join(OUT, "office.json"), "w") as f:
    json.dump(tmj, f, indent=1)

# ---------- report ----------
holes = sum(1 for i,v in enumerate(floor) if v == VOID and walls[i] == 0)
print(f"✓ assets/office.json        {W}x{H}, {len(objs)} zone rects, spawn at {SPAWN}")
print(f"✓ assets/tileset-greybox.png {tw}x{th}, {len(PALETTE)} tiles")
print(f"  unreachable/void floor tiles (walls excluded): {holes}")
names = {}
for o in objs: names[o["name"]] = names.get(o["name"], 0) + 1
print("  zones:", ", ".join(f"{k}×{v}" for k, v in sorted(names.items())))
print("  tilesets registered:")
for t in tmj["tilesets"]:
    print(f"    gid {t['firstgid']:>5}-{t['firstgid']+t['tilecount']-1:<5} {t['name']:<16} {t['tilecount']:>5} tiles  {t['image']}")
