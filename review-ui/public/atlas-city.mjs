/**
 * The city above the atlas, drawn the way a town generator would: streets as the gaps between blocks, houses as small
 * footprints at their real size, so a GM can see how big a house, a yard or an arena is next to everything else.
 * Pure and deterministic (a seeded RNG), shared by the browser and Node (atlas/city.mjs re-exports it).
 *
 * Input, all in the atlas (feet, x east, y south, bearings clockwise from north):
 *   atlas.city = { seed, bands: [{ r0, r1, block: [length, depth] }], avenues: [{ bearing, width }] }
 *     bands lay out the street grid: ring streets every `depth` feet, radial streets every `length` feet of arc.
 *   area.fabric = { z, lot: [frontage, depth], gap, vacancy, open, patchy, kind: "houses" | "compounds" | "sheds" | "none" }
 *     what fills a block in that area; where areas overlap, the highest z wins. kind "none" keeps a block empty.
 *     A real city is not evenly packed (Russell, 2026-10-30: "mega dense uniformly in an odd way"), so:
 *       open    the share of blocks left open (squares, yards, gardens, waste ground), drawn as open ground;
 *       patchy  how far density swings between neighbourhoods: a smooth noise field over the city raises vacancy
 *               in some quarters and packs others tight;
 *       and every lot varies in frontage and depth, so back yards and courtyards come out ragged.
 *   areas of kind "arena" or "landmark" (and the lake, the island and the wall) are reserved: nothing is built there.
 * Output: { buildings: [{ kind, area, pts: [[x, y] x4] }], opens: [{ area, pts }], blocks, stats }.
 */
import { fromPolar, pointInArea } from "./atlas-geometry.mjs";

