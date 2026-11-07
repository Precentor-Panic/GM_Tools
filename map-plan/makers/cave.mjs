// The cave maker: chambers and passages from a brief, carved out of rock as one rough space. A river, ledges and rock
// pillars are drawn on top. Deterministic: the same spec and seed make the same cave.
//
// spec:
//   width, height                      map size in squares
//   chambers: [{id, at: [x, y], r, label?, sub?}]    r = rough radius; sub = how many lobes (default 6)
//   passages: [{a, b, width, wind?, via?}]   a, b = chamber ids, or [x, y] (a point off the map makes a mouth); wind 0..1;
//                                      via: waypoints [[x, y], ...] it must pass
//   river?:   {through: [id | [x, y], ...], width, depth?, ford?: id | [x, y], fordWidth?}
//             runs from wall to wall through those points; `ford` is a shallow crossing
//   ledges?:  [{chamber, toward: [x, y], height, ramp?: [x, y], rampWidth?, at?: 0..1}]
//             the part of a chamber toward a point is raised `height` feet; its edge is a ledge wall with a ramp gap
//   pillars?: [{at: [x, y], r}]        rock left standing
//   rockOctaves?                       noise on the rock edge ([[scale, weight], ...], squares)
//   camp?:    chamber id               where the camp goes (default the smallest chamber)
//   items?, lights?                    placed as given (plan items and lights), before the scatter
// Returns {canvas, plan} (plan from trace.mjs toPlan, with `links` and `trace` attached).
import { Canvas } from "./canvas.mjs";
import { toPlan } from "./trace.mjs";
import { rng, fbm } from "./rng.mjs";

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function segD(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return [Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t), t];
}
/** Distance from p to a polyline, and the arc position (0..1) of the nearest point. */
function polyD(p, P) {
  let best = Infinity, at = 0, run = 0;
  const lens = P.slice(1).map((q, i) => dist(P[i], q)), total = lens.reduce((s, v) => s + v, 0) || 1;
  for (let i = 1; i < P.length; i++) {
    const [d, t] = segD(p, P[i - 1], P[i]);
    if (d < best) { best = d; at = (run + t * lens[i - 1]) / total; }
    run += lens[i - 1];
  }
  return [best, at];
}

/** A wandering line from a to b: control points pushed sideways by noise, then smoothed. */
export function meander(a, b, amount, r, step = 0.5) {
  const L = dist(a, b), n = Math.max(2, Math.ceil(L / step));
  const nx = -(b[1] - a[1]) / (L || 1), ny = (b[0] - a[0]) / (L || 1);
  const k = 2 + r.int(0, 2), phase = r.range(0, Math.PI * 2), amp = amount * L * 0.12 * r.range(0.6, 1.2);
  const bend = r.range(-1, 1) * amount * L * 0.12;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, env = Math.sin(Math.PI * t);
    const off = env * (bend + amp * Math.sin(phase + t * Math.PI * k) * 0.6);
    const p = lerp(a, b, t);
    pts.push([p[0] + nx * off, p[1] + ny * off]);
  }
  return pts;
}

