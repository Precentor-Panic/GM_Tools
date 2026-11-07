// A maker's drawing surface: a grid of labels, R cells per square (default 8). Label 0 is the VOID: the rock round a
// dungeon (voidKind "rock") or the open ground round a building (voidKind "ground"). Every other label is a REGION:
//   { id, kind: "floor" | "ground" | "solid", key?, label?, material?, organic?, walls? }
//   floor   a room or a passage: walled from everything that isn't itself
//   ground  open ground (a yard, a street): walled only where it meets floor or solid
//   solid   masonry or rock standing up (a pillar, a thick wall, a buttress): walled where it meets floor or ground
//   organic: true   its edges are rough (cave rock, rubble, broken masonry); the tracer smooths them instead of snapping
//
// Painting a shape sets the label of every cell whose centre is inside it. Straight and round shapes also leave GUIDES,
// their exact outlines, so the tracer (trace.mjs) can snap the cell staircase back onto true lines and arcs. Shapes take
// the plan's forms ({rect}, {circle}, {ellipse}, {polygon}) plus {capsule: [x0, y0, x1, y1, r]} and
// {path: [[x, y], ...], width} for rough passages (no guides).

export const REGION_KINDS = ["floor", "ground", "solid"];

const pointInPoly = (poly, x, y) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
};

/** An inside test and a bounding box for a shape, in squares. */
export function shapeTest(s) {
  if (s.rect) { const [x, y, w, h] = s.rect; return { bbox: [x, y, x + w, y + h], inside: (px, py) => px >= x && px < x + w && py >= y && py < y + h }; }
  if (s.circle || s.ellipse) {
    const [cx, cy, rx, ry] = s.circle ? [s.circle[0], s.circle[1], s.circle[2], s.circle[2]] : s.ellipse;
    return { bbox: [cx - rx, cy - ry, cx + rx, cy + ry], inside: (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 };
  }
  if (s.polygon) {
    const xs = s.polygon.map((p) => p[0]), ys = s.polygon.map((p) => p[1]);
    return { bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], inside: (px, py) => pointInPoly(s.polygon, px, py) };
  }
  if (s.capsule) {
    const [ax, ay, bx, by, r] = s.capsule;
    return { bbox: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r], inside: (px, py) => segDist(px, py, ax, ay, bx, by) <= r };
  }
  if (s.path) {
    const r = (s.width ?? 1) / 2, P = s.path;
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    return { bbox: [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r],
      inside: (px, py) => { for (let i = 1; i < P.length; i++) if (segDist(px, py, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]) <= r) return true; return false; } };
  }
  throw new Error(`unknown shape ${JSON.stringify(s).slice(0, 80)}`);
}

/** The exact outline of a shape as guides: {line: [ax, ay, bx, by]} or {ellipse: [cx, cy, rx, ry]}. */
export function shapeGuides(s) {
  const lines = (pts) => pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return { line: [p[0], p[1], q[0], q[1]] }; });
  if (s.rect) { const [x, y, w, h] = s.rect; return lines([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); }
  if (s.circle) return [{ ellipse: [s.circle[0], s.circle[1], s.circle[2], s.circle[2]] }];
  if (s.ellipse) return [{ ellipse: [...s.ellipse] }];
  if (s.polygon) return lines(s.polygon);
  return [];
}

export class Canvas {
  /** organicRock: rock edges come out rough (a cave; the default for voidKind "rock") or true (tunnels cut in rock). */
  /** outerWall / innerWall: wall materials for a building's outside and its partitions (a region's `wall` wins). */
  constructor(width, height, { R = 8, voidKind = "rock", organicRock, outerWall = "stone", innerWall = "wood" } = {}) {
    if (!["rock", "ground"].includes(voidKind)) throw new Error(`voidKind ${voidKind}`);
    Object.assign(this, { width, height, R, voidKind, organicRock: organicRock ?? voidKind === "rock", outerWall, innerWall });
    this.W = Math.ceil(width * R);
    this.H = Math.ceil(height * R);
    this.lab = new Int32Array(this.W * this.H);
    this.regions = [null];
    this.guides = [];
  }

  /** A new region; returns its label. */
  region(props) {
    if (!REGION_KINDS.includes(props.kind)) throw new Error(`region kind ${props.kind}`);
    if (props.key && this.byKey(props.key)) throw new Error(`duplicate region key ${props.key}`);
    const id = this.regions.length;
    this.regions.push({ id, ...props });
    return id;
  }
  byKey(key) { return this.regions.find((r) => r && r.key === key)?.id ?? null; }
  info(id) { return id === 0 ? { id: 0, kind: this.voidKind === "rock" ? "rock" : "ground", key: "void" } : this.regions[id]; }

