"""Segment cutter: cut grid-aligned segments (art in every variant + walls) out of a module's battle map.

Usage: python3 cut.py <spec.json> [--data <Foundry Data dir>] [--sheet <contact.jpg>] [--only id ...]

The spec names the module, which map files are its variants, the variant whose Scene-pack entry
holds the walls, and each segment's box in source squares. Writes per segment, under
<Data>/gm-tools-assets/segments/<module>/<segment-id>/:
  <variant>.webp      the box from each variant, rescaled to 100 px per square
  segment.json        size, variants, walls in segment-local px (schema 1; see map-segments/composition.mjs)
Re-cutting keeps hand-set `edges`, `shape`, `themes`, `tags`, `variantInfo` and measured `colours`
already in a segment.json. `--variants a b` cuts only those variants and adds them to the existing
segment.json, leaving every other variant's file untouched (use it to grow a piece that a live scene
already uses). Run tag.py afterwards to tag and measure the new variants.
"""
import argparse, json, math, os, sys, pathlib
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("spec"); ap.add_argument("--data", default=os.environ.get("WF_DATA_DIR", str(pathlib.Path.home() / "foundrydata" / "Data")))
ap.add_argument("--sheet"); ap.add_argument("--only", nargs="*", default=[])
ap.add_argument("--variants", nargs="*", default=[], help="cut only these variants and merge them into existing segments")
args = ap.parse_args()
spec = json.load(open(args.spec))
MODULE = spec["module"]
DATA = pathlib.Path(args.data)
OUT = DATA / "gm-tools-assets" / "segments" / MODULE
TARGET = 100
VARIANTS = spec["variants"]          # name -> map file, relative to the module folder
if args.variants:
    missing = [v for v in args.variants if v not in VARIANTS]
    if missing: sys.exit(f"--variants not in the spec: {', '.join(missing)}")
    VARIANTS = {v: VARIANTS[v] for v in args.variants}
WALLS_FROM = spec["wallsFrom"]       # substring of the Scene-pack entry's image that carries the walls
SEGMENTS = {k: tuple(v) for k, v in spec["segments"].items()}
ONLY = set(args.only)
docs = [json.loads(l) for l in (DATA / "modules" / MODULE / "Packs" / f"{spec.get('pack', 'maps')}.db").read_text().splitlines() if l.strip()]
def src(d): return d.get("img") or (d.get("background") or {}).get("src") or ""
scene = next(d for d in docs if WALLS_FROM in src(d))
G = scene["grid"]["size"] if isinstance(scene["grid"], dict) else scene["grid"]
pad = scene.get("padding", 0)
OX = math.ceil(scene["width"] * pad / G) * G
OY = math.ceil(scene["height"] * pad / G) * G
k = TARGET / G

def clip(x0, y0, x1, y1, bx0, by0, bx1, by1):
    """Liang-Barsky; returns clipped segment or None."""
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - bx0), (dx, bx1 - x0), (-dy, y0 - by0), (dy, by1 - y0)):
        if p == 0:
            if q < 0: return None
        else:
            r = q / p
            if p < 0: t0 = max(t0, r)
            else: t1 = min(t1, r)
            if t0 > t1: return None
    return (x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy), (t0 > 0 or t1 < 1)

images = {v: Image.open(DATA / "modules" / MODULE / f).convert("RGB") for v, f in VARIANTS.items()}
report, thumbs = [], []
for sid, (sx, sy, sw, sh) in SEGMENTS.items():
    if ONLY and sid not in ONLY: continue
    d = OUT / sid; d.mkdir(parents=True, exist_ok=True)
    box = (sx * G, sy * G, (sx + sw) * G, (sy + sh) * G)
    size = (sw * TARGET, sh * TARGET)
    for v, im in images.items():
        im.crop(box).resize(size, Image.LANCZOS).save(d / f"{v}.webp", quality=82)
    walls, cut_doors = [], 0
    for w in scene["walls"]:
        x0, y0, x1, y1 = w["c"]
        r = clip(x0 - OX, y0 - OY, x1 - OX, y1 - OY, *box)
        if not r: continue
        (a, b, c, e), was_cut = r
        seg = [round((a - box[0]) * k), round((b - box[1]) * k), round((c - box[0]) * k), round((e - box[1]) * k)]
        if math.hypot(seg[2] - seg[0], seg[3] - seg[1]) < 4: continue
        nw = {key: w[key] for key in ("light", "move", "sight", "sound", "dir", "door", "ds") if key in w}
        nw["c"] = seg
        if was_cut: nw["cut"] = True
        if was_cut and w.get("door", 0) > 0: cut_doors += 1
        walls.append(nw)
    meta = {"schema": 1, "id": sid, "source": {"module": MODULE, "pack": "maps", "grid": G, "boxSquares": [sx, sy, sw, sh]},
            "gridSize": TARGET, "widthSquares": sw, "heightSquares": sh, "variants": {v: f"{v}.webp" for v in VARIANTS},
            "walls": walls, "doors": sum(1 for w in walls if w.get("door", 0) > 0), "cutDoors": cut_doors,
            "edges": None}
    old = d / "segment.json"
    if old.exists() and args.variants:  # merge: only the new variants change
        meta = json.loads(old.read_text())
        meta["variants"].update({v: f"{v}.webp" for v in VARIANTS})
    elif old.exists():  # keep what a person set by hand, and what tag.py measured
        prev = json.loads(old.read_text())
        for key in ("edges", "shape", "themes", "tags", "variantInfo", "colours", "baseVariant"):
            if prev.get(key) is not None: meta[key] = prev[key]
        if prev.get("schema", 1) > meta["schema"]: meta["schema"] = prev["schema"]
    (d / "segment.json").write_text(json.dumps(meta, indent=1))
    report.append((sid, sw, sh, len(walls), meta["doors"], cut_doors))
    t = Image.open(d / "original.webp").copy(); dr = ImageDraw.Draw(t)
    for w in walls:
        col = (255, 220, 0) if w.get("door", 0) > 0 else ((255, 60, 255) if w.get("cut") else (255, 40, 40))
        dr.line(w["c"], fill=col, width=6)
    t.thumbnail((360, 360)); thumbs.append((sid, t))

# contact sheet
cols = 4; cw, chh = 380, 400
rows = math.ceil(len(thumbs) / cols)
sheet = Image.new("RGB", (cols * cw, rows * chh), (24, 28, 27)); dr = ImageDraw.Draw(sheet)
for i, (sid, t) in enumerate(thumbs):
    x, y = (i % cols) * cw + 10, (i // cols) * chh + 10
    sheet.paste(t, (x, y + 22)); dr.text((x, y + 4), sid, fill=(230, 230, 230))
if args.sheet: sheet.save(args.sheet, quality=85)
for r in report: print("%-18s %2dx%-2d walls=%-3d doors=%d cutDoors=%d" % r)