export function makeCave(spec, seed = 1) {
  const R = spec.R ?? 4;
  const cv = new Canvas(spec.width, spec.height, { R, voidKind: "rock" });
  const r = rng(seed);
  const at = (ref) => (Array.isArray(ref) ? ref : spec.chambers.find((c) => c.id === ref)?.at ?? (() => { throw new Error(`cave: no chamber ${ref}`); })());
  const floor = cv.region({ kind: "floor", key: "cave", organic: true, material: spec.material ?? "cave rock" });

  // 1. Lobes for each chamber, a meandering tube for each passage.
  const lobes = [];
  for (const c of spec.chambers) {
    const cr = r.fork(`chamber:${c.id}`);
    for (let i = 0; i < (c.sub ?? 6); i++) {
      const ox = cr.normal(0, c.r * 0.32), oy = cr.normal(0, c.r * 0.32), s = cr.range(0.55, 0.9);
      lobes.push({ c: [c.at[0] + ox, c.at[1] + oy], rx: c.r * s * cr.range(0.85, 1.2), ry: c.r * s * cr.range(0.75, 1.05), rot: cr.range(0, Math.PI) });
    }
    lobes.push({ c: c.at, rx: c.r * 0.7, ry: c.r * 0.7, rot: 0 });
  }
  // A passage can go by waypoints (`via`), so a loop keeps its own way round instead of drifting into another one.
  const tubes = spec.passages.map((p, i) => {
    const pr = r.fork(`passage:${i}`), stops = [at(p.a), ...(p.via ?? []), at(p.b)];
    const pts = stops.slice(1).flatMap((q, k) => meander(stops[k], q, p.wind ?? 0.5, pr.fork(`leg:${k}`)).slice(k ? 1 : 0));
    return { pts, w: p.width, seed: (pr.next() * 1e9) | 0 };
  });
  const octaves = spec.rockOctaves ?? [[3, 1], [1.3, 0.55], [0.55, 0.3]];
  const noiseSeed = (r.fork("noise").next() * 1e9) | 0;
  const field = (x, y) => {
    let f = -1;
    for (const L of lobes) {
      const dx = x - L.c[0], dy = y - L.c[1], cs = Math.cos(L.rot), sn = Math.sin(L.rot);
      const u = (dx * cs + dy * sn) / L.rx, v = (-dx * sn + dy * cs) / L.ry;
      f = Math.max(f, 1 - Math.hypot(u, v));
    }
    for (const t of tubes) {
      const [d, s] = polyD([x, y], t.pts);
      const half = (t.w / 2) * (0.85 + 0.35 * fbm(s * 40, 0, [[3, 1]], t.seed));
      f = Math.max(f, 1 - d / Math.max(0.3, half));
    }
    return f + 0.55 * (fbm(x, y, octaves, noiseSeed) - 0.5);
  };
  cv.paintWhere((x, y) => field(x, y) > 0, floor);
  // 2. Cores: a passage can't pinch shut and a chamber can't fill in, whatever the noise did.
  for (const t of tubes) cv.paintWhere((x, y) => polyD([x, y], t.pts)[0] <= t.w * 0.36, floor);
  for (const c of spec.chambers) cv.paint({ circle: [c.at[0], c.at[1], c.r * 0.45] }, floor, { guides: false });
  // 3. Clean up: rounded rock, one connected cave, no specks of rock smaller than a square and a half.
  cv.majority(floor, 0, 2);
  const parts = cv.components((v) => v === floor);
  for (const p of parts.slice(1)) for (const c of p.cells) cv.lab[c] = 0;
  for (const h of cv.components((v) => v === 0)) {
    if (h.size / (R * R) >= 1.5) continue;
    const touches = h.cells.some((c) => { const x = c % cv.W, y = (c - x) / cv.W; return x === 0 || y === 0 || x === cv.W - 1 || y === cv.H - 1; });
    if (!touches) for (const c of h.cells) cv.lab[c] = floor;
  }
  // 4. Pillars of rock left standing.
  for (const p of spec.pillars ?? []) {
    const pr = r.fork(`pillar:${p.at}`), ps = (pr.next() * 1e9) | 0;
    cv.paintWhere((x, y, v) => v === floor && Math.hypot(x - p.at[0], y - p.at[1]) < p.r * (0.8 + 0.4 * fbm(x, y, [[0.8, 1]], ps)), 0,
      [p.at[0] - p.r * 1.3, p.at[1] - p.r * 1.3, p.at[0] + p.r * 1.3, p.at[1] + p.r * 1.3]);
  }

  // 5. Ledges: a raised part of a chamber, cut off by a wavy line across it.
  const edges = [], links = [], areas = [], marks = [], items = [];
  for (const [i, L] of (spec.ledges ?? []).entries()) {
    const c = spec.chambers.find((x) => x.id === L.chamber), lr = r.fork(`ledge:${i}`), ls = (lr.next() * 1e9) | 0;
    const dir = [L.toward[0] - c.at[0], L.toward[1] - c.at[1]], len = Math.hypot(...dir), u = [dir[0] / len, dir[1] / len];
    const cut = (L.at ?? 0.15) * c.r; // how far past the centre the edge runs
    const id = cv.region({ kind: "floor", key: `ledge-${i}`, organic: true, label: L.label ?? "ledge", material: spec.material ?? "cave rock" });
    const reach = c.r * 1.25;
    cv.paintWhere((x, y, v) => {
      if (v !== floor) return false;
      const s = (x - c.at[0]) * u[0] + (y - c.at[1]) * u[1], side = -(x - c.at[0]) * u[1] + (y - c.at[1]) * u[0];
      return Math.hypot(x - c.at[0], y - c.at[1]) < reach && s > cut + 0.9 * (fbm(side, 0, [[2.5, 1], [1, 0.4]], ls) - 0.5);
    }, id, [c.at[0] - reach, c.at[1] - reach, c.at[0] + reach, c.at[1] + reach]);
    // Only the ledge's own piece next to the chamber counts; bits that leaked into a passage go back to the floor.
    const comps = cv.components((v) => v === id);
    for (const p of comps.slice(1)) for (const k of p.cells) cv.lab[k] = floor;
    // The drop is the wavy line across the chamber; where the raised part meets a passage at the chamber's rim, the
    // floor slopes up and there is no edge.
    edges.push({ a: `ledge-${i}`, b: "cave", kind: "ledge", along: (x, y) => Math.hypot(x - c.at[0], y - c.at[1]) < reach - 0.4 });
    if (L.ramp) links.push({ a: `ledge-${i}`, b: "cave", kind: "arch", width: L.rampWidth ?? 2, at: L.ramp });
    L._id = id; L._height = L.height ?? 10;
  }

  // 6. The river: wall to wall through the given points, on its own layer (water is not a wall).
  let river = null;
  if (spec.river) {
    const rr = r.fork("river"), pts = spec.river.through.map(at);
    // Run it on past the first and last point, so it enters and leaves through the rock.
    const ext = (p, q) => { const d = dist(p, q) || 1; return [p[0] + ((p[0] - q[0]) / d) * 6, p[1] + ((p[1] - q[1]) / d) * 6]; };
    const full = [ext(pts[0], pts[1]), ...pts, ext(pts[pts.length - 1], pts[pts.length - 2])];
    const line = full.slice(1).flatMap((q, i) => meander(full[i], q, 0.35, rr.fork(`leg:${i}`)).slice(i ? 1 : 0));
    const ws = (rr.next() * 1e9) | 0, w = spec.river.width;
    const wet = new Canvas(spec.width, spec.height, { R, voidKind: "ground" });
    const deep = wet.region({ kind: "floor", key: "water", organic: true });
    const ford = spec.river.ford ? wet.region({ kind: "floor", key: "ford", organic: true }) : null;
    const fordAt = spec.river.ford ? at(spec.river.ford) : null;
    wet.paintWhere((x, y) => {
      const v = cv.at(x, y);
      if (v !== floor && !(v > floor)) return false; // water only over open floor
      const [d, s] = polyD([x, y], line);
      return d < (w / 2) * (0.85 + 0.3 * fbm(s * 30, 1, [[2, 1]], ws));
    }, deep);
    // The river is one piece; the ford is a shallow patch laid over it (the art draws the ford by its stones).
    for (const a of toPlan(wet, {}).areas) if (a.kind === "floor") areas.push({ id: `river-${areas.length}`, kind: "water", shape: a.shape, depth: spec.river.depth ?? "deep", label: "river" });
    if (fordAt) {
      wet.paintWhere((x, y, v) => v === deep && Math.hypot(x - fordAt[0], y - fordAt[1]) < (spec.river.fordWidth ?? 2.5) / 2 + 0.6, ford);
      for (const a of toPlan(wet, {}).areas) if (a.id === "ford") areas.push({ id: "ford", kind: "water", shape: a.shape, depth: "shallow", label: "ford" });
    }
    river = { line, wet };
  }

  // 7. Dressing: rocks against the walls, stalagmites in the big chambers, a camp in the smallest, fungus near the
  // water, stepping stones over the ford, daylight at the mouth.
  const lights = [...(spec.lights ?? [])];
  const rockD = cv.distanceInside((v) => v > 0);
  const wetAt = (x, y) => river && river.wet.at(x, y) > 0;
  const taken = [];
  const free = (x, y, rad) => !taken.some(([tx, ty, tr]) => Math.hypot(tx - x, ty - y) < tr + rad);
  const spots = (c, n, dmin, dmax, rad, put, rr) => {
    const cand = [];
    for (let y = c.at[1] - c.r * 1.3; y <= c.at[1] + c.r * 1.3; y += 0.5) for (let x = c.at[0] - c.r * 1.3; x <= c.at[0] + c.r * 1.3; x += 0.5) {
      const k = cv.cell(x, y);
      if (k < 0 || cv.lab[k] === 0 || rockD[k] < dmin || rockD[k] > dmax || wetAt(x, y)) continue;
      cand.push([x, y]);
    }
    let made = 0;
    for (const [x, y] of rr.shuffle(cand)) { if (made >= n) break; if (!free(x, y, rad)) continue; put(x, y); taken.push([x, y, rad]); made++; }
  };
  for (const it of spec.items ?? []) { items.push({ ...it }); taken.push([it.x, it.y, (it.size ?? 1) * 0.6]); }
  const byArea = [...spec.chambers].sort((p, q) => q.r - p.r), camp = spec.camp ?? byArea[byArea.length - 1]?.id;
  for (const c of spec.chambers) {
    const dr = r.fork(`dress:${c.id}`);
    if (c.id === camp) {
      items.push({ what: "campfire", x: c.at[0], y: c.at[1], size: 1.2 });
      lights.push({ x: c.at[0], y: c.at[1], bright: 2, dim: 6, color: "#ff9a4a" });
      taken.push([c.at[0], c.at[1], 1.6]);
      spots(c, 3, 0.7, 2.5, 0.9, (x, y) => items.push({ what: "bedroll", x, y, size: 1.8, rotation: Math.round(Math.atan2(y - c.at[1], x - c.at[0]) * 180 / Math.PI) + 90 }), dr);
      spots(c, 2, 0.5, 1.5, 0.6, (x, y) => items.push({ what: dr.pick(["bones", "crate", "sack"]), x, y, size: 1, rotation: dr.int(0, 359) }), dr);
    }
    spots(c, Math.round(c.r * 0.8), 0.35, 1.2, 0.7, (x, y) => items.push({ what: dr.chance(0.4) ? "boulder" : "rock", x, y, size: +dr.range(0.8, 1.8).toFixed(2), rotation: dr.int(0, 359) }), dr);
    if (c.r >= 5) spots(c, 3, 1.2, 3, 0.5, (x, y) => items.push({ what: "stalagmite", x, y, size: +dr.range(0.6, 1.1).toFixed(2), rotation: dr.int(0, 359) }), dr);
  }
  if (river) {
    // Fungus where it's damp: along the banks.
    const fr = r.fork("fungus");
    for (let i = 0, made = 0; i < river.line.length && made < 6; i += 7) {
      const [x, y] = river.line[i], off = fr.pick([-1, 1]) * (spec.river.width / 2 + 0.8);
      const px = x + off * fr.range(0.6, 1.2), py = y + fr.range(-0.5, 0.5);
      const k = cv.cell(px, py);
      if (k < 0 || cv.lab[k] === 0 || wetAt(px, py) || !free(px, py, 0.5)) continue;
      items.push({ what: "mushrooms", x: px, y: py, size: 0.8 }); lights.push({ x: px, y: py, bright: 0, dim: 2, color: "#7fe0c0" }); taken.push([px, py, 0.5]); made++;
    }
    if (spec.river.ford) {
      const [fx, fy] = at(spec.river.ford), i = river.line.reduce((bi, p, k) => (dist(p, [fx, fy]) < dist(river.line[bi], [fx, fy]) ? k : bi), 0);
      const a = river.line[Math.max(0, i - 1)], c2 = river.line[Math.min(river.line.length - 1, i + 1)], L = dist(a, c2) || 1;
      const n = [-(c2[1] - a[1]) / L, (c2[0] - a[0]) / L];
      const sr = r.fork("ford");
      for (const t of [-1.2, -0.4, 0.4, 1.2]) items.push({ what: "stepping stone", x: fx + n[0] * t, y: fy + n[1] * t, size: 0.85, rotation: sr.int(0, 359) });
    }
  }
  for (const p of spec.passages) if (Array.isArray(p.a) && (p.a[0] < 0 || p.a[1] < 0 || p.a[0] > spec.width || p.a[1] > spec.height)) {
    const m = at(p.b), e = [Math.min(spec.width - 0.5, Math.max(0.5, p.a[0])), Math.min(spec.height - 0.5, Math.max(0.5, p.a[1]))];
    lights.push({ x: (e[0] * 2 + m[0]) / 3, y: (e[1] * 2 + m[1]) / 3, bright: 3, dim: 9, color: "#c8d8ff" });
    marks.push({ kind: "entrance", x: e[0], y: e[1], label: "cave mouth" });
  }
  const plan = toPlan(cv, { name: spec.name, links, edges, areas, marks, items, lights, brief: spec.brief, source: { kind: "maker", ref: `cave:${seed}` } });
  for (const L of spec.ledges ?? []) {
    const a = plan.areas.find((x) => x.id === `ledge-${(spec.ledges ?? []).indexOf(L)}`);
    if (a) { a.kind = "ledge"; a.height = L._height; }
  }
  return { canvas: cv, plan, river };
}
