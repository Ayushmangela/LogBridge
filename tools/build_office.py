#!/usr/bin/env python3
"""Build office map matching the exact LimeZu Modern Interiors demo office aesthetic:
- Clean white modern walls for main spaces + warm brick accent walls for executive cabins.
- Square light-grey grid floor tile (RBO tile 111) for open office & corridors + wood parquet for cabins.
- Cubicle workstations with partition frames, dual blue monitors, lamps, laptops, papers.
- Wall-mounted AC units, red-line trend analytics chart, project planning whiteboard, bookshelf with plants, water coolers.
- Executive cabins with brick walls, orange leather swivel chairs, black leather sofa, money pile on floor, snake plants, luggage.
"""
import json, os, random
from PIL import Image

TS, W, H = 32, 64, 46
A = os.path.join(os.path.dirname(__file__), "..", "assets")
rng = random.Random(42)

SETS = [
    ("RoomBuilderOffice", "archive/Room_Builder_Office.png",        16, 14),
    ("RoomBuilderFloors", "archive/Room_Builder_Floors.png",        15, 40),
    ("RoomBuilderWalls",  "archive/Room_Builder_Walls.png",         32, 40),
    ("ModernOffice",      "tilesets/Modern_Office_Black_Shadow.png",16, 53),
    ("Generic",           "tilesets/Generic.png",                   16, 78),
    ("FloorAndGround",    "tilesets/agentroom/FloorAndGround.png",  64, 40),
    ("GatherFloors",      "gather-town/map/floorstilemap.png",      40, 64),
    ("VictorianWalls",    "gather-town/map/VictorianWallConsolidationGreytop.png", 33, 19),
    ("Minimalist",        "tilesets/minimalist_tileset.png",         4,  4),
]

FIRST, g = {}, 1
for n, f, c, r in SETS: FIRST[n] = g; g += c * r
NC = {n: c for n, f, c, r in SETS}
def gid(s, c, r): return FIRST[s] + r * NC[s] + c

RBO = lambda c, r: gid("RoomBuilderOffice", c, r)
RBF = lambda c, r: gid("RoomBuilderFloors", c, r)
RBW = lambda c, r: gid("RoomBuilderWalls",  c, r)
MO  = lambda c, r: gid("ModernOffice",      c, r)
GEN = lambda c, r: gid("Generic",           c, r)
FG  = lambda c, r: gid("FloorAndGround",    c, r)
MIN = lambda c, r: gid("Minimalist",        c, r)

FLIP_H, FLIP_D = 0x80000000, 0x20000000
def rot90(x): return x | FLIP_D | FLIP_H

# ── Floor Tiles ("title" / tile from screenshot) ──
# Open Office & Corridors: Crisp square light-grey grid floor tile (RBO tile 111)
F_GRID  = [RBO(14, 6), RBO(14, 6), RBO(15, 6)]
F_CORR  = F_GRID
F_OPEN  = F_GRID
# Lobby: Polished luxury marble
F_LOBBY = [RBF(8, 32), RBF(9, 32), RBF(10, 32)]
# Senior Cabins: Scandinavian light oak parquet (from demo screenshot bottom)
F_CABIN = [RBF(0, 20), RBF(1, 20), RBF(2, 20)]
# Boss Suite: Rich natural wood parquet
F_BOSS  = [RBF(0, 22), RBF(1, 22), RBF(2, 22)]
# Meeting Room / Boardroom: Executive slate tile
F_MEET  = [RBF(4, 32), RBF(5, 32), RBF(6, 32)]
# Cafeteria: Warm clean cafe bistro tile
F_CAFE  = [RBF(4, 2), RBF(5, 2), RBF(6, 2)]
# Chill Room / Lounge: Plush calming mint lounge carpet
F_CHILL = [RBF(12, 32), RBF(13, 32), RBF(14, 32)]

F_MAIN = F_GRID

# ── Wall Architecture (From screenshot) ──
# Clean white modern wall with top molding & dark baseboard
W_WHITE = [RBW(5, 0)]                            # Crisp white wall with top molding & baseboard
W_BRICK = [GEN(11, 0), GEN(11, 1)]               # Exposed warm brick wall (for cabins)
V_WHITE = [rot90(RBW(5, 0))]
V_BRICK = [rot90(GEN(11, 0))]

W_PLAIN = W_WHITE
V_SLIM  = V_WHITE
V_SOLID = V_WHITE

