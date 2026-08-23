#!/usr/bin/env python3
"""Office map — 32x32 tiles, LimeZu Modern Interiors / Modern Office set.
Structure only (floors, walls, glass, doors); furniture is added in a later pass.
Run: python3 tools/build_office.py   →  assets/office.json + assets/preview.png
"""
import json, os, random
from PIL import Image

TS, W, H = 32, 64, 40                       # 2048 x 1280 px
A   = os.path.join(os.path.dirname(__file__), "..", "assets")
rng = random.Random(11)

SETS = [                                    # name, path, cols, rows
    ("RoomBuilderOffice", "archive/Room_Builder_Office.png",        16, 14),
    ("RoomBuilderFloors", "archive/Room_Builder_Floors.png",        15, 40),
    ("RoomBuilderWalls",  "archive/Room_Builder_Walls.png",         32, 40),
    ("ModernOffice",      "tilesets/Modern_Office_Black_Shadow.png",16, 53),
    ("Generic",           "tilesets/Generic.png",                   16, 78),
    ("FloorAndGround",    "tilesets/agentroom/FloorAndGround.png",  64, 40),
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
FLIP_H, FLIP_D = 0x80000000, 0x20000000
def rot90(x): return x | FLIP_D | FLIP_H

# ── floors: Room_Builder_Floors is 4 column groups (0-2, 4-6, 8-10, 12-14),
#    each a stack of styles in row PAIRS. cols within a group are variants.
def flr(col, row): return [RBF(col, row), RBF(col+1, row), RBF(col+2, row),
                           RBF(col, row+1), RBF(col+1, row+1)]
# One floor throughout — FloorAndGround, column group 2 (cols 5-7), last style.
F_MAIN = [FG(5,36), FG(6,36), FG(7,36), FG(5,37), FG(6,37), FG(7,37)]
F_LOBBY = F_CABIN = F_BOSS = F_MEET = F_CORR = F_OPEN = F_CAFE = F_CHILL = F_MAIN

# ── walls: Room_Builder_Walls has 3 column GROUPS of 10, each a stack of styles
#    in row pairs.  Group 1 = cols 0-9, group 2 = 11-20, group 3 = 22-31.
#    Inside a group: 2-tall middle is the 2nd column, 1-tall middle the 6th.
#    The columns either side of those are END CAPS — never use them mid-run.
G1, G2, G3 = 0, 11, 22
def w2(g, row): return [RBW(g+1, row)], [RBW(g+1, row+1)]   # 2-tall: top, bottom
def w1(g, row): return [RBW(g+5, row)]                      # 1-tall middle
WHITEW, GLASSROW, DOORROW = 2, 8, 22
W2_TOP, W2_BOT = w2(G1, WHITEW)                # capped — outer shell
WI_TOP         = w1(G1, WHITEW)                # capless face — interior
WI_BOT         = W2_BOT                          # base row with skirting
WG_TOP         = w1(G3, GLASSROW)                # cabin fronts — pale blue glass
WG_BOT         = w2(G3, GLASSROW)[1]
W1             = w1(G1, WHITEW)                # vertical runs, rotated
WDOOR          = w1(G2, DOORROW)                 # warm wood door leaf

ROOMS = {                          # x0 x1  y0 y1  floor
    "lobby":     (2,13,  3,38, F_LOBBY),
    "senior1":  (15,23,  3,12, F_CABIN),
    "senior2":  (25,33,  3,12, F_CABIN),
    "senior3":  (35,43,  3,12, F_CABIN),
    "boss":     (45,61,  3,12, F_BOSS),
    "corr_n":   (15,61, 15,16, F_CORR),
    "open":     (15,34, 19,29, F_OPEN),
    "atrium":   (36,43, 15,31, F_CORR),
    "meeting":  (45,61, 19,29, F_MEET),
    "cafeteria":(15,37, 32,38, F_CAFE),
    "chill":    (39,61, 32,38, F_CHILL),
}
HSHELL = [(1,62,1)]
HWALL  = [(15,34,17),(45,61,17),(15,34,30),(45,61,30)]
HGLASS = [(15,61,13)]
HTHIN  = [(1,62,39)]
VWALL  = [(1,1,39),(62,1,39),(14,3,38),(24,3,14),(34,3,14),(44,3,14),
          (35,17,31),(44,17,31),(38,32,38)]
DOORS_H = [(18,19,13),(28,29,13),(38,39,13),(51,52,13),
           (22,23,17),(52,53,17),(22,23,30),(52,53,30)]
DOORS_V = [(14,8,9),(14,22,23),(14,35,36),(35,22,23),(44,22,23),(38,34,35)]
ZONES = [
    ("cabin",         48, 6,11,5,{"index":0}), ("cabin",  17,6,5,5,{"index":1}),
    ("cabin",         27, 6, 5,5,{"index":2}), ("cabin",  37,6,5,5,{"index":3}),
    ("working",       17,21, 6,2,{"order":0}), ("working",27,21,6,2,{"order":1}),
    ("working",       17,26, 6,2,{"order":2}), ("working",27,26,6,2,{"order":3}),
    ("blocked",       37,18, 6,4,{}),          ("reviewing",   37,25, 6,4,{}),
    ("collaborating", 47,21,13,7,{}),          ("idle",        17,34,19,4,{}),
    ("done",          41,34,19,4,{}),
]
SPAWN = (8, 27)

floor=[0]*(W*H); deco=[0]*(W*H); walls=[0]*(W*H); props=[0]*(W*H); props2=[0]*(W*H)
def pick(t): return t[0] if rng.random()<.72 else rng.choice(t)
def put(b,x,y,v):
    if 0<=x<W and 0<=y<H: b[y*W+x]=v

for _n,(x0,x1,y0,y1,t) in ROOMS.items():
    for y in range(y0,y1+1):
        for x in range(x0,x1+1): put(floor,x,y,pick(t))
def hw(x0,x1,y,top,bot):
    for x in range(x0,x1+1): put(walls,x,y,pick(top)); put(walls,x,y+1,pick(bot))
for x0,x1,y in HSHELL: hw(x0,x1,y, W2_TOP, W2_BOT)
for x0,x1,y in HWALL:  hw(x0,x1,y, WI_TOP, WI_BOT)
for x0,x1,y in HGLASS: hw(x0,x1,y, WG_TOP, WG_BOT)
for x0,x1,y in HTHIN:
    for x in range(x0,x1+1): put(walls,x,y,pick(W1))
for x,y0,y1 in VWALL:
    for y in range(y0,y1+1): put(walls,x,y,rot90(pick(W1)))
for x0,x1,y in DOORS_H:
    for x in range(x0,x1+1):
        put(walls,x,y,0); put(walls,x,y+1,0)
        for yy in (y,y+1):
            if floor[yy*W+x]==0: put(floor,x,yy,pick(F_CORR))
        put(deco,x,y,pick(WDOOR))
for x,y0,y1 in DOORS_V:
    for y in range(y0,y1+1):
        put(walls,x,y,0)
        if floor[y*W+x]==0: put(floor,x,y,pick(F_CORR))
        put(deco,x,y,rot90(pick(WDOOR)))

# ══════════════════ FURNITURE (Modern_Office_Black_Shadow) ══════════════════
P = dict(
    # desks / tables — 3 wide x 2 tall, legs baked into the lower row
    DESK_TAN  =( 6, 1,3,2), DESK_CHK =( 1, 1,3,2), DESK_DARK=(11, 1,3,2),
    DESK_WOOD =( 1, 5,3,2), DESK_WHT =( 6, 5,3,2),
    # desktop clutter — monitors, keyboards, lamps, papers, photos
    DT_A=( 8,26,2,2), DT_B=(10,26,3,2), DT_C=(13,28,3,2),
    DT_D=(10,30,3,2), DT_E=(10,32,3,2), DT_F=(14,26,2,2),
    # swivel chairs seen from behind — the reference set
    CH_D=( 0, 8,1,2), CH_D2=( 1, 8,1,2), CH_D3=( 2, 8,1,2), CH_D4=( 3, 8,1,2),
    CH_O=( 0,10,1,2), CH_O2=( 1,10,1,2), CH_O3=( 2,10,1,2), CH_O4=( 3,10,1,2),
    # overhead hutch / shelving above a desk
    HUTCH=( 7,12,3,2), HUTCH_P=( 7,15,3,2),
    LAMP =(11,15,1,2),
    # wall-mounted
    WHITEBOARD=(15,0,1,2), CORKBOARD=(15,2,1,2),
    SCREEN=(10,12,3,2), SHELF=( 7,12,3,2), POSTER=( 0,12,2,2),
    # freestanding
    PLANT=( 6, 8,1,2), PLANT_TALL=( 6,12,1,2),
    SOFA=( 0,17,3,4), LOWTABLE=( 5,18,3,3),
    PRINTER=( 9,23,2,2), RACK=( 0,23,2,3), LOCKERS=( 2,23,2,3),
    CABINET=(13,19,2,4), COUNTER=( 5,28,4,2), COOLER=(13,34,1,2),
    GLASSDIV=( 0,26,8,3),
)
def furn(layer,key,x,y):
    c,r,w,h = P[key]
    for dy in range(h):
        for dx in range(w): put(layer,x+dx,y+dy, MO(c+dx,r+dy))

def station(x,y,desk,top,chair="CH_D",hutch=None):
    """optional overhead hutch, then desk, clutter on the surface, chair below.
       hutch 2 rows + desk 2 rows + chair 2 rows = 6 rows tall."""
    dy = 0
    if hutch:
        furn(props, hutch, x, y); dy = 2
    furn(props,  desk, x, y+dy)
    furn(props2, top,  x, y+dy)
    furn(props2, chair, x+1, y+dy+2)

# ── open office (15-34, 19-29): two rows of four workstations ──
tops   = ["DT_B","DT_D","DT_C","DT_E"]
chairsD = ["CH_D","CH_D2","CH_D3","CH_D4"]
chairsO = ["CH_O","CH_O2","CH_O3","CH_O4"]
for i,xx in enumerate((16,20,24,28)):          # front row — full cubicles
    station(xx,19,"DESK_TAN",tops[i],chairsD[i],"HUTCH" if i%2==0 else "HUTCH_P")
for i,xx in enumerate((16,20,24,28)):          # back row — open desks
    station(xx,26,"DESK_WHT",tops[(i+2)%4],chairsO[i])
for x,dec in ((17,"WHITEBOARD"),(21,"SCREEN"),(26,"CORKBOARD"),(30,"SHELF")):
    furn(props2,dec,x,18)
furn(props,"RACK",33,20); furn(props,"PRINTER",32,26)
furn(props,"PLANT_TALL",15,24); furn(props,"COOLER",33,24)

# ── boss cabin (45-61, 3-12) ──
station(51,4,"DESK_DARK","DT_C","CH_D4","HUTCH")
furn(props2,"SCREEN",56,2); furn(props2,"WHITEBOARD",47,2); furn(props2,"POSTER",49,2)
furn(props,"LAMP",55,6)
furn(props,"SOFA",46,7); furn(props,"LOWTABLE",50,9)
furn(props,"CABINET",59,4); furn(props,"PLANT_TALL",58,10); furn(props,"PLANT",45,5)
furn(props,"GLASSDIV",45,9)

# ── senior cabins ──
for i,x in enumerate((16,26,36)):
    station(x+2,4,("DESK_TAN","DESK_WOOD","DESK_CHK")[i],("DT_B","DT_D","DT_F")[i],
            ("CH_D","CH_D3","CH_D2")[i], "HUTCH")
    furn(props2,("WHITEBOARD","CORKBOARD","POSTER")[i], x+6, 2)
    furn(props2,("POSTER","WHITEBOARD","CORKBOARD")[i], x+1, 2)
    furn(props,("SHELF","CABINET","LOCKERS")[i], x, 3 if i==0 else 4)
    furn(props,"PLANT" if i%2 else "PLANT_TALL", x+7, 10)

# ── meeting room (45-61, 19-29) ──
for x in (47,50,53,56): furn(props,"DESK_DARK",x,22)
furn(props2,"DT_A",48,22); furn(props2,"DT_F",55,22)
for j,x in enumerate((47,50,53,56)):
    furn(props2,chairsD[j],x+1,20); furn(props2,chairsD[(j+1)%4],x+1,24)
furn(props2,"SCREEN",52,18); furn(props2,"WHITEBOARD",48,18); furn(props2,"CORKBOARD",57,18)
furn(props,"PLANT_TALL",45,21); furn(props,"PLANT_TALL",60,21)
furn(props,"COUNTER",56,27); furn(props,"COOLER",45,27)

# ── lobby (2-13, 3-38) ──
furn(props,"COUNTER",5,4); furn(props2,"DT_A",6,4); furn(props2,"CH_D3",7,6)
furn(props2,"POSTER",3,2); furn(props2,"WHITEBOARD",9,2)
furn(props,"SOFA",4,10); furn(props,"LOWTABLE",8,11)
furn(props,"PLANT_TALL",3,8); furn(props,"PLANT_TALL",12,8)
furn(props,"SOFA",4,19); furn(props,"LOWTABLE",8,20)
furn(props2,"POSTER",2,16); furn(props2,"CORKBOARD",12,16)
furn(props,"PLANT",3,29); furn(props,"PLANT_TALL",12,29)
furn(props,"CABINET",10,32); furn(props,"COOLER",3,32)

# ── cafeteria (15-37, 32-38) ──
furn(props,"COUNTER",16,33); furn(props,"COUNTER",21,33); furn(props,"CABINET",26,33)
for x in (17,24,31):
    furn(props,"DESK_WOOD",x,36); furn(props2,"CH_D2",x+1,34)
furn(props,"PLANT_TALL",35,34)
furn(props2,"CORKBOARD",20,31); furn(props2,"POSTER",27,31)

# ── chill room (39-61, 32-38) ──
furn(props,"SOFA",41,34); furn(props,"SOFA",57,34); furn(props,"LOWTABLE",45,35)
furn(props,"DESK_DARK",49,35); furn(props2,"DT_F",49,35)
furn(props2,"SCREEN",47,31); furn(props2,"POSTER",54,31)
furn(props,"PLANT_TALL",40,32); furn(props,"PLANT",60,33); furn(props,"COOLER",56,33)

# ── atrium edges only; middle stays walkable ──
for y in (18,22,26,30): furn(props,"PLANT",36,y); furn(props,"PLANT",43,y)


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
 "tilewidth":TS,"tileheight":TS,"nextlayerid":8,"nextobjectid":oid+1,
 "layers":[tl("floor",floor,1),tl("deco",deco,2),tl("walls",walls,3),tl("props",props,4),tl("props2",props2,7),
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
for L in (floor,deco,walls,props,props2):
    for i,gv in enumerate(L):
        if gv:
            t=timg(gv)
            if t: cv.alpha_composite(t,((i%W)*TS,(i//W)*TS))
cv.convert("RGB").save(os.path.join(A,"preview.png"))
holes=sum(1 for i,v in enumerate(floor) if v==0 and walls[i]==0 and 1<=i%W<=62 and 1<=i//W<=39)
print(f"✓ {W}x{H} @{TS}px = {W*TS}x{H*TS}px | rooms {len(ROOMS)} | zones {len(objs)} | holes {holes}")
for n,f,c,r in SETS: print(f"    gid {FIRST[n]:>5}  {n:<20} {c*r:>5} tiles  {f}")
