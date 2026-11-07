// Seeded randomness and noise for the makers. A maker takes a seed and nothing else random, so the same brief and seed
// make the same map on any machine. `fork(name)` gives an independent stream, so adding one feature to a recipe moves
// only that feature, not everything drawn after it.

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export function rng(seed = 1) {
  let h = typeof seed === "number" ? (seed >>> 0) || 1 : hashStr(String(seed));
  const base = h;
  const next = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor((b - a + 1) * next()), // a..b inclusive
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    normal: (mu = 0, sd = 1) => { const u = Math.max(1e-12, next()), v = next(); return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    shuffle: (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    fork: (name) => rng(hashStr(`${base}:${name}`)),
    seed: base,
  };
  return r;
}

/** A hash of lattice point (ix, iy) under a seed, 0..1. */
function lattice(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth value noise, 0..1, with features about `scale` units apart. */
export function valueNoise(x, y, scale, seed) {
  const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = smooth(fx - ix), ty = smooth(fy - iy);
  const a = lattice(ix, iy, seed), b = lattice(ix + 1, iy, seed), c = lattice(ix, iy + 1, seed), d = lattice(ix + 1, iy + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Octaves of value noise: [[scale, weight], ...]. Returns 0..1. */
export function fbm(x, y, octaves, seed) {
  let s = 0, w = 0;
  octaves.forEach(([scale, weight], i) => { s += weight * valueNoise(x, y, scale, (seed + i * 1013) | 0); w += weight; });
  return w ? s / w : 0.5;
}
