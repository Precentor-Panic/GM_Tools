// Wear and collapse, applied to a Build's canvas before tracing. Everything broken is painted rough (organic), so its
// edges come out ragged while the masonry left standing stays true.
//
//   breach(b, {mass, at, width, depth, spill})   a gap blown through a solid mass (a curtain wall), rubble in it and
//                                                spilled either side
//   fall(b, {mass, floor, at, r, keep})          a tower come down: its room open to the sky, part of its masonry left
//                                                as broken stubs, rubble round it
//   crumble(b, {mass, n, r})                     bites out of a mass's edges
// Each returns the rubble spots ([[x, y, r]]) for dressing.
import { fbm } from "./rng.mjs";

function rubbleRegion(b) {
  return b.cv.byKey("rubble") ?? b.cv.region({ kind: "ground", key: "rubble", organic: true, material: "rubble", label: "rubble" });
}

/** A rough blob: inside an ellipse whose edge is pushed in and out by noise. */
const blob = (cx, cy, rx, ry, seed, rough = 0.35) => (x, y) => {
  const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return d < 1 - rough + 2 * rough * fbm(x, y, [[1.2, 1], [0.5, 0.5]], seed);
};

export function breach(b, { mass, at: [cx, cy], width = 3, depth = 2, spill = 2.5, seed }) {
  const rub = rubbleRegion(b), m = b.cv.byKey(mass), s = seed ?? (b.r.fork(`breach:${cx},${cy}`).next() * 1e9) | 0;
  const hole = blob(cx, cy, width / 2 + 0.3, depth / 2 + 1, s, 0.3);
  b.cv.paintWhere((x, y, v) => v === m && hole(x, y), rub, [cx - width, cy - depth - 1, cx + width, cy + depth + 1]);
  // Spill: rubble over the ground either side, not into rooms.
  const sp = blob(cx, cy, width / 2 + spill * 0.8, depth / 2 + spill, s + 7, 0.45);
  const ground = new Set(b.cv.regions.filter((r) => r && r.kind === "ground").map((r) => r.id).concat(b.cv.voidKind === "ground" ? [0] : []));
  b.cv.paintWhere((x, y, v) => ground.has(v) && v !== rub && sp(x, y), rub, [cx - width - spill, cy - depth - spill - 1, cx + width + spill, cy + depth + spill + 1]);
  return [[cx, cy, width / 2], [cx, cy - depth / 2 - 1, 1], [cx, cy + depth / 2 + 1, 1]];
}

export function fall(b, { mass, floor, at: [cx, cy], r, keep = 0.4, seed }) {
  const rub = rubbleRegion(b), m = b.cv.byKey(mass), f = b.cv.byKey(floor), s = seed ?? (b.r.fork(`fall:${cx},${cy}`).next() * 1e9) | 0;
  // The room is open ground now, its old floor showing between the stones.
  const ruin = b.cv.byKey(`${floor}-ruin`) ?? b.cv.region({ kind: "ground", key: `${floor}-ruin`, organic: true, material: "flagstones", label: "fallen tower" });
  b.cv.relabel(f, ruin);
  // Masonry: an arc of it (keep, a share of the way round) stands; the rest is rubble.
  const a0 = b.r.fork(`fall-arc:${cx}`).range(0, Math.PI * 2);
  b.cv.paintWhere((x, y, v) => {
    if (v !== m || Math.hypot(x - cx, y - cy) > r + 0.2) return false;
    let a = Math.atan2(y - cy, x - cx) - a0; a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const jag = 0.5 * (fbm(x, y, [[0.7, 1]], s) - 0.5);
    return a / (2 * Math.PI) + jag > keep;
  }, rub, [cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1]);
  // Spill outward over the ground.
  const ground = new Set(b.cv.regions.filter((q) => q && q.kind === "ground" && q.id !== ruin).map((q) => q.id).concat(b.cv.voidKind === "ground" ? [0] : []));
  const sp = blob(cx, cy, r + 2.2, r + 2.2, s + 3, 0.4);
  b.cv.paintWhere((x, y, v) => ground.has(v) && sp(x, y), rub, [cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3]);
  return [[cx, cy, r * 0.6], [cx + r, cy, 1.2], [cx - r, cy, 1.2], [cx, cy + r, 1.2], [cx, cy - r, 1.2]];
}

export function crumble(b, { mass, n = 6, r = [0.35, 0.7], within }) {
  const rub = rubbleRegion(b), m = b.cv.byKey(mass), rr = b.r.fork(`crumble:${mass}`);
  const { W, H, R, lab } = b.cv, edge = [];
  for (let c = 0; c < W * H; c++) {
    if (lab[c] !== m) continue;
    const x = c % W, y = (c - x) / W;
    if (x % 4 || y % 4) continue; // a sparse sample of the mass's edge cells
    const nb = [lab[c - 1], lab[c + 1], lab[c - W], lab[c + W]];
    if (nb.some((v) => v !== m && v !== undefined)) {
      const p = [(x + 0.5) / R, (y + 0.5) / R];
      if (!within || (p[0] >= within[0] && p[1] >= within[1] && p[0] <= within[0] + within[2] && p[1] <= within[1] + within[3])) edge.push(p);
    }
  }
  const spots = [];
  for (const [x, y] of rr.shuffle(edge).slice(0, n)) {
    const rad = rr.range(r[0], r[1]), s = (rr.next() * 1e9) | 0, f = blob(x, y, rad, rad, s, 0.4);
    b.cv.paintWhere((px, py, v) => v === m && f(px, py), rub, [x - rad - 0.5, y - rad - 0.5, x + rad + 0.5, y + rad + 0.5]);
    spots.push([x, y, rad]);
  }
  return spots;
}