ROOMS = {
    "lobby":     (2,13,  2,44, F_LOBBY),
    "senior1":  (15,23,  2,12, F_CABIN),
    "senior2":  (25,33,  2,12, F_CABIN),
    "senior3":  (35,43,  2,12, F_CABIN),
    "boss":     (45,61,  2,12, F_BOSS),
    "corr_n":   (15,61, 14,22, F_CORR),
    "open":     (15,35, 15,34, F_OPEN),
    "atrium":   (36,44, 15,34, F_CORR),
    "meeting":  (46,61, 22,33, F_MEET),
    "cafeteria":(15,37, 35,44, F_CAFE),
    "chill":    (39,61, 35,44, F_CHILL),
}

HSHELL = [(1,62,1)]
HWALL  = [(45,61,21), (15,34,34), (45,61,34)]
HFRONT = [(15,61,13)]                              # cabin fronts
HTHIN  = [(1,62,45)]
VWALL_SOLID = [(1,1,45),(62,1,45),(14,1,45),(45,21,34),(38,34,45)]
VWALL_SLIM  = [(24,2,12),(34,2,12),(44,2,12)]

DOORS_H = [(18,19,13),(28,29,13),(38,39,13),(51,52,13),
           (52,53,21),(22,23,34),(52,53,34)]
DOORS_V = [(14,15,16),(45,24,25),(38,38,39)]

ZONES = [
    ("cabin",         48, 6,11,5,{"index":0}), ("cabin",  17,6,5,5,{"index":1}),
    ("cabin",         27, 6, 5,5,{"index":2}), ("cabin",  37,6,5,5,{"index":3}),
    ("working",       17,21, 6,2,{"order":0}), ("working",27,21,6,2,{"order":1}),
    ("working",       17,27, 6,2,{"order":2}), ("working",27,27,6,2,{"order":3}),
    ("blocked",       37,18, 7,5,{}),          ("reviewing",   37,26, 7,5,{}),
    ("collaborating", 47,26,13,6,{}),          ("idle",        17,39,19,5,{}),
    ("done",          41,39,19,5,{}),
]
SPAWN = (8, 30)

floor=[0]*(W*H); deco=[0]*(W*H); walls=[0]*(W*H); props=[0]*(W*H); props2=[0]*(W*H); props3=[0]*(W*H)
def pick(t): return t[0] if rng.random()<.65 else rng.choice(t)
def put(b,x,y,v):
    if 0<=x<W and 0<=y<H: b[y*W+x]=v

# 1. Base floor everywhere in playable boundary
for y in range(1, 46):
    for x in range(1, 63):
        put(floor, x, y, pick(F_MAIN))

# 2. Paint individual room floors
for _n,(x0,x1,y0,y1,t) in ROOMS.items():
    for y in range(y0,y1+1):
        for x in range(x0,x1+1): put(floor,x,y,pick(t))

def hw1(x0,x1,y,t):
    for x in range(x0,x1+1): put(walls,x,y,pick(t))

for x0,x1,y in HSHELL: hw1(x0,x1,y, W_WHITE)
for x0,x1,y in HWALL:  hw1(x0,x1,y, W_WHITE)
for x0,x1,y in HFRONT: hw1(x0,x1,y, W_BRICK)  # Warm brick walls for cabin front & interiors!
for x0,x1,y in HTHIN:  hw1(x0,x1,y, W_WHITE)
for x,y0,y1 in VWALL_SOLID:
    for y in range(y0,y1+1): put(walls,x,y,pick(V_WHITE))
for x,y0,y1 in VWALL_SLIM:
    for y in range(y0,y1+1): put(walls,x,y,pick(V_BRICK)) # Brick dividers between cabins!

# Doors
for x0,x1,y in DOORS_H:
    for x in range(x0,x1+1):
        put(walls, x, y, 0)
        if floor[y*W+x]==0: put(floor,x,y,pick(F_CORR))
    # Elegant wooden door frames
    put(props, x0, y, RBW(15, 22))
    put(props, x1, y, RBW(16, 22))

for x,y0,y1 in DOORS_V:
    for y in range(y0,y1+1):
        put(walls,x,y,0)
        if floor[y*W+x]==0: put(floor,x,y,pick(F_CORR))