  /** Cell index of the cell holding square point (x, y), or -1 off the map. */
  cell(x, y) {
    const cx = Math.floor(x * this.R), cy = Math.floor(y * this.R);
    return cx >= 0 && cy >= 0 && cx < this.W && cy < this.H ? cy * this.W + cx : -1;
  }
  at(x, y) { const c = this.cell(x, y); return c < 0 ? -1 : this.lab[c]; }

  /** Calls fn(cell, x, y) for every cell whose centre (in squares) is in the bbox. */
  each([x0, y0, x1, y1], fn) {
    const { R, W, H } = this;
    const cx0 = Math.max(0, Math.floor(x0 * R)), cy0 = Math.max(0, Math.floor(y0 * R));
    const cx1 = Math.min(W - 1, Math.ceil(x1 * R)), cy1 = Math.min(H - 1, Math.ceil(y1 * R));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * W + cx, (cx + 0.5) / R, (cy + 0.5) / R);
  }

  /**
   * Set `id` on every cell inside `shape`. `where`: only cells whose label is in this list (a label or an array).
   * `guides: false` leaves no guides (a rough shape). Returns the number of cells set.
   */
  paint(shape, id, { where, guides = true } = {}) {
    // Rects land on the cell grid exactly, so a wall drawn from one is straight to the last cell.
    if (shape.rect) shape = { rect: shape.rect.map((v) => Math.round(v * this.R) / this.R) };
    const { inside, bbox } = shapeTest(shape);
    const ok = where == null ? null : new Set([].concat(where));
    let n = 0;
    this.each(bbox, (c, x, y) => { if ((!ok || ok.has(this.lab[c])) && inside(x, y)) { this.lab[c] = id; n++; } });
    if (guides && n) for (const g of shapeGuides(shape)) this.guides.push(g);
    return n;
  }

  /** Set `id` wherever test(x, y, label) is true (squares, cell centres). No guides. */
  paintWhere(test, id, bbox = [0, 0, this.width, this.height]) {
    let n = 0;
    this.each(bbox, (c, x, y) => { if (test(x, y, this.lab[c])) { this.lab[c] = id; n++; } });
    return n;
  }

  /** Change every cell labelled `from` (a label or array) to `to`. */
  relabel(from, to) {
    const f = new Set([].concat(from));
    for (let c = 0; c < this.lab.length; c++) if (f.has(this.lab[c])) this.lab[c] = to;
  }

  count(id) { let n = 0; for (const v of this.lab) if (v === id) n++; return n; }
  squares(id) { return this.count(id) / (this.R * this.R); }

  /** 4-connected components of the cells where test(label) holds: [{cells: Int32Array-like list, size}] largest first. */
  components(test) {
    const { W, H, lab } = this, seen = new Uint8Array(W * H), out = [], stack = [];
    for (let s = 0; s < W * H; s++) {
      if (seen[s] || !test(lab[s])) continue;
      const cells = [];
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const c = stack.pop(); cells.push(c);
        const x = c % W;
        for (const n of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c >= W ? c - W : -1, c + W < W * H ? c + W : -1]) {
          if (n >= 0 && !seen[n] && test(lab[n])) { seen[n] = 1; stack.push(n); }
        }
      }
      out.push({ cells, size: cells.length });
    }
    return out.sort((a, b) => b.size - a.size);
  }

  /** Smooth ragged edges between `id` and its surroundings: a cell takes the majority label of its 3x3 block, but
   *  only flips between `id` and `other`. A few passes of this turn noise into rounded rock. */
  majority(id, other, passes = 1) {
    const { W, H } = this;
    for (let p = 0; p < passes; p++) {
      const next = new Int32Array(this.lab);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const c = y * W + x, v = this.lab[c];
        if (v !== id && v !== other) continue;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.lab[c + dy * W + dx] === id) k++;
        if (v === id && k <= 3) next[c] = other;
        else if (v === other && k >= 6) next[c] = id;
      }
      this.lab = next;
    }
  }

  /** Distance (in squares) from each cell to the nearest cell NOT passing test(label), 4-neighbour steps. */
  distanceInside(test) {
    const { W, H, lab, R } = this, d = new Float32Array(W * H).fill(Infinity), q = new Int32Array(W * H);
    let head = 0, tail = 0;
    for (let c = 0; c < W * H; c++) if (!test(lab[c])) { d[c] = 0; q[tail++] = c; }
    while (head < tail) {
      const c = q[head++], x = c % W;
      for (const n of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
        if (n < 0 || n >= W * H || d[n] !== Infinity) continue;
        d[n] = d[c] + 1; q[tail++] = n;
      }
    }
    for (let c = 0; c < W * H; c++) d[c] /= R;
    return d;
  }
}
