// From a canvas of labels (canvas.mjs) to a plan (plan.mjs): walls along the edges between regions, floor outlines,
// and openings cut where the maker linked two regions.
//
//   1. Every cell edge with different labels on its two sides is a boundary edge. Lattice points where the boundary
//      branches or ends are NODES; the boundary between two nodes is a CHAIN, with one label on each side. A chain is
//      simplified once, so the two regions it separates share exactly the same outline.
//   2. Simplifying: points near a guide (an exact line or arc the maker painted) snap onto it, so masonry comes out
//      true; points on rough (organic) chains are smoothed instead; then Douglas-Peucker drops what's left over.
//   3. Walls: a chain is a wall unless both sides are open ground, both are solid, one side is off the map, or the
//      maker opened it. Links cut doors, arches and windows into a chain's straight stretches.
//   4. Areas: each region's outline, put together from its chains; rock islands inside a floor become solid areas.
import { parsePlan } from "../plan.mjs";

const OUT = -1;

/** Region kind for a label: "floor" | "ground" | "solid" | "rock" (the void round a dungeon) | "out" (off the map). */
function kindOf(cv, id) {
  if (id === OUT) return "out";
  return cv.info(id).kind;
}

/** What a chain between labels a and b is: "wall" or null (no wall). */
export function wallBetween(cv, a, b) {
  if (a === b) return null;
  const ka = kindOf(cv, a), kb = kindOf(cv, b);
  if (ka === "out" || kb === "out") return null;
  const ra = a > 0 ? cv.info(a) : null, rb = b > 0 ? cv.info(b) : null;
  if (ra?.walls === false || rb?.walls === false) return null;
  const hard = (k) => k === "solid" || k === "rock";
  if (hard(ka) && hard(kb)) return null;
  if (ka === "ground" && kb === "ground") return null;
  return "wall";
}

// ---------- 1. chains ----------

function boundaryChains(cv) {
  const { W, H, lab } = cv, VW = W + 1;
  const L = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? OUT : lab[y * W + x]);
  // Edges: e = [u, v, left, right] with u -> v a unit step on the lattice; "left" per y-down screen axes.
  const adj = new Map(); // vertex -> [edge index]
  const edges = [];
  const add = (u, v, l, r) => {
    const i = edges.length;
    edges.push([u, v, l, r]);
    (adj.get(u) ?? adj.set(u, []).get(u)).push(i);
    (adj.get(v) ?? adj.set(v, []).get(v)).push(i);
  };
  for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) {
    const top = L(x, y - 1), bot = L(x, y);
    if (top !== bot) add(y * VW + x, y * VW + x + 1, top, bot); // moving +x: left is the cell above
  }
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) {
    const lft = L(x - 1, y), rgt = L(x, y);
    if (lft !== rgt) add(y * VW + x, (y + 1) * VW + x, rgt, lft); // moving +y: left is the cell to the east
  }
  const isNode = (v) => adj.get(v).length !== 2;
  const used = new Uint8Array(edges.length), chains = [];
  const walk = (start, ei) => {
    const verts = [start];
    let cur = start, e = ei;
    const [u0, , l0, r0] = edges[ei];
    const fwd = u0 === start;
    const left = fwd ? l0 : r0, right = fwd ? r0 : l0;
    for (;;) {
      used[e] = 1;
      const [u, v] = edges[e];
      cur = u === cur ? v : u;
      verts.push(cur);
      if (cur === start || isNode(cur)) break;
      e = adj.get(cur).find((i) => !used[i]);
      if (e === undefined) break;
    }
    chains.push({ verts, left, right });
  };
  for (const [v, list] of adj) if (isNode(v)) for (const ei of list) if (!used[ei]) walk(v, ei);
  // Closed loops with no node (an island): start at their smallest vertex so the result doesn't depend on order.
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    walk(Math.min(edges[i][0], edges[i][1]), adj.get(Math.min(edges[i][0], edges[i][1])).find((k) => !used[k]));
  }
  return { chains, VW, edges, adj };
}