# ══════════════════ FURNITURE DICTIONARY (From Demo Screenshot) ══════════════════
P = dict(
    # Desks
    DESK_TAN =("MO", 6, 1,3,2), DESK_CHK =("MO", 1, 1,3,2), DESK_DARK=("MO",11, 1,3,2),
    DESK_WOOD=("MO", 1, 5,3,2), DESK_WHT =("MO", 6, 5,3,2),
    
    # Desktop tech & monitors (Exact items in screenshot)
    DT_A=("MO", 8,26,2,2), # Laptop + coffee mug
    DT_B=("MO",10,26,3,2), # Dual blue monitors
    DT_C=("MO",13,28,3,2), # Dual wide monitors + lamp
    DT_D=("MO",10,30,3,2), # Monitor + papers + lamp
    DT_E=("MO",10,32,3,2), # Laptop + monitor + documents
    DT_F=("MO",14,26,2,2), # Laptop workstation
    
    # Swivel Chairs (Exact items in screenshot)
    CH_D =("MO", 1, 8,1,2), CH_D2=("MO", 2, 8,1,2), CH_D3=("MO", 3, 8,1,2), # Black mesh ergonomic chairs
    CH_O =("MO", 1,10,1,2), CH_O2=("MO", 2,10,1,2), # Orange executive swivel chairs
    
    # Wall Features (Exact items in screenshot)
    AC          =("RBO",10, 2, 2, 1), # Wall-mounted Air Conditioner unit!
    CHART_RED   =("MO",  9,12, 3, 2), # Analytics whiteboard with red rising trend line!
    CHART_GRID  =("MO", 11,12, 3, 2), # Project planning whiteboard with grid!
    WHITEBOARD  =("MO", 15, 0, 1, 2), # Vertical whiteboard
    CORKBOARD   =("MO", 15, 2, 1, 2), # Cork bulletin board
    BOOKSHELF   =("MO",  7,12, 2, 2), # Bookshelf with books & potted plant!
    WATER_COOL  =("MO", 13,34, 1, 2), # Water cooler dispenser with cup stack!
    PRINTER_STAND=("MO", 9, 22, 2, 2), # Multifunction printer on side table!
    
    # Executive & Cabin decor (Exact items in screenshot)
    MONEY_PILE  =("GEN", 4, 14, 2, 2), # Playful green cash pile on floor!
    SOFA_BLK    =("MO",  0, 17, 3, 4), # Black leather sectional couch
    SOFA_RED    =("GEN", 6, 11, 3, 2), # Red lounge sofa
    ARMCHAIR    =("GEN", 0, 11, 1, 2), # Armchair
    LOWTABLE    =("MO",  5, 18, 3, 3), # Glass coffee table
    COFFEE_TABLE=("GEN", 1, 5, 3, 3), # Wood table
    PLANT_SNAKE =("MO",  6, 8, 1, 2), # Potted snake plant (sansevieria)
    PLANT_TALL  =("MO",  6, 12, 1, 3), # Tall office plant
    PALM        =("GEN",13, 25, 2, 4), # Large ficus/palm tree
    SUITCASE    =("GEN", 7, 63, 1, 2), # Luggage / suitcase against wall
    
    # Utilities & Storage
    RACK   =("MO", 0, 23, 2, 3), # Server rack
    LOCKERS=("MO", 2, 23, 2, 3), # Lockers
    CABINET=("MO",13, 19, 1, 3), # Tall cabinet
    CABINET2=("MO",15,19, 1, 3), # Bookshelf cabinet
    COUNTER=("MO", 5, 28, 4, 2), # Kitchen counter
    LAMP   =("MO",11, 15, 1, 2), # Floor lamp
    TABLE_CAFE=("GEN", 1, 5, 3, 3), # Cafe table
)

SRC={"MO":MO, "GEN":GEN, "RBO":RBO, "RBW":RBW}
CLASH=[]; OWNER={}
def furn(layer,key,x,y,onwall=False):
    src,c,r,w,h = P[key]; f=SRC[src]
    lid = id(layer)
    for dy in range(h):
        for dx in range(w):
            X,Y=x+dx,y+dy
            k=(lid,X,Y)
            if k in OWNER: CLASH.append((OWNER[k],key,X,Y))
            OWNER[k]=key
            if not onwall and (walls[Y*W+X] or floor[Y*W+X]==0):
                CLASH.append(("WALL/VOID",key,X,Y)); continue
            put(layer,X,Y, f(c+dx,r+dy))

def station(x,y,desk,top,chair="CH_D"):
    furn(props,  desk, x, y)
    furn(props2, top,  x, y)
    furn(props3, chair, x+1, y+1)

# ── 1. OPEN OFFICE (Top Room Style from Screenshot) ──
# North Wall Clutter (Air conditioner, Whiteboard with grid, Bookshelf with plant, Red-line analytics chart, Snake plant, Water cooler):
furn(props, "AC",         16, 14)
furn(props, "CHART_GRID", 19, 14)
furn(props, "BOOKSHELF",  23, 14)
furn(props, "CHART_RED",  26, 14)
furn(props, "PLANT_SNAKE",30, 14)
furn(props, "WATER_COOL", 33, 14)

