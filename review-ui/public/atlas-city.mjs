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
 *     plan    how the streets were laid (Russell, 2026-10-30: some of the city is ancient, "super uniform and laid out
 *             on a grid"; the slums and pockets are "haphazard sprawl"). Taken from real walled towns:
 *       "ring"   (default) blocks between the band's ring and cross streets.
 *       "grid"   the old planned grid (a Roman core like Florence's or Turin's, a bastide like Carcassonne's lower town):
 *                atlas.city.grid = { angle, block: [w, h], street }, one alignment for every grid area, as if they
 *                were all pieces of one older city. Identical blocks, houses round all four sides of each block
 *                (an insula), identical frontages; now and then one block is a single big building or an open square.
 *                Later roads (the avenues) and the area's own edge cut it cleanly.
 *       "sprawl" unplanned growth: cross streets run askew, ring streets kink and widen into little squares, some
 *                blocks are split by an alley, and lots are narrow and deep (medieval burgage plots ran about
 *                1 : 6, some 17 ft wide and 200 ft long).
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

/** A deterministic hash in [0, 1) for (seed, i, j): randomness that does not move the shared RNG. */
function hash3(seed, i, j) {
  let n = (i * 73856093) ^ (j * 19349663) ^ (seed * 83492791);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function shapeBox(sh) {
  if (sh.type === "polygon") {
    const xs = sh.points.map((q) => q.x), ys = sh.points.map((q) => q.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const r = sh.r ?? sh.r1;
  return [sh.cx - r, sh.cy - r, sh.cx + r, sh.cy + r];
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
  const gridAreas = (atlas.areas || []).filter((a) => a.fabric?.plan === "grid");
  const lotOK = (pts, fab) => {
    for (const [x, y] of pts) {
      if (wall && Math.hypot(x - c.x, y - c.y) > wall.shape.r0) return null;
      for (const a of reserved) if (pointInArea({ x, y }, a.shape)) return null;
      // The old grid and the newer streets don't share a lot: a grid house stays inside its own area, and nothing
      // else is built over the grid.
      if (gridAreas.length) {
        const inGrid = gridAreas.some((a) => pointInArea({ x, y }, a.shape));
        if (fab.plan === "grid") { if (!inGrid || fabricAt(atlas, { x, y })?.area !== fab.area) return null; }
        else if (inGrid && fabricAt(atlas, { x, y })?.plan === "grid") return null;
      }
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
      const half = ((street / 2) / rm) * (180 / Math.PI);
      const fabs = cuts.map((t0, j) => {
        const t1 = j + 1 < n ? cuts[j + 1] : cuts[0] + 360;
        return fabricAt(atlas, fromPolar(rm, (t0 + t1) / 2, c));
      });
      const sprawl = (j) => fabs[(j + n) % n]?.plan === "sprawl";
      // A cross street runs askew where sprawl lies on either side of it: the cut line turns by up to about a quarter of a
      // block's depth between the inner and outer ring. Both blocks share the same line, so they never overlap.
      const seed = (city.seed ?? 1) + Math.round(band.r0) + i * 7919;
      const skew = cuts.map((_, j) => (sprawl(j) || sprawl(j - 1)
        ? (hash3(seed, j, 1) - 0.5) * ((0.5 * (rb - ra)) / rm) * (180 / Math.PI) : 0));
      const cutAt = (j, r) => cuts[j % n] + (j >= n ? 360 : 0) + skew[j % n] * ((r - rm) / (rb - ra));
      for (let j = 0; j < n; j++) {
        const t0 = cuts[j], t1 = j + 1 < n ? cuts[j + 1] : cuts[0] + 360;
        const ta = t0 + half, tb = t1 - half;
        if (focus) {
          const q = P(rm, (ta + tb) / 2), pad = Math.max(len, depth);
          if (q[0] < focus[0] - pad || q[0] > focus[2] + pad || q[1] < focus[1] - pad || q[1] > focus[3] + pad) continue;
        }
        const centre = fromPolar(rm, (ta + tb) / 2, c);
        const fab = fabs[j];
        if (!fab || fab.reserved || fab.kind === "none" || fab.plan === "grid") continue;
        blocks++;
        // Density for this neighbourhood: 0 = sparse, 1 = packed. Sparse quarters leave more blocks open too.
        const dense = noise(city.seed ?? 1, centre.x, centre.y, city.grain ?? 700);
        const openP = (fab.open ?? 0) * (0.4 + 1.2 * (1 - dense));
        const fb = { ...fab, vacancy: Math.min(0.9, (fab.vacancy ?? 0.05) + (fab.patchy ?? 0) * (1 - dense) * 0.6) };
        if (fab.plan !== "sprawl") {
          if (rand() < openP) {
            const pts = [P(ra, ta), P(ra, tb), P(rb, tb), P(rb, ta)];
            if (lotOK(pts, fab)) opens.push({ area: fab.area, pts });
            continue;
          }
          fillBlock(fb, ra, rb, () => ta, () => tb);
          continue;
        }
        // Sprawl: the ring streets kink (each block's edges pulled in by its own amount, so the street widens into
        // a little square here and there), the cross streets are askew, and one block in three is split by an alley.
        const k0 = hash3(seed, j, 2), k1 = hash3(seed, j, 3);
        const sa = ra + (k0 < 0.3 ? k0 * 0.6 : 0.04) * (rb - ra), sb = rb - (k1 < 0.3 ? k1 * 0.6 : 0.04) * (rb - ra);
        const A = (r) => cutAt(j, r) + half, B = (r) => cutAt(j + 1, r) - half;
        if (rand() < openP) {
          const pts = [P(sa, A(sa)), P(sa, B(sa)), P(sb, B(sb)), P(sb, A(sb))];
          if (lotOK(pts, fab)) opens.push({ area: fab.area, pts });
          continue;
        }
        if (hash3(seed, j, 4) < 0.35 && tb - ta > 3 * half) {
          const m = ta + (tb - ta) * (0.3 + 0.4 * hash3(seed, j, 5)), w = (4 / rm) * (180 / Math.PI);
          fillBlock(fb, sa, sb, A, () => m - w);
          fillBlock(fb, sa, sb, () => m + w, B);
        } else fillBlock(fb, sa, sb, A, B);
      }
    }
  }

  // A block between rings ra..rb whose two ends are the lines A(r) and B(r) (degrees; constant for a ring block).
  function fillBlock(fab, ra, rb, A, B) {
    const [front, deep] = fab.lot || [25, 30];
    const gap = fab.gap ?? 0, vac = fab.vacancy ?? 0.05;
    const kind = fab.kind || "houses";
    const d = Math.min(deep, (rb - ra) / 2);
    const rows = kind === "sheds" ? [[ra + 4, rb - 4, "radial"]] : [[rb - d, rb, "outer"], [ra, ra + d, "inner"]];
    for (const [r0, r1, side] of rows) {
      const rm = (r0 + r1) / 2;
      const ta = A(rm), tb = B(rm);
      if (tb <= ta) continue;
      // Plot lines fan between the block's two ends (straight across a ring block; turned with an askew street).
      const at = (f, r) => A(r) + f * (B(r) - A(r));
      const arc = ((tb - ta) * Math.PI * rm) / 180;
      let s = 0;
      while (s < arc - front * 0.5) {
        const w = Math.min(arc - s, front * (0.6 + rand() * 1.0));
        // Each house its own depth: the back line is ragged, and so the yards behind are.
        const dd = (r1 - r0) * (0.6 + rand() * 0.4), q0 = side === "outer" ? r1 - dd : r0, q1 = side === "outer" ? r1 : r0 + dd;
        const f0 = s / arc, f1 = Math.min(arc, s + w - gap) / arc;
        s += w;
        if (rand() < vac) continue;
        // A compound sits back from the street; a shed runs the whole block deep.
        const inset = kind === "compounds" ? 6 : 0;
        const Q = (r, f) => P(r, at(f, r));
        const pts = kind === "sheds" ? [Q(r1, f0), Q(r1, f1), Q(r0, f1), Q(r0, f0)]
          : side === "outer" ? [Q(q1 - inset, f0), Q(q1 - inset, f1), Q(q0, f1), Q(q0, f0)] : [Q(q0 + inset, f0), Q(q0 + inset, f1), Q(q1, f1), Q(q1, f0)];
        const ok = lotOK(pts, fab);
        if (ok) out.push({ kind, area: ok.area, pts });
      }
    }
    // Radial ends of a long block close it off with a house or two facing the side streets (houses only).
    if (kind === "houses" && rb - ra > 2 * d + front) {
      for (const [end, sign] of [[A, 1], [B, -1]]) {
        const dt = ((front * 0.9) / ((ra + rb) / 2)) * (180 / Math.PI) * sign;
        for (let r = ra + d; r + front <= rb - d; r += front) {
          if (rand() < vac) continue;
          const t = sign > 0 ? Math.max(end(r), end(r + front - gap)) : Math.min(end(r), end(r + front - gap));
          const pts = [P(r, t), P(r + front - gap, t), P(r + front - gap, t + dt), P(r, t + dt)];
          const ok = lotOK(pts, fab);
          if (ok) out.push({ kind, area: ok.area, pts });
        }
      }
    }
  }

  // The old grid: one alignment across every grid area.
  const G = city.grid;
  if (G && gridAreas.length) {
    const ang = ((G.angle ?? 0) * Math.PI) / 180, cs = Math.cos(ang), sn = Math.sin(ang);
    const W = (u, v) => [Math.round((c.x + u * cs - v * sn) * 10) / 10, Math.round((c.y + u * sn + v * cs) * 10) / 10];
    const U = (x, y) => [(x - c.x) * cs + (y - c.y) * sn, -(x - c.x) * sn + (y - c.y) * cs];
    const [bw, bh] = G.block, st = G.street ?? street * 2, px = bw + st, py = bh + st;
    const seen = new Set();
    for (const a of gridAreas) {
      const [x0, y0, x1, y1] = shapeBox(a.shape);
      const uv = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => U(x, y));
      const [i0, i1] = [Math.floor(Math.min(...uv.map((q) => q[0])) / px), Math.ceil(Math.max(...uv.map((q) => q[0])) / px)];
      const [j0, j1] = [Math.floor(Math.min(...uv.map((q) => q[1])) / py), Math.ceil(Math.max(...uv.map((q) => q[1])) / py)];
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        if (seen.has(`${i},${j}`)) continue;
        const u0 = i * px + st / 2, v0 = j * py + st / 2, u1 = u0 + bw, v1 = v0 + bh;
        const [cx, cy] = W((u0 + u1) / 2, (v0 + v1) / 2);
        if (focus && (cx < focus[0] - px || cx > focus[2] + px || cy < focus[1] - py || cy > focus[3] + py)) continue;
        const fab = fabricAt(atlas, { x: cx, y: cy });
        if (!fab || fab.reserved || fab.plan !== "grid" || fab.kind === "none") continue;
        seen.add(`${i},${j}`);
        blocks++;
        const dense = noise(city.seed ?? 1, cx, cy, city.grain ?? 700);
        const rect = (a0, b0, a1, b1) => [W(a0, b0), W(a1, b0), W(a1, b1), W(a0, b1)];
        if (rand() < (fab.open ?? 0) * (0.4 + 1.2 * (1 - dense))) {
          const pts = rect(u0, v0, u1, v1);
          if (lotOK(pts, fab)) opens.push({ area: fab.area, pts });
          continue;
        }
        const vac = Math.min(0.9, (fab.vacancy ?? 0.05) + (fab.patchy ?? 0) * (1 - dense) * 0.6);
        if (rand() < 0.1) {   // one building the whole block: a hall, a bath, a barracks
          const pts = rect(u0 + 6, v0 + 6, u1 - 6, v1 - 6);
          const ok = rand() >= vac && lotOK(pts, fab);
          if (ok) out.push({ kind: "compounds", area: fab.area, pts });
          continue;
        }
        const [front, deep] = fab.lot || [30, 45];
        const d = Math.min(deep, bw / 2, bh / 2);
        const row = (a0, a1, b0, b1, along) => {   // equal frontages along one side
          const len = along === "u" ? a1 - a0 : b1 - b0, k = Math.max(1, Math.round(len / front)), w = len / k;
          for (let q = 0; q < k; q++) {
            if (rand() < vac) continue;
            const pts = along === "u" ? rect(a0 + q * w, b0, a0 + (q + 1) * w, b1) : rect(a0, b0 + q * w, a1, b0 + (q + 1) * w);
            const ok = lotOK(pts, fab);
            if (ok) out.push({ kind: fab.kind || "houses", area: fab.area, pts });
          }
        };
        row(u0, u1, v0, v0 + d, "u");
        row(u0, u1, v1 - d, v1, "u");
        if (bh > 2 * d + front * 0.5) { row(u0, u0 + d, v0 + d, v1 - d, "v"); row(u1 - d, u1, v0 + d, v1 - d, "v"); }
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
