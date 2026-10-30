/**
 * The city above the atlas, drawn the way a town generator would: streets as the gaps between blocks, houses as small
 * footprints at their real size, so a GM can see how big a house, a yard or an arena is next to everything else.
 * Pure and deterministic (a seeded RNG), shared by the browser and Node (atlas/city.mjs re-exports it).
 *
 * Input, all in the atlas (feet, x east, y south, bearings clockwise from north):
 *   atlas.city = { seed, bands: [{ r0, r1, block: [length, depth] }], avenues: [{ bearing, width }] }
 *     bands lay out the street grid: ring streets every `depth` feet, radial streets every `length` feet of arc.
 *   area.fabric = { z, lot: [frontage, depth], gap, vacancy, kind: "houses" | "compounds" | "sheds" | "none" }
 *     what fills a block in that area; where areas overlap, the highest z wins. kind "none" keeps a block empty.
 *   areas of kind "arena" or "landmark" (and the lake, the island and the wall) are reserved: nothing is built there.
 * Output: { buildings: [{ kind, area, pts: [[x, y] x4] }], blocks, stats }.
 */
import { fromPolar, pointInArea } from "./atlas-geometry.mjs";

const RESERVED = new Set(["arena", "landmark", "lake", "island", "wall", "yard"]);

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** The fabric under a point: the highest-z area with a fabric that contains it, or null. Reserved areas win outright. */
export function fabricAt(atlas, p) {
  let best = null;
  for (const a of atlas.areas || []) {
    if (!pointInArea(p, a.shape)) continue;
    if (RESERVED.has(a.kind) && a.kind !== "wall") return { reserved: true, area: a.id };
    if (!a.fabric) continue;
    if (!best || (a.fabric.z ?? 0) > (best.fabric.z ?? 0)) best = a;
  }
  return best ? { area: best.id, ...best.fabric } : null;
}

/** Distance from p to the radial line at `bearing` through the centre (only on the outward side). */
function offAvenue(p, c, bearing) {
  const d = fromPolar(1, bearing, { x: 0, y: 0 });
  const vx = p.x - c.x, vy = p.y - c.y;
  const along = vx * d.x + vy * d.y;
  if (along < 0) return Infinity;
  return Math.abs(vx * d.y - vy * d.x);
}