# Workstation Row 1 (Light Tan Desks with dual blue monitors, lamps, black swivel chairs, and side printer table):
cubicle_xs = (16, 20, 24, 28)
for i, x in enumerate(cubicle_xs):
    station(x, 20, "DESK_TAN", ["DT_B","DT_D","DT_C","DT_E"][i], ["CH_D","CH_D2","CH_D3","CH_D"][i])
# Side table with printer (from screenshot):
furn(props, "PRINTER_STAND", 32, 20)

# Workstation Row 2 (Dark Charcoal Desks with widescreen monitors, orange screens, black swivel chairs):
for i, x in enumerate(cubicle_xs):
    station(x, 26, "DESK_DARK", ["DT_C","DT_E","DT_B","DT_D"][i], ["CH_D","CH_D2","CH_D3","CH_D"][i])
furn(props, "PLANT_TALL", 32, 26)

# East wall utilities:
furn(props, "RACK",    33, 28)
furn(props, "LOCKERS", 33, 31)

# ── 2. BOSS EXECUTIVE SUITE (Bottom-Left Room Style from Screenshot) ──
# Exposed brick wall, AC unit on wall, black leather sofa, money pile on floor, L-shaped executive desk with orange chair, water cooler, snake plants!
furn(props, "AC",         46, 2)
furn(props, "SUITCASE",   46, 3)
furn(props, "SOFA_BLK",   54, 4)
furn(props, "LOWTABLE",   57, 5)
# Executive workstation with orange leather chair:
station(48, 5, "DESK_DARK", "DT_C", "CH_O")
# Water cooler next to desk:
furn(props, "WATER_COOL", 52, 5)
# Playful green cash pile on floor in front of desk (from screenshot!):
furn(props, "MONEY_PILE", 49, 8)
# Storage credenza:
furn(props, "CABINET",    46, 9)
furn(props, "CABINET2",   47, 9)
# Snake plants in corners:
furn(props, "PLANT_SNAKE",60, 2)
furn(props, "PLANT_SNAKE",60, 11)

# ── 3. SENIOR CABINS (Bottom-Right Room Style from Screenshot) ──
# Exposed brick walls, corkboard, presentation board, orange & black swivel chairs, printer stand, snake plants, luggage:
for i, x0 in enumerate((15, 25, 35)):
    d = ("DESK_TAN", "DESK_WOOD", "DESK_WHT")[i]
    t = ("DT_B", "DT_D", "DT_A")[i]
    c = ("CH_O", "CH_O2", "CH_D")[i]
    station(x0+2, 5, d, t, c)
    furn(props, "AC", x0+1, 2)
    furn(props, "CORKBOARD", x0+6, 2)
    furn(props, "PLANT_SNAKE", x0+7, 9)
    furn(props, "SUITCASE", x0+1, 9)
    furn(props, "PRINTER_STAND", x0+5, 8)

# ── 4. BOARDROOM / MEETING ROOM (Executive Boardroom) ──
for x in (48, 51, 54, 57):
    furn(props, "DESK_DARK", x, 27)
for j, x in enumerate((48, 51, 54, 57)):
    furn(props3, "CH_D",  x+1, 25)
    furn(props3, "CH_D2", x+1, 29)
furn(props2, "DT_A", 49, 27)
furn(props2, "DT_F", 56, 27)
furn(props, "COUNTER", 56, 31)
furn(props, "WATER_COOL", 47, 31)
furn(props, "CHART_RED", 52, 22)
furn(props, "PALM", 60, 23)

# ── 5. ATRIUM & BREAKOUT HUB ──
furn(props, "SOFA_RED", 38, 20)
furn(props, "ARMCHAIR", 42, 20)
furn(props, "LOWTABLE", 39, 23)
furn(props, "PALM",     43, 16)
furn(props, "PALM",     43, 30)
furn(props, "WHITEBOARD", 37, 26)

# ── 6. CAFETERIA & PANTRY ──
furn(props, "COUNTER", 16, 36)
furn(props, "WATER_COOL", 21, 36)
furn(props, "LOCKERS", 23, 36)
furn(props,  "TABLE_CAFE", 27, 37)
furn(props3, "CH_O",       28, 36)
furn(props3, "CH_O2",      28, 40)
furn(props,  "TABLE_CAFE", 33, 37)
furn(props3, "CH_O",       34, 36)
furn(props3, "CH_O2",      34, 40)
furn(props, "PALM", 16, 40)

