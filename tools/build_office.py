#!/usr/bin/env python3
"""Office map — 32x32 tiles, LimeZu Modern Interiors / Modern Office set.
Structure only (floors, walls, glass, doors); furniture is added in a later pass.
Run: python3 tools/build_office.py   →  assets/office.json + assets/preview.png
"""
import json, os, random
from PIL import Image

TS, W, H = 32, 64, 46                       # 2048 x 1280 px
A   = os.path.join(os.path.dirname(__file__), "..", "assets")
rng = random.Random(11)

SETS = [                                    # name, path, cols, rows
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
GT  = lambda c, r: gid("GatherFloors",      c, r)
VIC = lambda c, r: gid("VictorianWalls",    c, r)
MIN = lambda c, r: gid("Minimalist",        c, r)
FLIP_H, FLIP_D = 0x80000000, 0x20000000
def rot90(x): return x | FLIP_D | FLIP_H

# ── floors: Room_Builder_Floors is 4 column groups (0-2, 4-6, 8-10, 12-14),
#    each a stack of styles in row PAIRS. cols within a group are variants.
def flr(col, row): return [RBF(col, row), RBF(col+1, row), RBF(col+2, row),
                           RBF(col, row+1), RBF(col+1, row+1)]
# One floor throughout — FloorAndGround, column group 2 (cols 5-7), last style.
F_MAIN = [FG(37, 4)]   # flat light grey
F_LOBBY = F_CABIN = F_BOSS = F_MEET = F_CORR = F_OPEN = F_CAFE = F_CHILL = F_MAIN

# ── walls: Ultra-thin 1-Tile Minimalist Slate Walls & Connected 8px Vertical Dividers ──
W_PLAIN = [MIN(0, 0), MIN(1, 0)]                # 1-tile minimalist smooth slate wall
V_SLIM  = [MIN(1, 1)]                           # clean connected 8px vertical divider
V_SOLID = [MIN(3, 1)]                           # solid vertical wall (perimeter + lobby divider)

ROOMS = {                          # x0 x1  y0 y1  floor
    "lobby":     (2,13,  2,44, F_LOBBY),
    "senior1":  (15,23,  2,12, F_CABIN),
    "senior2":  (25,33,  2,12, F_CABIN),
    "senior3":  (35,43,  2,12, F_CABIN),
    "boss":     (45,61,  2,12, F_BOSS),
    "corr_n":   (15,61, 14,22, F_CORR),
    "open":     (15,35, 15,35, F_OPEN),      # open plan — no walls
    "atrium":   (36,44, 15,35, F_CORR),
    "meeting":  (46,61, 22,33, F_MEET),
    "cafeteria":(15,37, 35,44, F_CAFE),      # walled, 9 rows
    "chill":    (39,61, 35,44, F_CHILL),     # walled, 9 rows
}
HSHELL = [(1,62,1)]
HWALL  = [(45,61,21), (15,34,34), (45,61,34)]      # meeting top; cafeteria + chill top
HFRONT = [(15,61,13)]                              # cabin fronts
HTHIN  = [(1,62,45)]
VWALL_SOLID = [(1,1,45),(62,1,45),(14,1,45),(45,21,34),(38,34,45)]
VWALL_SLIM  = [(24,2,12),(34,2,12),(44,2,12)]     # cabin vertical dividers (between top and bottom walls)
# Horizontal doors (cabins + meeting + cafeteria + chill)
DOORS_H = [(18,19,13),(28,29,13),(38,39,13),(51,52,13),
           (52,53,21),(22,23,34),(52,53,34)]
# Vertical doors: ONLY corridor entry at (14,15,16) — middle and bottom entries removed!
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
def pick(t): return t[0] if rng.random()<.72 else rng.choice(t)
def put(b,x,y,v):
    if 0<=x<W and 0<=y<H: b[y*W+x]=v

# 1. Fill entire playable office with base floor first (prevents any black background voids)
for y in range(1, 46):
    for x in range(1, 63):
        put(floor, x, y, pick(F_MAIN))

# 2. Paint specific room floor zones
for _n,(x0,x1,y0,y1,t) in ROOMS.items():
    for y in range(y0,y1+1):
        for x in range(x0,x1+1): put(floor,x,y,pick(t))
def hw1(x0,x1,y,t):
    for x in range(x0,x1+1): put(walls,x,y,pick(t))

for x0,x1,y in HSHELL: hw1(x0,x1,y, W_PLAIN)
for x0,x1,y in HWALL:  hw1(x0,x1,y, W_PLAIN)
for x0,x1,y in HFRONT: hw1(x0,x1,y, W_PLAIN)
for x0,x1,y in HTHIN:  hw1(x0,x1,y, W_PLAIN)
for x,y0,y1 in VWALL_SOLID:
    for y in range(y0,y1+1): put(walls,x,y,pick(V_SOLID))
for x,y0,y1 in VWALL_SLIM:
    for y in range(y0,y1+1): put(walls,x,y,pick(V_SLIM))

# Place T-junction connection caps where vertical dividers meet horizontal wall at y=13:
for x in [24, 34, 44]:
    put(walls, x, 13, MIN(2, 1))

# Render horizontal doors with minimalist wooden doors:
for x0,x1,y in DOORS_H:
    for x in range(x0,x1+1):
        put(walls, x, y, 0)
        if floor[y*W+x]==0: put(floor,x,y,pick(F_CORR))
    put(props, x0, y, MIN(0, 2))
    put(props, x1, y, MIN(1, 2))

# Render vertical doors (clean open doorway walkthroughs):
for x,y0,y1 in DOORS_V:
    for y in range(y0,y1+1):
        put(walls,x,y,0)
        if floor[y*W+x]==0: put(floor,x,y,pick(F_CORR))

# ══════════════════ FURNITURE ══════════════════
# entries are (tileset, col, row, w, h)
P = dict(
    # ── desks / tables (Modern Office), 3 wide x 2 tall ──
    DESK_TAN =("MO", 6, 1,3,2), DESK_CHK=("MO", 1, 1,3,2), DESK_DARK=("MO",11, 1,3,2),
    DESK_WOOD=("MO", 1, 5,3,2), DESK_WHT=("MO", 6, 5,3,2),
    # ── desktop clutter ──
    DT_A=("MO", 8,26,2,2), DT_B=("MO",10,26,3,2), DT_C=("MO",13,28,3,2),
    DT_D=("MO",10,30,3,2), DT_E=("MO",10,32,3,2), DT_F=("MO",14,26,2,2),
    # ── swivel chairs, seen from behind ──
    CH_D =("MO", 0, 8,1,2), CH_D2=("MO", 1, 8,1,2), CH_D3=("MO", 2, 8,1,2), CH_D4=("MO", 3, 8,1,2),
    CH_O =("MO", 0,10,1,2), CH_O2=("MO", 1,10,1,2), CH_O3=("MO", 2,10,1,2), CH_O4=("MO", 3,10,1,2),
    # ── overhead hutch ──
    HUTCH=("MO", 7,12,3,2), HUTCH_P=("MO", 7,15,3,2), LAMP=("MO",11,15,1,2),
    # cubicle partition: 1-wide vertical post, 3 tall (from the partition run at rows 26-28)
    POST=("MO", 4,26,1,3), POST_L=("MO", 0,26,1,3), POST_R=("MO", 7,26,1,3),
    # ── wall-mounted ──
    WHITEBOARD=("MO",15,0,1,2), CORKBOARD=("MO",15,2,1,2),
    SCREEN=("MO",10,12,3,2), SCREEN2=("MO",10,14,3,2), POSTER=("MO",0,12,2,2),
    # ── office freestanding ──
    SOFA_L=("MO", 0,17,3,4), LOWTABLE=("MO", 5,18,3,3),
    PRINTER=("MO", 9,22,1,2), PRINTER2=("MO",10,22,1,2), RACK=("MO", 0,23,2,3), LOCKERS=("MO", 2,23,2,3),
    CABINET=("MO",13,19,1,3), CABINET2=("MO",15,19,1,3), CABINET3=("MO",13,22,1,3), COUNTER=("MO", 5,28,4,2), COOLER=("MO",13,34,1,2),
    GLASSDIV=("MO", 0,26,8,3), SHELF=("MO", 7,12,3,2),
    # ── lounge (Generic) ──
    SOFA_RED=("GEN", 6,11,3,2), ARMCHAIR=("GEN", 0,11,1,2), STOOL=("GEN", 0,17,1,2),
    TABLE_BRN3=("GEN", 1, 5,3,3), TABLE_TAN3=("GEN", 1, 8,3,3),
    DCHAIR =("GEN", 0,11,1,2), DCHAIR2=("GEN", 1,11,1,2),
    DCHAIR3=("GEN", 4,11,1,2), DCHAIR4=("GEN", 5,11,1,2),
    TABLE_G =("GEN", 1, 5,3,3), TV=("GEN", 3, 4,2,1),
    PALM=("GEN",13,25,2,4), TREE=("GEN",13,28,1,3), TREE2=("GEN",14,28,1,3),
    # ── rugs (go on the deco layer, under furniture) ──
    RUG_RED =("GEN", 9, 4,4,4), RUG_BLUE=("GEN", 9, 7,4,4),
    RUG_GREY=("GEN", 8,13,4,2), RUG_PURP=("GEN",12,21,4,4),
    RUG_ORG =("GEN", 9,10,3,2), RUG_GRN =("GEN",12,10,2,2),
)
SRC={"MO":MO,"GEN":GEN}
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
            # never paint furniture into a wall or outside a room
            if not onwall and (walls[Y*W+X] or floor[Y*W+X]==0):
                CLASH.append(("WALL/VOID",key,X,Y)); continue
            put(layer,X,Y, f(c+dx,r+dy))

# wall-mounted decor removed — posters/screens overhung the wall into the rooms
def wall_dec(key,x,y): pass

# ── area carpets: a filled rectangle, not an ornate rug sprite ──
CARPET_SAGE  = [FG(59,20)]   # flat sage      (156,169,158)
CARPET_LAV   = [FG(59, 8)]   # flat light blue(134,184,223)
CARPET_DIA   = [FG(59,10)]   # flat teal      (137,188,198)
CARPET_PURP  = [FG(37, 8)]   # flat warm grey (212,210,198)
CARPET_TAN   = [FG(37,24)]   # flat tan       (192,164,140)
CARPET_PLUM  = [FG(48,36)]   # flat plum      (131,112,180)
CARPET_BLUE  = CARPET_SAGE
CARPET_TEAL  = CARPET_DIA
CARPET_CHECK = CARPET_TAN
CARPET_CAFE  = CARPET_TAN
CARPET_WOOD  = CARPET_DIA
def carpet(x0,y0,w,h,tiles):
    for y in range(y0,y0+h):
        for x in range(x0,x0+w):
            if 0<=x<W and 0<=y<H and floor[y*W+x] and not walls[y*W+x]:
                deco[y*W+x]=pick(tiles)

def station(x,y,desk,top,chair="CH_D",hutch=None):
    """hutch (2) + desk (2) + clutter + chair (2) — 6 rows tall, chair centred under the desk."""
    dy=0
    if hutch: furn(props,hutch,x,y); dy=2
    furn(props,  desk, x, y+dy)
    furn(props2, top,  x, y+dy)
    # chair overlaps the desk's lower (leg) row so it reads as pulled up, not parked
    furn(props3, chair, x+1, y+dy+1)

def table_set(x,y,table="DESK_WOOD",above="CH_D2",below="CH_D"):
    """table with a chair hard against each side — no floating gaps."""
    furn(props3, above, x+1, y-2)      # far side: behind the table, no overlap
    furn(props,  table, x,   y)
    furn(props3, below, x+1, y+1)      # near side: tucked in

def cubicle_row(xs, y, desk, tops, chairs, hutch=None):
    """a run of plain workstations — desk, monitor, chair. No partitions, no hutch."""
    for i,x in enumerate(xs):
        station(x, y, desk, tops[i], chairs[i], hutch)

chairsD=["CH_D","CH_D2","CH_D3","CH_D4"]; chairsO=["CH_O","CH_O2","CH_O3","CH_O4"]
tops=["DT_B","DT_D","DT_C","DT_E"]

# ── OPEN OFFICE (15-34, 19-29) ──
cubicle_row((16,20,24,28), 20, "DESK_TAN", tops, chairsD)
cubicle_row((16,20,24,28), 26, "DESK_WHT", [tops[(i+2)%4] for i in range(4)], chairsO)
carpet(15,18,20,15,CARPET_SAGE)
# east wall: vending, snacks, printer, cooler in one tidy run
furn(props,"RACK",   33,19); furn(props,"LOCKERS",33,23)
furn(props,"PRINTER",33,27); furn(props,"COOLER", 34,27)

# ── BOSS CABIN (45-61, 3-12) ──
carpet(52,4,9,7,CARPET_DIA)
cubicle_row((48,), 5, "DESK_DARK", ["DT_C"], ["CH_D4"])
furn(props,"SOFA_L",53,5); furn(props,"LOWTABLE",57,6)
furn(props,"CABINET",59,9); furn(props,"CABINET2",60,9)
furn(props,"LAMP",51,10)

# ── SENIOR CABINS ──
for i,x in enumerate((16,26,36)):
    cubicle_row((x+2,), 5, ("DESK_TAN","DESK_WOOD","DESK_CHK")[i],
                [("DT_B","DT_D","DT_F")[i]], [("CH_D","CH_D3","CH_D2")[i]])
    carpet(x+4,8,5,4,CARPET_PURP)
    furn(props,("ARMCHAIR","STOOL","ARMCHAIR")[i], x+5, 9)
    furn(props,("LOCKERS","CABINET","RACK")[i], x, 8)
    furn(props,"CABINET2" if i==1 else "CABINET3", x+2 if i==1 else x+2, 8)

# ── MEETING ROOM (45-61, 19-29) ──
carpet(46,23,15,11,CARPET_LAV)
for x in (47,50,53,56): furn(props,"DESK_DARK",x,27)
for j,x in enumerate((47,50,53,56)):
    furn(props3,chairsD[j],      x+1,25)
    furn(props3,chairsD[(j+1)%4],x+1,29)
furn(props2,"DT_A",48,27); furn(props2,"DT_F",55,27)
furn(props,"COUNTER",56,32); furn(props,"COOLER",47,32)

# ── LOBBY (2-13, 3-38) ──
carpet(2,8,12,7,CARPET_DIA)
carpet(2,17,12,8,CARPET_PURP)
carpet(2,33,12,10,CARPET_DIA)

# ── CAFETERIA (15-37, 32-38) ── chairs hard against each table
carpet(15,36,23,9,CARPET_TAN)

# ── CHILL ROOM (39-61, 32-38) ──
carpet(39,36,10,9,CARPET_PLUM)
carpet(49,36,13,9,CARPET_PLUM)

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
print(f"✓ {W}x{H} @{TS}px = {W*TS}x{H*TS}px | rooms {len(ROOMS)} | zones {len(objs)} | holes {holes}")
for n,f,c,r in SETS: print(f"    gid {FIRST[n]:>5}  {n:<20} {c*r:>5} tiles  {f}")
