// The picture side of a map's character (tools/look.py does the looking, on the machine that holds the art).
//   lookJob(plan, analysis, where)   what look.py needs for one map: where the picture is, and which square is which room
//   lookTags(looks)                  look.py's raw closeness numbers, for a whole shelf, as tags per map: picture theme
//                                    (place, terrain), what is in each room, and what is about on open ground
// Closeness is relative: a phrase like "metal grates" sits close to every top-down map, so each phrase is scored
// against its own spread over the whole shelf (a z-score), and a tag is kept only when a map or room stands out.
import { CONTENT_KINDS, PLACES, TERRAINS } from "./theme.mjs";

export const LOOK_ROOM_Z = 1.0, LOOK_MAP_Z = 1.5, LOOK_ROOM_TOP = 3, LOOK_MAP_TOP = 2;

/** `where`: { id, img } or { id, dd2vtt }, plus gridPx and sceneW/sceneH (the picture's size in scene pixels). */
export function lookJob(plan, A, where) {
  const w = Math.ceil(plan.width), h = Math.ceil(plan.height), { R, W, lab, rooms, outside } = A;
  const cells = new Array(w * h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = new Map();
    for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) {
      const cx = x * R + dx, cy = y * R + dy;
      if (cx >= W || cy * W + cx >= lab.length) continue;
      const id = lab[cy * W + cx], v = rooms.has(id) ? id : outside.has(id) ? -1 : 0;
      n.set(v, (n.get(v) ?? 0) + 1);
    }
    cells[y * w + x] = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  }
  return { ...where, w, h, cells, rooms: [...rooms.keys()] };
}

function stats(vectors, n) {
  const mean = new Float64Array(n), sd = new Float64Array(n);
  for (const v of vectors) for (let i = 0; i < n; i++) mean[i] += v[i] / vectors.length;
  for (const v of vectors) for (let i = 0; i < n; i++) sd[i] += (v[i] - mean[i]) ** 2 / vectors.length;
  for (let i = 0; i < n; i++) sd[i] = Math.sqrt(sd[i]) || 1;
  return { mean, sd };
}
const top = (v, { mean, sd }, names, z, k) =>
  names.map((name, i) => [name, (v[i] - mean[i]) / sd[i]]).filter(([, s]) => s >= z).sort((a, b) => b[1] - a[1]).slice(0, k).map(([name]) => name);

/** Tags for every map in `looks` (look.py output lines). Returns Map<id, { place[], terrain[], rooms{k: kinds[]}, out[], contents{kind: rooms} }>. */
export function lookTags(looks) {
  const roomS = stats(looks.flatMap((l) => Object.values(l.rooms)), CONTENT_KINDS.length);
  const outs = looks.map((l) => l.out).filter(Boolean);
  const outS = outs.length ? stats(outs, CONTENT_KINDS.length) : roomS;
  const vec = (o, names) => names.map((n) => o[n]);
  const placeS = stats(looks.map((l) => vec(l.place, PLACES)), PLACES.length);
  const terrS = stats(looks.map((l) => vec(l.terrain, TERRAINS)), TERRAINS.length);
  const out = new Map();
  for (const l of looks) {
    const rooms = Object.fromEntries(Object.entries(l.rooms).map(([k, v]) => [k, top(v, roomS, CONTENT_KINDS, LOOK_ROOM_Z, LOOK_ROOM_TOP)]));
    const open = l.out ? top(l.out, outS, CONTENT_KINDS, LOOK_ROOM_Z, LOOK_ROOM_TOP + 1) : [];
    const contents = {};
    for (const kinds of [...Object.values(rooms), open]) for (const k of kinds) contents[k] = (contents[k] ?? 0) + 1;
    out.set(l.id, { place: top(vec(l.place, PLACES), placeS, PLACES, LOOK_MAP_Z, LOOK_MAP_TOP),
      terrain: top(vec(l.terrain, TERRAINS), terrS, TERRAINS, LOOK_MAP_Z, LOOK_MAP_TOP), rooms, out: open, contents });
  }
  return out;
}

/** Cosine closeness of a description's embedding (look.py text) to each map's picture embedding. */
export function textCloseness(textEmb, looks) {
  return new Map(looks.map((l) => [l.id, l.emb.reduce((s, v, i) => s + v * textEmb[i], 0)]));
}
