// The masonry kit: what every built-place recipe (tavern, temple, fort, sewer) draws with. A Build wraps a canvas
// (canvas.mjs) with rooms, ground, solid masses, the links between them, and the things standing in them; trace()
// turns the geometry into walls and outlines (trace.mjs), and the recipe dresses the result knowing where the doors
// went. Rooms that change floor material should meet on whole squares: Dungeondraft tiles a floor per square.
import { Canvas } from "./canvas.mjs";
import { toPlan } from "./trace.mjs";
import { rng } from "./rng.mjs";
import { parsePlan } from "../plan.mjs";

export class Build {
  constructor(width, height, { seed = 1, R = 8, voidKind = "ground", organicRock } = {}) {
    this.cv = new Canvas(width, height, { R, voidKind, organicRock });
    this.r = rng(seed);
    Object.assign(this, { seed, links: [], edges: [], walls: [], areas: [], items: [], lights: [], marks: [], keep: [], rooms: new Map() });
  }

  get width() { return this.cv.width; }
  get height() { return this.cv.height; }
  #region(kind, key, shape, props) {
    const id = this.cv.byKey(key) ?? this.cv.region({ kind, key, ...props });
    if (shape) this.cv.paint(shape, id, { where: props.where, guides: props.guides ?? !props.organic });
    if (shape?.rect && !this.rooms.has(key)) this.rooms.set(key, shape.rect);
    return id;
  }
  /** A room (floor region). The first rect a room is painted with is its "frame" for furniture helpers. */
  room(key, shape, props = {}) { return this.#region("floor", key, shape, props); }
  ground(key, shape, props = {}) { return this.#region("ground", key, shape, props); }
  solid(key, shape, props = {}) { return this.#region("solid", key, shape, props); }
  /** Back to the void (open ground, or rock). */
  clear(shape, where) { this.cv.paint(shape, 0, { where }); }

  door(a, b, o = {}) { this.links.push({ a, b, kind: "door", width: 1, ...o }); return this; }
  arch(a, b, o = {}) { this.links.push({ a, b, kind: "arch", width: 2, ...o }); return this; }
  open(a, b) { this.links.push({ a, b, kind: "open" }); return this; }
  window(a, b, o = {}) { this.links.push({ a, b, kind: "window", width: 1, ...o }); return this; }
  secret(a, b, o = {}) { this.links.push({ a, b, kind: "secret", width: 1, ...o }); return this; }
  edge(a, b, kind, o = {}) { this.edges.push({ a, b, kind, ...o }); return this; }

  item(what, x, y, o = {}) {
    const it = { what, x: +x.toFixed(3), y: +y.toFixed(3) };
    for (const k of ["size", "rotation", "kinds", "layer"]) if (o[k] != null) it[k] = k === "rotation" ? Math.round(o[k]) : o[k];
    this.items.push(it);
    return it;
  }
  light(x, y, o = {}) { this.lights.push({ x: +x.toFixed(3), y: +y.toFixed(3), bright: o.bright ?? 2, dim: o.dim ?? 5, ...(o.color ? { color: o.color } : {}) }); }
  mark(kind, x, y, label, to) { this.marks.push({ kind, x, y, ...(label ? { label } : {}), ...(to ? { to } : {}) }); }
  /** A counter, a low wall: shown, stops nothing (a battle map leaves them unwalled). */
  low(points, o = {}) { this.walls.push({ points, kind: "low", move: false, sight: false, ...o }); }
  /** A fence or railing: stops feet, not eyes. */
  fence(points, o = {}) { this.walls.push({ points, kind: "low", move: true, sight: false, ...o }); }
  area(id, kind, shape, props = {}) { this.areas.push({ id, kind, shape, ...props }); }
  /** No furniture here (a walkway, the space in front of a hearth). Rect [x, y, w, h]. */
  keepClear(rect) { this.keep.push(rect); }

  /** Walls and outlines from the geometry so far. Dress after this (doors are placed), then call done(). */
  trace(name) {
    this.plan = toPlan(this.cv, { name, links: this.links, edges: this.edges, walls: this.walls, areas: this.areas });
    // Keep the approach to every door and arch clear.
    for (const l of this.plan.links) if (l.ends && (l.kind === "door" || l.kind === "arch" || l.kind === "secret")) this.#clearAround(l.ends, 1.1);
    return this.plan;
  }
  #clearAround([a, b], r) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, half = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
    this.keep.push([mx - half - r * 0.4, my - r, 2 * (half + r * 0.4), 2 * r]);
    this.keep.push([mx - r, my - half - r * 0.4, 2 * r, 2 * (half + r * 0.4)]);
  }
  /** Is a disc of radius r at (x, y) clear: inside room `key` (r from its walls) and outside every keep-clear rect? */
  fits(key, x, y, r) {
    const id = key === "void" ? 0 : this.cv.byKey(key);
    for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
      if (this.cv.at(x + dx, y + dy) !== id) return false;
    }
    return !this.keep.some(([kx, ky, kw, kh]) => x + r > kx && x - r < kx + kw && y + r > ky && y - r < ky + kh);
  }

  /**
   * Scatter `n` furniture groups in a room: `put(x, y, r)` draws one group at a spot `radius` clear of walls, doors
   * and other groups. Spots come from a shuffled half-square lattice, so the result is deterministic and spread out.
   */
  scatter(key, n, radius, put, { r = this.r.fork(`scatter:${key}`), within } = {}) {
    const [x0, y0, w, h] = within ?? this.rooms.get(key);
    const spots = [];
    for (let y = y0 + radius; y <= y0 + h - radius + 1e-9; y += 0.5) for (let x = x0 + radius; x <= x0 + w - radius + 1e-9; x += 0.5) spots.push([x, y]);
    let made = 0;
    for (const [x, y] of r.shuffle(spots)) {
      if (made >= n) break;
      if (!this.fits(key, x, y, radius)) continue;
      put(x, y, r);
      this.keep.push([x - radius, y - radius, 2 * radius, 2 * radius]);
      made++;
    }
    return made;
  }

  /** The finished plan: geometry from trace(), plus everything placed since. */
  done(extra = {}) {
    const p = this.plan ?? this.trace(extra.name);
    const out = parsePlan({ name: p.name, width: p.width, height: p.height, areas: p.areas, walls: p.walls, lights: this.lights, marks: this.marks,
      items: this.items, brief: extra.brief, source: extra.source ?? { kind: "maker" } });
    return Object.assign(out, { trace: p.trace, links: p.links, regions: this.cv.regions.filter(Boolean) });
  }
}

/** Points of a rect's side: "N" | "S" | "E" | "W" as [a, b] in squares. */
export function side([x, y, w, h], s) {
  return { N: [[x, y], [x + w, y]], S: [[x, y + h], [x + w, y + h]], W: [[x, y], [x, y + h]], E: [[x + w, y], [x + w, y + h]] }[s];
}
export { rng };
