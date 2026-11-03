// Comparing map characters (profile.mjs). Two uses:
//   distance(a, b)            how alike two maps are: features scaled to roughly 0..1, plus the footprints
//   briefScore(profile, want) how far a map is from a wanted character, given as ranges: 0 = inside every range
//   nearest(target, rows, k)  rows are { id, profile }; target is a profile or a `want` (ranges)
//
// A `want` names any of these features with [min, max] (either may be null): area, aspect, enclosure, rooms, loops,
// deadEnds, squareness, organic, openness, longest, narrowShare, widest, lights, doorsOut, buildingRooms, buildingArea
// (the largest building: rooms joined by doors, see profile.mjs).

const FEATURES = {
  area: [(p) => Math.log10(Math.max(1, p.size.area)), 1],
  aspect: [(p) => Math.log2(p.size.aspect), 1],
  enclosure: [(p) => p.enclosure, 1],
  rooms: [(p) => Math.log2(1 + p.rooms.count), 0.35],
  loops: [(p) => Math.log2(1 + p.graph.loops), 0.4],
  deadEnds: [(p) => (p.rooms.count ? p.graph.deadEnds / p.rooms.count : 0), 0.5],
  squareness: [(p) => p.walls.squareness, 1],
  organic: [(p) => p.walls.organic, 1],
  openness: [(p) => p.openness.median, 1],
  longest: [(p) => Math.log2(1 + p.openness.longest), 0.25],
  narrowShare: [(p) => p.space.narrowShare, 1],
  widest: [(p) => Math.log2(1 + p.space.widest), 0.3],
  lights: [(p) => Math.min(1, p.lights.density), 0.5],
  doorsOut: [(p) => Math.log2(1 + p.graph.doorsOut), 0.3],
  buildingRooms: [(p) => Math.log2(1 + (p.building?.rooms ?? 0)), 0.35],
  buildingArea: [(p) => Math.log10(1 + (p.building?.area ?? 0)), 0.5],
};
// What `want` ranges are written in: the plain value, not the scaled one.
const RAW = {
  area: (p) => p.size.area, aspect: (p) => p.size.aspect, enclosure: (p) => p.enclosure, rooms: (p) => p.rooms.count,
  loops: (p) => p.graph.loops, deadEnds: (p) => p.graph.deadEnds, squareness: (p) => p.walls.squareness, organic: (p) => p.walls.organic,
  openness: (p) => p.openness.median, longest: (p) => p.openness.longest, narrowShare: (p) => p.space.narrowShare,
  widest: (p) => p.space.widest, lights: (p) => p.lights.density, doorsOut: (p) => p.graph.doorsOut,
  buildingRooms: (p) => p.building?.rooms ?? 0, buildingArea: (p) => p.building?.area ?? 0,
};
export const WANT_FEATURES = Object.keys(RAW);

export function footprintDistance(a, b) {
  if (!a?.footprint || !b?.footprint || a.footprint.n !== b.footprint.n) return 0;
  let s = 0;
  for (let i = 0; i < a.footprint.rooms.length; i++) {
    s += Math.abs(a.footprint.rooms[i] - b.footprint.rooms[i]) + 0.5 * Math.abs(a.footprint.walls[i] - b.footprint.walls[i]);
  }
  return s / a.footprint.rooms.length;
}

export function distance(a, b, { weights = {}, footprint = 1 } = {}) {
  let s = 0;
  for (const [k, [f, w]] of Object.entries(FEATURES)) s += (weights[k] ?? w) * Math.abs(f(a) - f(b));
  return s + footprint * 3 * footprintDistance(a, b);
}

/** 0 when the profile sits inside every range; otherwise the summed misses, each relative to the range's size. */
export function briefScore(p, want) {
  let s = 0;
  for (const [k, range] of Object.entries(want)) {
    if (!RAW[k]) throw new Error(`unknown feature in want: ${k} (known: ${WANT_FEATURES.join(", ")})`);
    const [lo, hi] = range, v = RAW[k](p);
    const span = Math.max(1e-6, Math.abs((hi ?? lo ?? 1) - (lo ?? hi ?? 0)) || Math.abs(hi ?? lo ?? 1));
    if (lo != null && v < lo) s += (lo - v) / span;
    if (hi != null && v > hi) s += (v - hi) / span;
  }
  return s;
}

const isProfile = (t) => t && typeof t === "object" && "schemaVersion" in t && "size" in t;

export function nearest(target, rows, k = 10, opts = {}) {
  const score = isProfile(target) ? (p) => distance(target, p, opts) : (p) => briefScore(p, target);
  return rows.map((r) => ({ ...r, score: Math.round(score(r.profile) * 1000) / 1000 }))
    .sort((x, y) => x.score - y.score).slice(0, k);
}
