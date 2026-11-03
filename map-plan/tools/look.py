"""Look at map pictures, on this machine, and say what they show: the theme of the whole map and what is in each room.

The picture is compared with the phrases in map-plan/vocab.json by an open image-text model (CLIP, run on the CPU).
Nothing is sent anywhere. The output is numbers per map (how close each phrase is), plus an embedding of the whole
map so a written description can find it. Pictures of published maps are someone else's product: write the output
under stagecraft/ (ignored), never into a tracked file.

Optional. Needs a Python with torch, open_clip_torch and pillow (e.g. a venv at /opt/dev/.venvs/map-tag):
  look.py index <job.jsonl> <out.jsonl> [--model ViT-B-32 --pretrained laion2b_s34b_b79k]   one line out per map
  look.py text "<description>" ...                                                          embeddings of descriptions
  look.py thumbs <job.jsonl> <dir> [--px 360]                                               a small JPEG per map, for the
                                                                                            local shelf page only
A job line (bin/map-profile --look-job) is
  {id, img | dd2vtt, gridPx, sceneW, sceneH, w, h, cells: [w*h ints: 0 none, -1 outside floor, k room k], rooms: [k...]}
An output line is {id, model, emb: [...], place: {...}, terrain: {...}, rooms: {k: [sim per content kind]}, out: [...]}.
"""
import base64, io, json, os, sys

import numpy as np
import open_clip
import torch
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
VOCAB = json.load(open(os.path.join(HERE, "..", "vocab.json")))
KINDS = list(VOCAB["contents"])
PLACES, TERRAINS = list(VOCAB["theme"]["place"]), list(VOCAB["theme"]["terrain"])
ROOM_T = ["a top-down battle map of a room with {}", "a fantasy RPG map seen from above, showing {}", "{}, top-down view, tabletop map"]
MAP_T = ["a top-down fantasy battle map of {}", "a tabletop RPG map of {}, seen from above"]
TILE, OUT_TILE, MAX_ROOM_TILES, MAX_OUT_TILES = 4, 6, 6, 24

def article(w):
  return ("an " if w[0] in "aeiou" else "a ") + w

def load(name, pretrained):
  torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
  model, _, prep = open_clip.create_model_and_transforms(name, pretrained=pretrained)
  model.eval()
  return model, prep, open_clip.get_tokenizer(name)

def text_bank(model, tok, phrases, templates):
  with torch.no_grad():
    out = []
    for p in phrases:
      e = model.encode_text(tok([t.format(p) for t in templates])); e /= e.norm(dim=-1, keepdim=True)
      m = e.mean(0); out.append(m / m.norm())
    return torch.stack(out)

def embed(model, prep, crops):
  with torch.no_grad():
    vs = []
    for i in range(0, len(crops), 32):
      v = model.encode_image(torch.stack([prep(c) for c in crops[i:i + 32]])); v /= v.norm(dim=-1, keepdim=True); vs.append(v)
    return torch.cat(vs)

