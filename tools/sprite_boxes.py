#!/usr/bin/env python3
"""Finds real sprite bounding boxes in a tileset by connected-component analysis
on tile occupancy. Beats eyeballing a zoomed screenshot."""
import sys
from PIL import Image
src = sys.argv[1]; TS = int(sys.argv[2]) if len(sys.argv)>2 else 32
im = Image.open(src).convert("RGBA")
C,R = im.width//TS, im.height//TS
px = im.load()
occ = [[False]*C for _ in range(R)]
for r in range(R):
    for c in range(C):
        hit=False
        for y in range(r*TS, r*TS+TS, 2):
            for x in range(c*TS, c*TS+TS, 2):
                p=px[x,y]
                if p[3] > 220 and not (p[0]<40 and p[1]<40 and p[2]<40): hit=True; break
            if hit: break
        occ[r][c]=hit
seen=[[False]*C for _ in range(R)]
boxes=[]
for r in range(R):
    for c in range(C):
        if not occ[r][c] or seen[r][c]: continue
        stack=[(r,c)]; seen[r][c]=True; cells=[]
        while stack:
            y,x=stack.pop(); cells.append((y,x))
            for dy,dx in ((1,0),(-1,0),(0,1),(0,-1)):
                ny,nx=y+dy,x+dx
                if 0<=ny<R and 0<=nx<C and occ[ny][nx] and not seen[ny][nx]:
                    seen[ny][nx]=True; stack.append((ny,nx))
        ys=[y for y,_ in cells]; xs=[x for _,x in cells]
        boxes.append((min(xs),min(ys),max(xs)-min(xs)+1,max(ys)-min(ys)+1,len(cells)))
boxes.sort(key=lambda b:(b[1],b[0]))
print(f"{src}  {C}x{R} tiles @{TS}px   {len(boxes)} sprites")
want = sys.argv[3] if len(sys.argv)>3 else None
for x,y,w,h,n in boxes:
    if want and f"{w}x{h}" != want: continue
    print(f"  col {x:>2} row {y:>3}   {w}x{h}   ({n} tiles)")