// ---------- 2. simplifying ----------

function snapper(cv, tol) {
  const lines = [], arcs = [];
  for (const g of cv.guides) (g.line ? lines : arcs).push(g.line ?? g.ellipse);
  return ([px, py]) => {
    let best = null, bd = tol;
    for (const [ax, ay, bx, by] of lines) {
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = ((px - ax) * dx + (py - ay) * dy) / L2;
      if (t < -tol / Math.sqrt(L2) || t > 1 + tol / Math.sqrt(L2)) continue;
      const tc = Math.max(0, Math.min(1, t)), qx = ax + dx * tc, qy = ay + dy * tc, d = Math.hypot(px - qx, py - qy);
      if (d < bd || (d === bd && best?.arc)) { bd = d; best = { p: [qx, qy], arc: false }; }
    }
    for (const [cx, cy, rx, ry] of arcs) {
      const k = Math.sqrt(((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2);
      if (!k) continue;
      const qx = cx + (px - cx) / k, qy = cy + (py - cy) / k, d = Math.hypot(px - qx, py - qy);
      if (d < bd) { bd = d; best = { p: [qx, qy], arc: true }; }
    }
    return best;
  };
}

function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    let md = -1, mk = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDistance(pts[k], ax, ay, bx, by);
      if (d > md) { md = d; mk = k; }
    }
    if (md > tol) { keep[mk] = 1; stack.push([i, mk], [mk, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
function segDistance([px, py], ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** One chain's lattice vertices -> simplified points in squares. */
function simplifyChain(cv, verts, VW, snap, organic) {
  const R = cv.R;
  let pts = verts.map((v) => [(v % VW) / R, Math.floor(v / VW) / R]);
  const closed = verts.length > 2 && verts[0] === verts[verts.length - 1];
  const fixed = pts.map((_, i) => i === 0 || i === pts.length - 1);
  const onArc = pts.map(() => false);
  if (!organic) {
    pts = pts.map((p, i) => { const s = snap(p); if (s) { fixed[i] = true; onArc[i] = s.arc; return s.p; } return p; });
  } else {
    // Laplacian smoothing of the free points: the cell staircase becomes a rounded line. Ends stay put so chains meet;
    // a closed loop (an island, a cave with nothing else in it) is smoothed all round.
    const n = pts.length;
    for (let it = 0; it < 4; it++) {
      const next = pts.map((p) => [...p]);
      for (let i = closed ? 0 : 1; i < (closed ? n - 1 : n - 1); i++) {
        if (!closed && fixed[i]) continue;
        const a = pts[closed ? (i - 1 + n - 1) % (n - 1) : i - 1], b = pts[i + 1];
        next[i] = [(a[0] + 2 * pts[i][0] + b[0]) / 4, (a[1] + 2 * pts[i][1] + b[1]) / 4];
      }
      if (closed) next[n - 1] = [...next[0]];
      pts = next;
    }
  }
  // Drop repeats left by snapping.
  const ded = [pts[0]], arcOf = [onArc[0]];
  for (let i = 1; i < pts.length; i++) {
    const q = ded[ded.length - 1];
    if (Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]) < 1e-6 && i !== pts.length - 1) continue;
    ded.push(pts[i]); arcOf.push(onArc[i]);
  }
  // Douglas-Peucker in runs: arcs keep a close tolerance (round towers stay round), the rest a loose one.
  const tolArc = 0.02, tol = organic ? 0.55 / R : 0.8 / R;
  const out = [ded[0]];
  for (let s = 0; s < ded.length - 1;) {
    let e = s;
    while (e + 1 < ded.length - 1 && arcOf[e + 1] === arcOf[s]) e++;
    const run = douglasPeucker(ded.slice(s, e + 2), arcOf[s] ? tolArc : tol); // through the next run's first point
    out.push(...run.slice(1));
    s = e + 1;
  }
  if (closed && out.length > 2) out[out.length - 1] = out[0];
  return out;
}

// ---------- 3. openings ----------

const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const cumLen = (pts) => { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + segLen(pts[i - 1], pts[i])); return c; };
function pointAt(pts, cum, t) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < t) i++;
  const a = pts[i - 1], b = pts[i], L = cum[i] - cum[i - 1] || 1, u = (t - cum[i - 1]) / L;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}