export function buildCity(atlas, opts = {}) {
  const city = atlas.city;
  if (!city?.bands?.length) return { buildings: [], blocks: 0, stats: {} };
  const c = atlas.frame?.centre || { x: 0, y: 0 };
  const rand = rng(city.seed ?? 1);
  const focus = opts.focus;              // [x0, y0, x1, y1]: only blocks touching it (keeps a close-up cheap)
  const avenues = city.avenues || [];
  const street = city.street ?? 14;      // ft between blocks
  const out = [];
  let blocks = 0;
  const P = (r, th) => { const q = fromPolar(r, th, c); return [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]; };
  // Reserved ground (arenas, landmarks, the lake) is checked at every corner; the district's fabric is the block's.
  const reserved = (atlas.areas || []).filter((a) => RESERVED.has(a.kind) && a.kind !== "wall");
  const wall = (atlas.areas || []).find((a) => a.kind === "wall" && a.shape.type === "annulus");
  const lotOK = (pts, fab) => {
    for (const [x, y] of pts) {
      if (wall && Math.hypot(x - c.x, y - c.y) > wall.shape.r0) return null;
      for (const a of reserved) if (pointInArea({ x, y }, a.shape)) return null;
    }
    const mid = { x: (pts[0][0] + pts[2][0]) / 2, y: (pts[0][1] + pts[2][1]) / 2 };
    for (const av of avenues) if (offAvenue(mid, c, av.bearing) < (av.width ?? 40) / 2 + 6) return null;
    return fab;
  };
  for (const band of city.bands) {
    const [len, depth] = band.block;
    const rings = Math.max(1, Math.round((band.r1 - band.r0) / depth));
    const dr = (band.r1 - band.r0) / rings;
    for (let i = 0; i < rings; i++) {
      const ra = band.r0 + i * dr + street / 2, rb = band.r0 + (i + 1) * dr - street / 2;
      const rm = (ra + rb) / 2;
      const n = Math.max(6, Math.round((2 * Math.PI * rm) / len));
      const off = rand() * (360 / n);    // stagger each ring so streets don't line up into spokes
      for (let j = 0; j < n; j++) {
        const t0 = off + (j * 360) / n, t1 = off + ((j + 1) * 360) / n;
        const half = ((street / 2) / rm) * (180 / Math.PI);
        const ta = t0 + half, tb = t1 - half;
        if (focus) {
          const q = P(rm, (ta + tb) / 2), pad = Math.max(len, depth);
          if (q[0] < focus[0] - pad || q[0] > focus[2] + pad || q[1] < focus[1] - pad || q[1] > focus[3] + pad) continue;
        }
        const centre = fromPolar(rm, (ta + tb) / 2, c);
        const fab = fabricAt(atlas, centre);
        if (!fab || fab.reserved || fab.kind === "none") continue;
        blocks++;
        fillBlock(fab, ra, rb, ta, tb);
      }
    }
  }

  function fillBlock(fab, ra, rb, ta, tb) {
    const [front, deep] = fab.lot || [25, 30];
    const gap = fab.gap ?? 0, vac = fab.vacancy ?? 0.05;
    const kind = fab.kind || "houses";
    const d = Math.min(deep, (rb - ra) / 2);
    const rows = kind === "sheds" ? [[ra + 4, rb - 4, "radial"]] : [[rb - d, rb, "outer"], [ra, ra + d, "inner"]];
    for (const [r0, r1, side] of rows) {
      const rm = (r0 + r1) / 2;
      const arc = ((tb - ta) * Math.PI * rm) / 180;
      let s = 0;
      while (s < arc - front * 0.5) {
        const w = Math.min(arc - s, front * (0.7 + rand() * 0.6));
        const a0 = ta + (s / arc) * (tb - ta), a1 = ta + (Math.min(arc, s + w - gap) / arc) * (tb - ta);
        s += w;
        if (rand() < vac) continue;
        // A compound sits back from the street; a shed runs the whole block deep.
        const inset = kind === "compounds" ? 6 : 0;
        const pts = side === "outer" ? [P(r1 - inset, a0), P(r1 - inset, a1), P(r0, a1), P(r0, a0)] : [P(r0 + inset, a0), P(r0 + inset, a1), P(r1, a1), P(r1, a0)];
        const ok = lotOK(pts, fab);
        if (ok) out.push({ kind, area: ok.area, pts });
      }
    }
    // Radial ends of a long block close it off with a house or two facing the side streets (houses only).
    if (kind === "houses" && rb - ra > 2 * d + front) {
      for (const t of [ta, tb]) {
        const dt = ((front * 0.9) / ((ra + rb) / 2)) * (180 / Math.PI) * (t === ta ? 1 : -1);
        for (let r = ra + d; r + front <= rb - d; r += front) {
          if (rand() < vac) continue;
          const pts = [P(r, t), P(r + front - gap, t), P(r + front - gap, t + dt), P(r, t + dt)];
          const ok = lotOK(pts, fab);
          if (ok) out.push({ kind, area: ok.area, pts });
        }
      }
    }
  }

  const stats = {};
  for (const b of out) stats[b.area] = (stats[b.area] || 0) + 1;
  return { buildings: out, blocks, stats };
}

/** The buildings as one SVG group (a path per kind, so a whole city stays a small file). */
export function citySvg(city, P, k) {
  const by = {};
  for (const b of city.buildings) (by[b.kind] ||= []).push(`M${b.pts.map((q) => q.join(" ")).join("L")}Z`);
  const fill = { houses: P.paper2, compounds: P.paper2, sheds: P.paper2 };
  const sw = (px) => (Math.round((px / k) * 100) / 100).toString();
  return `<g class="city">${Object.entries(by).map(([kind, ds]) =>
    `<path d="${ds.join("")}" fill="${fill[kind] || P.paper2}" stroke="${P.faint}" stroke-width="${sw(kind === "houses" ? 0.5 : 0.7)}" stroke-linejoin="round"/>`).join("")}</g>`;
}
