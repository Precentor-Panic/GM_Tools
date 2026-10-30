/**
 * Atlas geometry — dependency-free, so the browser and Node share one copy (the run-layout precedent: canonical
 * here, re-exported by atlas/geometry.mjs). Feet; x east, y south; bearings in degrees clockwise from north.
 */

const RAD = Math.PI / 180;

export function polar(p, centre = { x: 0, y: 0 }) {
  const dx = p.x - centre.x, dy = p.y - centre.y;
  const th = Math.atan2(dx, -dy) / RAD;
  return { r: Math.hypot(dx, dy), th: (th + 360) % 360 };
}

export function fromPolar(r, th, centre = { x: 0, y: 0 }) {
  return { x: centre.x + r * Math.sin(th * RAD), y: centre.y - r * Math.cos(th * RAD) };
}

/** Signed smallest turn from bearing a to bearing b, in (-180, 180]. */
export function turn(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

function arcPoints(a, b, centre, stepDeg = 2) {
  const pa = polar(a, centre), pb = polar(b, centre);
  const d = turn(pa.th, pb.th);
  const n = Math.max(2, Math.ceil(Math.abs(d) / stepDeg));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(fromPolar(pa.r + (pb.r - pa.r) * t, pa.th + d * t, centre));
  }
  out[0] = { x: a.x, y: a.y };
  out[out.length - 1] = { x: b.x, y: b.y };
  return out;
}

/**
 * The polyline a passage follows, in feet.
 *   straight: end to end.   path: through the stored bend points.
 *   arc: along the rings (radius and bearing change together), for passages that run round the city.
 *   radial: out (or in) along the start's bearing to the far end's radius, then round the ring to it.
 */
export function routePoints(edge, a, b, centre = { x: 0, y: 0 }) {
  if (edge.route === "path" && edge.path?.length) return [{ x: a.x, y: a.y }, ...edge.path.map((p) => ({ x: p.x, y: p.y })), { x: b.x, y: b.y }];
  if (edge.route === "arc") return arcPoints(a, b, centre);
  if (edge.route === "radial") {
    const pa = polar(a, centre), pb = polar(b, centre);
    const elbow = fromPolar(pb.r, pa.th, centre);
    return [{ x: a.x, y: a.y }, ...arcPoints(elbow, b, centre).map((p, i) => (i === 0 ? elbow : p))];
  }
  return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

export function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

/** Feet per minute, walking carefully underground, by water depth. A crawl halves it. */
export const PACE = { dry: 200, ankle: 150, waist: 100, chest: 60, full: 40 };

/** Minutes to cross a passage: its stored minutes, else its drawn length (plus the climb) at the water's pace. */
export function travelMinutes(edge, a, b, centre) {
  if (typeof edge.minutes === "number") return edge.minutes;
  const climb = Math.abs((a.depth ?? 0) - (b.depth ?? 0));
  if (edge.kind === "shaft" || edge.kind === "stair") return Math.max(1, Math.ceil(climb / 20));
  const len = polylineLength(routePoints(edge, a, b, centre));
  const pace = (PACE[edge.water] ?? 200) * (edge.width === "crawl" ? 0.5 : 1);
  return Math.max(1, Math.ceil(len / pace + climb / 30));
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInArea(p, shape) {
  const c = { x: shape.cx, y: shape.cy };
  switch (shape.type) {
    case "circle": return Math.hypot(p.x - shape.cx, p.y - shape.cy) <= shape.r;
    case "annulus": { const r = Math.hypot(p.x - shape.cx, p.y - shape.cy); return r >= shape.r0 && r <= shape.r1; }
    case "sector": {
      const pp = polar(p, c);
      if (pp.r < shape.r0 || pp.r > shape.r1) return false;
      const span = (shape.to - shape.from + 360) % 360;
      return (pp.th - shape.from + 360) % 360 <= span;
    }
    case "polygon": return pointInPolygon(p, shape.points);
    default: return false;
  }
}

/** A section's corners in atlas feet (5 ft squares, rotated clockwise about its origin). */
export function sectionCorners(section) {
  const w = section.sizeSq.w * 5, h = section.sizeSq.h * 5, rot = (section.rotation || 0) * RAD;
  const c = Math.cos(rot), s = Math.sin(rot), o = section.origin;
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ({ x: o.x + x * c - y * s, y: o.y + x * s + y * c }));
}

/** Atlas feet -> the section's own squares (x right, y down from its top-left). */
export function toSectionSquares(section, p) {
  const rot = -(section.rotation || 0) * RAD, dx = p.x - section.origin.x, dy = p.y - section.origin.y;
  return { x: (dx * Math.cos(rot) - dy * Math.sin(rot)) / 5, y: (dx * Math.sin(rot) + dy * Math.cos(rot)) / 5 };
}

/** Where a polyline first crosses from inside a rectangle (in section squares) to outside: {side, at} or null. */
export function exitCrossing(section, pts) {
  const sq = pts.map((p) => toSectionSquares(section, p));
  const { w, h } = section.sizeSq;
  const inside = (p) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
  for (let i = 1; i < sq.length; i++) {
    const a = sq[i - 1], b = sq[i];
    if (inside(a) === inside(b)) continue;
    const [p, q] = inside(a) ? [a, b] : [b, a];
    let best = null;
    for (const [side, t] of [["w", (0 - p.x) / (q.x - p.x)], ["e", (w - p.x) / (q.x - p.x)], ["n", (0 - p.y) / (q.y - p.y)], ["s", (h - p.y) / (q.y - p.y)]]) {
      if (!(t >= 0 && t <= 1)) continue;
      const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
      if (x < -1e-6 || x > w + 1e-6 || y < -1e-6 || y > h + 1e-6) continue;
      if (!best || t < best.t) best = { t, side, at: side === "w" || side === "e" ? y : x };
    }
    if (best) return { side: best.side, at: Math.round(best.at * 10) / 10 };
  }
  return null;
}

export function pointInSection(section, p) {
  const q = toSectionSquares(section, p);
  return q.x >= 0 && q.x <= section.sizeSq.w && q.y >= 0 && q.y <= section.sizeSq.h;
}