/** Arc lengths of the chain's corners: turns sharper than `deg` degrees. */
function corners(pts, cum, deg = 30) {
  const out = [];
  const closed = pts.length > 3 && segLen(pts[0], pts[pts.length - 1]) < 1e-6;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]), t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(t2 - t1); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > (deg * Math.PI) / 180) out.push(cum[i]);
  }
  if (closed) out.push(0, cum[cum.length - 1]); else out.push(0, cum[cum.length - 1]); // the chain's own ends
  return out;
}

/**
 * Where to cut an opening `width` wide into chain points, by distance along the chain: on a stretch that is straight
 * (or gently curved, like a tower's wall) for the whole width, `margin` clear of any corner, nearest `at` (else the
 * middle of the longest clear stretch). Returns {t0, t1, d} or null.
 */
function placeCut(pts, width, at, margin = 0.25, gap = false) {
  // A gap (an arch, a ramp) can sit on a rough wall; a door or window wants a straight one.
  const cum = cumLen(pts), total = cum[cum.length - 1], cs = corners(pts, cum, gap ? 60 : 30);
  let best = null;
  for (let c = margin + width / 2; c <= total - margin - width / 2 + 1e-9; c += 0.0625) {
    const t0 = c - width / 2, t1 = c + width / 2;
    if (cs.some((k) => k > t0 - margin + 1e-9 && k < t1 + margin - 1e-9)) continue;
    const p0 = pointAt(pts, cum, t0), p1 = pointAt(pts, cum, t1);
    if (segLen(p0, p1) < 0.9 * width) continue;
    const m = pointAt(pts, cum, c);
    const d = at ? Math.hypot(m[0] - at[0], m[1] - at[1]) : -Math.min(...cs.map((k) => Math.abs(k - c)));
    if (!best || d < best.d - 1e-9) best = { t0, t1, d };
  }
  return best;
}

/** Split chain points at cuts [{t0, t1, kind, ...}] (distances along the chain) into runs: {pts, cut?}. */
function splitAtCuts(pts, cuts) {
  const cum = cumLen(pts), order = [...cuts].sort((p, q) => p.t0 - q.t0), out = [];
  let from = 0;
  const run = (a, b) => {
    const r = [pointAt(pts, cum, a)];
    for (let i = 1; i < pts.length - 1; i++) if (cum[i] > a + 1e-9 && cum[i] < b - 1e-9) r.push(pts[i]);
    r.push(pointAt(pts, cum, b));
    return r;
  };
  for (const c of order) {
    if (c.t0 > from + 1e-6) out.push({ pts: run(from, c.t0) });
    out.push({ pts: run(c.t0, c.t1), cut: c });
    from = c.t1;
  }
  if (cum[cum.length - 1] > from + 1e-6) out.push({ pts: run(from, cum[cum.length - 1]) });
  return out;
}

// ---------- 4. rings ----------

