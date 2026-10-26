"""Tag and measure segments: write segment v2's tags, variantInfo and colours (see map-segments/composition.mjs).

Usage:
  python3 tag.py <spec.json> [--data <Foundry Data dir>]     tag a pack's segments from its spec, then measure them
  python3 tag.py --measure <segment dir>...                  measure only (pieces with no spec, e.g. stand-ins)

The spec's tag sheet (all optional):
  "tagDefaults":  { "setting": "sewer", "light": "top" }               every segment in the pack
  "tags":         { "<segment id>": { "role": "room", "floor": [...] } } per segment; merged over the defaults
  "variantInfo":  { "<variant>": { "state": "massacre", "time": "day" } } per variant, the same for every segment

Measuring: the mean Lab colour of every art file a segment lists (its variants and theme files),
ignoring near-black padding, the same statistic grade.py fits on. The clash checks compare these
across an open join. Re-run after re-cutting or grading.
"""
import argparse, json, os, pathlib, sys
import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from grade import to_lab, small  # one Lab conversion for the whole toolset

SCHEMA = 2

def mean_lab(path):
    px = to_lab(small(Image.open(path))).reshape(-1, 3)
    px = px[px[:, 0] > 4]
    return [round(float(v), 1) for v in px.mean(0)]

def art_files(seg):
    files = set(seg["variants"].values())
    for t in (seg.get("themes") or {}).values():
        files.update(t.get("variants", {}).values())
    return sorted(files)

def measure(d):
    seg = json.loads((d / "segment.json").read_text())
    seg["colours"] = {f: mean_lab(d / f) for f in art_files(seg) if (d / f).exists()}
    seg["schema"] = max(seg.get("schema", 1), SCHEMA)
    (d / "segment.json").write_text(json.dumps(seg, indent=1))
    return seg

def tag(d, spec):
    seg = json.loads((d / "segment.json").read_text())
    sid = seg["id"]
    tags = {**spec.get("tagDefaults", {}), **spec.get("tags", {}).get(sid, {})}
    if tags: seg["tags"] = tags
    vi = spec.get("variantInfo", {})
    if vi: seg["variantInfo"] = {v: vi[v] for v in seg["variants"] if v in vi}
    seg["schema"] = max(seg.get("schema", 1), SCHEMA)
    (d / "segment.json").write_text(json.dumps(seg, indent=1))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", nargs="?")
    ap.add_argument("--data", default=os.environ.get("WF_DATA_DIR", str(pathlib.Path.home() / "foundrydata" / "Data")))
    ap.add_argument("--measure", nargs="*")
    args = ap.parse_args()
    if args.measure is not None:
        dirs = [pathlib.Path(p) for p in args.measure]
        spec = None
    else:
        if not args.spec: ap.error("give a spec, or --measure <segment dir>...")
        spec = json.load(open(args.spec))
        root = pathlib.Path(args.data) / "gm-tools-assets" / "segments" / spec["module"]
        dirs = [root / sid for sid in spec["segments"]]
        unknown = set(spec.get("tags", {})) - set(spec["segments"])
        if unknown: sys.exit(f"tags for segments the spec doesn't cut: {', '.join(sorted(unknown))}")
    for d in dirs:
        if not (d / "segment.json").exists(): print("skip (no segment.json)", d); continue
        if spec: tag(d, spec)
        seg = measure(d)
        t = seg.get("tags", {})
        print("%-18s role=%-10s unique=%-5s floor=%-22s variants=%d colours=%d" % (
            seg["id"], t.get("role", "-"), t.get("unique", False), "/".join(t.get("floor", [])) or "-", len(seg["variants"]), len(seg["colours"])))