const RESERVED = new Set(["arena", "landmark", "lake", "island", "wall", "yard"]);

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Smooth value noise in [0, 1] over a grid of `cell` feet (bilinear between hashed corners). Deterministic. */
export function noise(seed, x, y, cell = 700) {
  const h = (i, j) => { let n = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const gx = x / cell, gy = y / cell, i = Math.floor(gx), j = Math.floor(gy), u = gx - i, v = gy - j;
  const s = (t) => t * t * (3 - 2 * t);
  const a = h(i, j) + (h(i + 1, j) - h(i, j)) * s(u), b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * s(u);
  return a + (b - a) * s(v);
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

/** Signed distance from p to the radial line at `bearing` through the centre (only on the outward side). */
function offAvenue(p, c, bearing) {
  const d = fromPolar(1, bearing, { x: 0, y: 0 });
  const vx = p.x - c.x, vy = p.y - c.y;
  const along = vx * d.x + vy * d.y;
  if (along < 0) return Infinity;
  return vx * d.y - vy * d.x;
}

export function buildCity(atlas, opts = {}) {
  const city = atlas.city;
  if (!city?.bands?.length) return { buildings: [], blocks: 0, stats: {} };
  const c = atlas.frame?.centre || { x: 0, y: 0 };
  const rand = rng(city.seed ?? 1);
  const focus = opts.focus;              // [x0, y0, x1, y1]: only blocks touching it (keeps a close-up cheap)
  const avenues = city.avenues || [];
  const street = city.street ?? 14;      // ft between blocks
  const out = [], opens = [];
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
    // No corner of a house in an avenue (a road is only a road if its edges are clean).
    for (const av of avenues) {
      const o = pts.map(([x, y]) => offAvenue({ x, y }, c, av.bearing)), h = (av.width ?? 40) / 2 + 3;
      if (o.some((v) => Math.abs(v) < h) || (Math.min(...o) < 0 && Math.max(...o) > 0 && o.every(Number.isFinite))) return null;
    }
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
      // Block lengths vary (±35%), so cross streets don't fall at an even beat round the ring.
      const cuts = Array.from({ length: n }, (_, j) => off + ((j + (rand() - 0.5) * 0.7) * 360) / n);
      for (let j = 0; j < n; j++) {
        const t0 = cuts[j], t1 = j + 1 < n ? cuts[j + 1] : cuts[0] + 360;
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
        // Density for this neighbourhood: 0 = sparse, 1 = packed. Sparse quarters leave more blocks open too.
        const dense = noise(city.seed ?? 1, centre.x, centre.y, city.grain ?? 700);
        const openP = (fab.open ?? 0) * (0.4 + 1.2 * (1 - dense));
        if (rand() < openP) {
          const pts = [P(ra, ta), P(ra, tb), P(rb, tb), P(rb, ta)];
          if (lotOK(pts, fab)) opens.push({ area: fab.area, pts });
          continue;
        }
        fillBlock({ ...fab, vacancy: Math.min(0.9, (fab.vacancy ?? 0.05) + (fab.patchy ?? 0) * (1 - dense) * 0.6) }, ra, rb, ta, tb);
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
        const w = Math.min(arc - s, front * (0.6 + rand() * 1.0));
        // Each house its own depth: the back line is ragged, and so the yards behind are.
        const dd = (r1 - r0) * (0.6 + rand() * 0.4), q0 = side === "outer" ? r1 - dd : r0, q1 = side === "outer" ? r1 : r0 + dd;
        const a0 = ta + (s / arc) * (tb - ta), a1 = ta + (Math.min(arc, s + w - gap) / arc) * (tb - ta);
        s += w;
        if (rand() < vac) continue;
        // A compound sits back from the street; a shed runs the whole block deep.
        const inset = kind === "compounds" ? 6 : 0;
        const pts = kind === "sheds" ? [P(r1, a0), P(r1, a1), P(r0, a1), P(r0, a0)]
          : side === "outer" ? [P(q1 - inset, a0), P(q1 - inset, a1), P(q0, a1), P(q0, a0)] : [P(q0 + inset, a0), P(q0 + inset, a1), P(q1, a1), P(q1, a0)];
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
  // The avenues as drawn roads: both edges, from the innermost band to the wall.
  const rIn = Math.min(...city.bands.map((b) => b.r0)), rOut = wall ? wall.shape.r0 : Math.max(...city.bands.map((b) => b.r1));
  const roads = avenues.map((av) => {
    const d = fromPolar(1, av.bearing, { x: 0, y: 0 }), nx = -d.y, ny = d.x, h = (av.width ?? 40) / 2;
    const at = (r, side) => [Math.round((c.x + d.x * r + nx * h * side) * 10) / 10, Math.round((c.y + d.y * r + ny * h * side) * 10) / 10];
    return { name: av.name, edges: [[at(rIn, 1), at(rOut, 1)], [at(rIn, -1), at(rOut, -1)]] };
  });
  return { buildings: out, opens, roads, blocks, stats };
}

/** The buildings as one SVG group (a path per kind, so a whole city stays a small file). */
export function citySvg(city, P, k) {
  const by = {};
  for (const b of city.buildings) (by[b.kind] ||= []).push(`M${b.pts.map((q) => q.join(" ")).join("L")}Z`);
  const fill = { houses: P.paper2, compounds: P.paper2, sheds: P.paper2 };
  const sw = (px) => (Math.round((px / k) * 100) / 100).toString();
  const open = (city.opens || []).map((o) => `M${o.pts.map((q) => q.join(" ")).join("L")}Z`).join("");
  const roads = (city.roads || []).flatMap((r) => r.edges.map(([a, b]) => `M${a.join(" ")}L${b.join(" ")}`)).join("");
  return `<g class="city">${open ? `<path d="${open}" fill="url(#stipple)" stroke="none" opacity="0.7"/>` : ""}${Object.entries(by).map(([kind, ds]) =>
    `<path d="${ds.join("")}" fill="${fill[kind] || P.paper2}" stroke="${P.faint}" stroke-width="${sw(kind === "houses" ? 0.5 : 0.7)}" stroke-linejoin="round"/>`).join("")}` +
    (roads ? `<path d="${roads}" fill="none" stroke="${P.faint}" stroke-width="${sw(1.1)}"/>` : "") + `</g>`;
}