/** Outlines of region `id` from the lattice, region on the left, turning left at a pinch (4-connected). */
function regionRings(cv, id, VW) {
  const { W, H, lab } = cv;
  const L = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? OUT : lab[y * W + x]);
  const out = new Map(); // vertex -> [next vertex]
  const add = (u, v) => (out.get(u) ?? out.set(u, []).get(u)).push(v);
  for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) {
    const top = L(x, y - 1), bot = L(x, y);
    if (top === bot) continue;
    if (top === id) add(y * VW + x, y * VW + x + 1);
    else if (bot === id) add(y * VW + x + 1, y * VW + x);
  }
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) {
    const lft = L(x - 1, y), rgt = L(x, y);
    if (lft === rgt) continue;
    if (rgt === id) add(y * VW + x, (y + 1) * VW + x);
    else if (lft === id) add((y + 1) * VW + x, y * VW + x);
  }
  const xy = (v) => [v % VW, Math.floor(v / VW)];
  const rings = [];
  const keys = [...out.keys()].sort((a, b) => a - b);
  for (const s of keys) {
    while (out.get(s)?.length) {
      const ring = [s];
      let prev = s, cur = out.get(s).shift();
      while (cur !== s) {
        ring.push(cur);
        const opts = out.get(cur);
        let nxt;
        if (opts.length === 1) nxt = opts.shift();
        else {
          // Turn left first: keeps two cells that only touch at a corner apart.
          const [px, py] = xy(prev), [cx, cy] = xy(cur), dx = cx - px, dy = cy - py;
          const leftDir = [dy, -dx];
          const k = opts.findIndex((o) => { const [ox, oy] = xy(o); return ox - cx === leftDir[0] && oy - cy === leftDir[1]; });
          nxt = opts.splice(k >= 0 ? k : 0, 1)[0];
        }
        prev = cur; cur = nxt;
      }
      rings.push(ring);
    }
  }
  return rings;
}

const signedArea = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]; s += x0 * y1 - x1 * y0; } return s / 2; };

// ---------- the whole trace ----------

/**
 * Trace a canvas. Returns { chains: [{pts, left, right, wall}], rings: Map<label, [{pts, hole, others}]> }, where
 * `others` are the labels across a ring's chains (to tell a rock island from a pillar region).
 */
export function trace(cv) {
  const { chains, VW } = boundaryChains(cv);
  const snap = snapper(cv, 1.0 / cv.R);
  const organic = (id) => id > 0 && !!cv.info(id).organic || (id === 0 && cv.voidKind === "rock" && cv.organicRock !== false);
  const byStart = new Map();
  const out = chains.map((c, i) => {
    const org = organic(c.left) || organic(c.right);
    const pts = simplifyChain(cv, c.verts, VW, snap, org);
    const ch = { i, pts, left: c.left, right: c.right, wall: wallBetween(cv, c.left, c.right), verts: c.verts };
    byStart.set(`${c.verts[0]}>${c.verts[1]}`, { ch, fwd: true });
    byStart.set(`${c.verts[c.verts.length - 1]}>${c.verts[c.verts.length - 2]}`, { ch, fwd: false });
    return ch;
  });
  const nodes = new Set(chains.flatMap((c) => [c.verts[0], c.verts[c.verts.length - 1]]));
  const rings = new Map();
  for (let id = 1; id < cv.regions.length; id++) {
    const list = [];
    for (const ring of regionRings(cv, id, VW)) {
      // Rotate the ring to start at a node, then replace each node-to-node stretch with its simplified chain.
      let s = ring.findIndex((v) => nodes.has(v));
      const pts = [], others = new Set();
      if (s < 0) s = ring.indexOf(Math.min(...ring));
      const n = ring.length;
      let i = s, guard = 0;
      do {
        const hit = byStart.get(`${ring[i]}>${ring[(i + 1) % n]}`);
        if (!hit) { i = (i + 1) % n; continue; }
        const cp = hit.fwd ? hit.ch.pts : [...hit.ch.pts].reverse();
        pts.push(...cp.slice(0, -1));
        others.add(hit.ch.left === id ? hit.ch.right : hit.ch.left);
        i = (i + hit.ch.verts.length - 1) % n;
      } while (i !== s && ++guard < n + 5);
      if (pts.length < 3) continue;
      list.push({ pts, hole: signedArea(pts) > 0, others: [...others] }); // region-on-left in y-down axes winds negative
    }
    rings.set(id, list);
  }
  return { chains: out, rings };
}

// ---------- to a plan ----------

const LINK_KINDS = ["door", "arch", "open", "window", "secret"];
// What a wall of each kind stops, when an `edges` entry names only the kind.
const EDGE_KINDS = { wall: [true, true], ledge: [true, false], window: [true, false], terrain: [true, true], low: [false, false] };