def picture(job):
  if job.get("dd2vtt"):
    d = json.load(open(job["dd2vtt"]))
    return Image.open(io.BytesIO(base64.b64decode(d["image"]))).convert("RGB")
  im = Image.open(job["img"])
  im.draft("RGB", (im.width // 2, im.height // 2))  # JPEG: decode at half size, plenty for 224 px crops
  return im.convert("RGB")

def spread(items, n):
  if len(items) <= n: return items
  return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]

def index(job_path, out_path, name, pretrained):
  model, prep, tok = load(name, pretrained)
  T_room = text_bank(model, tok, [VOCAB["contents"][k]["prompt"] for k in KINDS], ROOM_T)
  T_place = text_bank(model, tok, [article(p) for p in PLACES], MAP_T)
  T_terr = text_bank(model, tok, [article(t) for t in TERRAINS], MAP_T)
  done = set()
  if os.path.exists(out_path):
    for line in open(out_path):
      try: done.add(json.loads(line)["id"])
      except Exception: pass
  out = open(out_path, "a")
  jobs = [json.loads(l) for l in open(job_path) if l.strip()]
  for n, job in enumerate(jobs):
    if job["id"] in done: continue
    try:
      im = picture(job)
    except Exception as e:
      print(f"skip {job['id']}: {e}", file=sys.stderr); continue
    w, h = job["w"], job["h"]
    sq = job["gridPx"] * im.width / job["sceneW"]          # image pixels per square
    # The model sees 224 px; a 4-square tile needs ~56 px a square. Shrink once, so every crop is cheap.
    f = int(sq // 56)
    if f >= 2: im = im.reduce(f); sq = job["gridPx"] * im.width / job["sceneW"]
    cells = np.array(job["cells"], dtype=np.int32).reshape(h, w)
    box = lambda x, y, bw, bh: im.crop((int(x * sq), int(y * sq), int(min(w, x + bw) * sq), int(min(h, y + bh) * sq)))
    crops, owner = [im.resize((448, max(1, int(448 * im.height / im.width))))], ["map"]
    for k in job["rooms"]:
      ys, xs = np.nonzero(cells == k)
      if not len(xs): continue
      x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
      crops.append(box(x0, y0, x1 - x0, y1 - y0)); owner.append(k)
      if len(xs) > 24:
        tiles = [(tx, ty) for ty in range(y0, max(y0 + 1, y1 - TILE + 1), TILE) for tx in range(x0, max(x0 + 1, x1 - TILE + 1), TILE)
                 if cells[min(h - 1, ty + TILE // 2), min(w - 1, tx + TILE // 2)] == k]
        for tx, ty in spread(tiles, MAX_ROOM_TILES): crops.append(box(tx, ty, TILE, TILE)); owner.append(k)
    if (cells == -1).sum() > 0.3 * w * h:
      tiles = [(tx, ty) for ty in range(0, max(1, h - OUT_TILE + 1), OUT_TILE) for tx in range(0, max(1, w - OUT_TILE + 1), OUT_TILE)
               if (cells[ty:ty + OUT_TILE, tx:tx + OUT_TILE] == -1).mean() >= 0.5]
      for tx, ty in spread(tiles, MAX_OUT_TILES): crops.append(box(tx, ty, OUT_TILE, OUT_TILE)); owner.append("out")
    V = embed(model, prep, crops)
    S = (V @ T_room.T).numpy()
    r4 = lambda a: [round(float(x), 4) for x in a]
    # A room is its whole crop or its two most telling tiles, whichever is closer, kind by kind.
    rooms = {}
    for k in job["rooms"]:
      idx = [i for i, o in enumerate(owner) if o == k]
      if not idx: continue
      whole, tiles = S[idx[0]], S[idx[1:]]
      best = np.maximum(whole, np.sort(tiles, axis=0)[::-1][:2].mean(0)) if len(tiles) else whole
      rooms[str(k)] = r4(best)
    oidx = [i for i, o in enumerate(owner) if o == "out"]
    rec = {"id": job["id"], "model": f"{name}/{pretrained}", "emb": r4(V[0].numpy()),
           "place": dict(zip(PLACES, r4((V[0:1] @ T_place.T).numpy()[0]))),
           "terrain": dict(zip(TERRAINS, r4((V[0:1] @ T_terr.T).numpy()[0]))),
           "rooms": rooms, "out": r4(np.sort(S[oidx], axis=0)[::-1][:3].mean(0)) if oidx else None}
    out.write(json.dumps(rec) + "\n"); out.flush()
    if n % 25 == 0: print(f"{n + 1}/{len(jobs)} {len(crops)} crops", file=sys.stderr)

def thumbs(job_path, out_dir, px):
  os.makedirs(out_dir, exist_ok=True)
  for line in open(job_path):
    if not line.strip(): continue
    job = json.loads(line)
    dest = os.path.join(out_dir, job["id"].replace("/", "__") + ".jpg")
    if os.path.exists(dest): continue
    try:
      im = picture(job)
      im.thumbnail((px, px))
      im.save(dest, "JPEG", quality=72)
    except Exception as e:
      print(f"skip {job['id']}: {e}", file=sys.stderr)

def text(descs, name, pretrained):
  model, _, tok = load(name, pretrained)
  for d in descs:
    T = text_bank(model, tok, [d], MAP_T + ["{}"])
    print(json.dumps({"text": d, "emb": [round(float(x), 4) for x in T[0]]}))

if __name__ == "__main__":
  a = sys.argv[1:]
  opt = lambda k, d: a[a.index(k) + 1] if k in a else d
  # ViT-B-32 by default: on our own maps (rooms with known objects) it named 19 of 50 top-3 contents, ViT-B-16 21 at
  # 2.5x the time, ViT-L-14 23 at 10x. Every map on one shelf must be looked at with the same model.
  name, pre, px = opt("--model", "ViT-B-32"), opt("--pretrained", "laion2b_s34b_b79k"), int(opt("--px", "360"))
  a = [x for i, x in enumerate(a) if not (x.startswith("--") or (i > 0 and a[i - 1].startswith("--")))]
  if a[:1] == ["index"]: index(a[1], a[2], name, pre)
  elif a[:1] == ["thumbs"]: thumbs(a[1], a[2], px)
  elif a[:1] == ["text"]: text(a[1:], name, pre)
  else: print(__doc__); sys.exit(2)