# ── 7. CHILL LOUNGE ──
furn(props, "SOFA_BLK",   42, 38)
furn(props, "LOWTABLE",   46, 39)
furn(props, "SOFA_RED",   50, 38)
furn(props, "ARMCHAIR",   54, 38)
furn(props, "PALM",       40, 36)
furn(props, "PALM",       60, 36)
furn(props, "WATER_COOL", 58, 41)

# ── 8. LOBBY & RECEPTION ──
station(6, 18, "DESK_WHT", "DT_A", "CH_D")
furn(props, "WHITEBOARD", 4, 21)
furn(props, "SOFA_RED",   4, 25)
furn(props, "LOWTABLE",   8, 25)
furn(props, "ARMCHAIR",   4, 28)
furn(props, "PALM",       4, 14)
furn(props, "PALM",       4, 32)
furn(props, "WATER_COOL", 10, 32)

def tl(n,d,i): return {"id":i,"name":n,"type":"tilelayer","visible":True,"opacity":1,
                       "x":0,"y":0,"width":W,"height":H,"data":d}
objs,oid=[],1
for n,x,y,w,h,pr in ZONES:
    o={"id":oid,"name":n,"type":"","visible":True,"rotation":0,
       "x":x*TS,"y":y*TS,"width":w*TS,"height":h*TS}
    if pr: o["properties"]=[{"name":k,"type":"int","value":v} for k,v in pr.items()]
    objs.append(o); oid+=1
mk=[{"id":oid,"name":"spawn","type":"","point":True,"visible":True,"rotation":0,
     "x":SPAWN[0]*TS,"y":SPAWN[1]*TS,"width":0,"height":0}]

tmj={"compressionlevel":-1,"infinite":False,"orientation":"orthogonal","renderorder":"right-down",
 "tiledversion":"1.11.0","type":"map","version":"1.10","width":W,"height":H,
 "tilewidth":TS,"tileheight":TS,"nextlayerid":9,"nextobjectid":oid+1,
 "layers":[tl("floor",floor,1),tl("deco",deco,2),tl("walls",walls,3),tl("props",props,4),tl("props2",props2,7),tl("props3",props3,8),
   {"id":5,"name":"zones","type":"objectgroup","visible":True,"opacity":1,
    "draworder":"topdown","x":0,"y":0,"objects":objs},
   {"id":6,"name":"markers","type":"objectgroup","visible":True,"opacity":1,
    "draworder":"topdown","x":0,"y":0,"objects":mk}],
 "tilesets":[{"firstgid":FIRST[n],"name":n,"image":f,"imagewidth":c*TS,"imageheight":r*TS,
   "tilewidth":TS,"tileheight":TS,"margin":0,"spacing":0,
   "columns":c,"tilecount":c*r} for n,f,c,r in SETS]}

# Save out to assets/office.json and preview.png
json.dump(tmj, open(os.path.join(A,"office.json"),"w"), indent=1)

imgs={n:Image.open(os.path.join(A,f)).convert("RGBA") for n,f,c,r in SETS}
def timg(gv):
    rot=gv & FLIP_D; gv &= 0x1FFFFFFF
    for n,f,c,r in SETS:
        if FIRST[n] <= gv < FIRST[n]+c*r:
            i=gv-FIRST[n]
            t=imgs[n].crop(((i%c)*TS,(i//c)*TS,(i%c)*TS+TS,(i//c)*TS+TS))
            return t.transpose(Image.ROTATE_270) if rot else t
cv=Image.new("RGBA",(W*TS,H*TS),(18,20,26,255))
for L in (floor,deco,walls,props,props2,props3):
    for i,gv in enumerate(L):
        if gv:
            t=timg(gv)
            if t: cv.alpha_composite(t,((i%W)*TS,(i//W)*TS))
cv.convert("RGB").save(os.path.join(A,"preview.png"))

if CLASH:
    seen=set(); print(f"⚠ {len(CLASH)} furniture clashes:")
    for a,b,x,y in CLASH:
        k=(a,b)
        if k in seen: continue
        seen.add(k); print(f"    {a:<12} vs {b:<12} at ({x},{y})")
holes=sum(1 for i,v in enumerate(floor) if v==0 and walls[i]==0 and 1<=i%W<=62 and 1<=i//W<=39)
print(f"✓ Exact Demo Style built: {W}x{H} @{TS}px = {W*TS}x{H*TS}px | rooms {len(ROOMS)} | zones {len(objs)} | holes {holes}")