/**
 * A plan from a canvas and the maker's extras.
 *   links:  [{a, b, kind, width?, at?, closed?, optional?}]  a and b are region keys ("void" for the void round it);
 *           kind is door | arch (a gap) | open (no wall at all between them) | window | secret. Default widths: door 1,
 *           arch 2. An optional link (a window) is left out when no wall has room for it.
 *   edges:  [{a, b, kind, move?, sight?, where?, along?}]  the boundary between regions a and b is this kind of wall
 *           instead (a ledge's edge, a hedge round a garden); kind "none" leaves it unwalled. `where(points)` limits it
 *           to some of the chains between them; `along(x, y)` to the stretches where it holds (the rest is unwalled).
 *           Links can still cut it (a ramp up a ledge).
 *   walls:  extra polylines (counters, fences) in plan form
 *   areas, lights, marks, items: plan form, added as given
 * Returns the plan, plus `trace` (chains, rings) and `cuts` (where each link went) as non-plan fields.
 */
export function toPlan(cv, { name, links = [], edges = [], walls = [], areas = [], lights = [], marks = [], items = [], brief, source } = {}) {
  const T = trace(cv);
  const id = (k) => { if (k === "void") return 0; const v = cv.byKey(k); if (v == null) throw new Error(`link: no region ${k}`); return v; };
  const between = (a, b) => T.chains.filter((c) => (c.left === a && c.right === b) || (c.left === b && c.right === a));
  for (const e of edges) {
    if (e.kind !== "none" && !EDGE_KINDS[e.kind]) throw new Error(`edge ${e.a}-${e.b}: kind ${e.kind}`);
    const [mv, st] = EDGE_KINDS[e.kind] ?? [false, false];
    // `along(x, y)`: the kind holds only where it's true, tested at each segment's middle; a chain that crosses over is
    // split there (a ledge's drop that runs on round a chamber's rim, where the floor slopes up instead).
    if (e.along) {
      for (const c of between(id(e.a), id(e.b))) {
        if (c.split) continue;
        const runs = [];
        for (let i = 1; i < c.pts.length; i++) {
          const m = [(c.pts[i - 1][0] + c.pts[i][0]) / 2, (c.pts[i - 1][1] + c.pts[i][1]) / 2], on = !!e.along(m[0], m[1]);
          if (runs.length && runs[runs.length - 1].on === on) runs[runs.length - 1].pts.push(c.pts[i]);
          else runs.push({ on, pts: [c.pts[i - 1], c.pts[i]] });
        }
        c.split = true; c.wall = null;
        for (const run of runs) T.chains.push({ ...c, i: T.chains.length, pts: run.pts, split: true,
          ...(run.on ? (e.kind === "none" ? { wall: null } : { wall: e.kind, move: e.move ?? mv, sight: e.sight ?? st }) : { wall: null }) });
      }
      continue;
    }
    for (const c of between(id(e.a), id(e.b))) {
      if (e.where && !e.where(c.pts)) continue;
      if (e.kind === "none") { c.wall = null; continue; }
      c.wall = e.kind; c.move = e.move ?? mv; c.sight = e.sight ?? st;
    }
  }
  const cuts = new Map(T.chains.map((c) => [c.i, []]));
  const opened = new Set(), placed = [];
  for (const l of links) {
    if (!LINK_KINDS.includes(l.kind)) throw new Error(`link ${l.a}-${l.b}: kind ${l.kind}`);
    const cs = between(id(l.a), id(l.b));
    if (!cs.length && l.optional) continue;
    if (!cs.length) throw new Error(`link ${l.a}-${l.b}: the two regions don't touch`);
    if (l.kind === "open") { for (const c of cs) opened.add(c.i); placed.push({ ...l, ok: true }); continue; }
    const width = l.width ?? (l.kind === "arch" ? 2 : 1);
    let best = null;
    for (const c of cs) {
      if (!c.wall) continue;
      const p = placeCut(c.pts, width, l.at, l.margin ?? 0.25, l.kind === "arch");
      if (!p) continue;
      const clash = cuts.get(c.i).some((q) => p.t0 < q.t1 + 0.25 && q.t0 < p.t1 + 0.25);
      if (clash) continue;
      if (!best || p.d < best.p.d) best = { c, p };
    }
    if (!best && l.optional) continue; // a window that doesn't fit is left out
    if (!best) throw new Error(`link ${l.a}-${l.b} (${l.kind}, ${width} wide): no straight wall long enough between them`);
    cuts.get(best.c.i).push({ ...best.p, kind: l.kind, closed: l.closed, link: l });
    const cum = cumLen(best.c.pts);
    placed.push({ ...l, ok: true, width, ends: [pointAt(best.c.pts, cum, best.p.t0), pointAt(best.c.pts, cum, best.p.t1)] });
  }
  // What each wall is made of: a cave's own rock; a solid mass's material; a partition between two rooms; or the
  // building's outside wall. A region's `wall` names its own.
  const material = (c) => {
    const ra = c.left > 0 ? cv.info(c.left) : null, rb = c.right > 0 ? cv.info(c.right) : null;
    if ((c.left === 0 || c.right === 0) && cv.voidKind === "rock") return cv.organicRock ? "rock" : (ra?.wall ?? rb?.wall ?? cv.outerWall);
    const solid = [ra, rb].find((r) => r?.kind === "solid");
    if (solid) return solid.wall ?? solid.material ?? "stone";
    if (ra?.kind === "floor" && rb?.kind === "floor") return ra.innerWall ?? rb.innerWall ?? cv.innerWall;
    return (ra?.kind === "floor" ? ra : rb)?.wall ?? cv.outerWall;
  };
  const planWalls = [];
  for (const c of T.chains) {
    if (!c.wall || opened.has(c.i)) continue;
    const mat = material(c);
    for (const run of splitAtCuts(c.pts, cuts.get(c.i))) {
      if (!run.cut) {
        planWalls.push(c.wall === "wall" ? { points: run.pts, kind: "wall", material: mat } : { points: run.pts, kind: c.wall, move: c.move, sight: c.sight, material: mat });
        continue;
      }
      const k = run.cut.kind;
      // A door or a window is straight, end to end, even on a curved wall.
      const ends = [run.pts[0], run.pts[run.pts.length - 1]];
      if (k === "door") planWalls.push({ points: ends, kind: "door", closed: run.cut.closed !== false, material: mat });
      else if (k === "secret") planWalls.push({ points: ends, kind: "secret", closed: true, material: mat });
      else if (k === "window") planWalls.push({ points: ends, kind: "window", move: true, sight: false, material: mat });
      // arch: a gap
    }
  }
  const planAreas = [];
  for (const [rid, list] of T.rings) {
    const r = cv.info(rid);
    const kind = r.kind === "floor" ? "floor" : r.kind === "solid" ? "solid" : "open";
    for (const ring of list) {
      if (ring.hole) {
        // A hole that is all void: rock (or open ground) standing inside this region.
        if (ring.others.every((o) => o === 0)) planAreas.push({ id: `${r.key ?? rid}-island-${planAreas.length}`, kind: cv.voidKind === "rock" ? "solid" : "open", shape: { polygon: ring.pts } });
        continue;
      }
      planAreas.push({ id: list.filter((x) => !x.hole).length > 1 ? `${r.key ?? rid}-${planAreas.length}` : String(r.key ?? rid), kind,
        shape: { polygon: ring.pts }, ...(r.label ? { label: r.label } : {}), ...(r.material ? { material: r.material } : {}) });
    }
  }
  const plan = parsePlan({ name, width: cv.width, height: cv.height, areas: [...planAreas, ...areas], walls: [...planWalls, ...walls],
    lights, marks, items, brief, source: source ?? { kind: "maker" } });
  return Object.assign(plan, { trace: T, links: placed });
}
