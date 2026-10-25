"""Tier-1 theme grade (prototype): shift a segment's colours toward a reference image, in Lab.

The transform is fitted once per segment, on its base variant, then applied unchanged to every
variant, so dry vs flooded stays different after grading. Pixels change colour only, never
position, so walls and doors stay exact. Writes <variant>.<theme>.webp next to each variant
and records the theme in segment.json.

  python3 grade.py <theme> <reference.jpg> <strength 0..1> <segment dir>...
"""
import json, sys, pathlib
import numpy as np
from PIL import Image

M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
WHITE = np.array([0.95047, 1.0, 1.08883])

def to_lab(rgb):
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ M.T / WHITE
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)

def to_rgb(lab):
    fy = (lab[..., 0] + 16) / 116; fx = fy + lab[..., 1] / 500; fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], -1)
    xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * WHITE
    c = xyz @ np.linalg.inv(M).T
    c = np.where(c > 0.0031308, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055, 12.92 * c)
    return np.clip(c * 255, 0, 255).astype(np.uint8)

def stats(lab):
    # Ignore near-black padding (Czepeku maps sit on black) so it doesn't drag the statistics.
    px = lab.reshape(-1, 3); px = px[px[:, 0] > 4]
    return px.mean(0), px.std(0) + 1e-6

def fit(src_lab, ref_lab, strength):
    ms, ss = stats(src_lab); mr, sr = stats(ref_lab)
    ratio = np.clip(sr / ss, [0.6, 0.4, 0.4], [1.6, 2.5, 2.5])   # keep contrast changes sane
    scale = 1 + strength * (ratio - 1)
    shift = strength * (mr - ms)
    return lambda lab: (lab - ms) * scale + ms + shift

def small(img, n=600):
    im = img.copy(); im.thumbnail((n, n)); return np.asarray(im.convert("RGB"), dtype=np.float64)

if __name__ == "__main__":
    theme, ref_path, strength = sys.argv[1], sys.argv[2], float(sys.argv[3])
    ref_lab = to_lab(small(Image.open(ref_path)))
    for d in map(pathlib.Path, sys.argv[4:]):
        seg = json.load(open(d / "segment.json"))
        base = seg.get("baseVariant", "original")
        tf = fit(to_lab(small(Image.open(d / seg["variants"][base]))), ref_lab, strength)
        for v, f in seg["variants"].items():
            rgb = np.asarray(Image.open(d / f).convert("RGB"), dtype=np.float64)
            Image.fromarray(to_rgb(tf(to_lab(rgb)))).save(d / f"{v}.{theme}.webp", quality=82)
        seg.setdefault("themes", {})[theme] = {"reference": ref_path, "strength": strength, "fittedOn": base,
                                               "variants": {v: f"{v}.{theme}.webp" for v in seg["variants"]}}
        (d / "segment.json").write_text(json.dumps(seg, indent=1))
        print("graded", d.name, len(seg["variants"]), "variants")
