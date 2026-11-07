// Turning and mirroring a finished plan, so a recipe can draw in one orientation (street to the south, say) and the
// brief or the seed picks the real one. Everything with a position moves: areas, walls, lights, marks, items.

/** mirror: flip left-right; turn: quarter turns clockwise (0..3). Returns a new plan; width and height swap on odd turns. */
export function transformPlan(plan, { mirror = false, turn = 0 } = {}) {
  turn = ((turn % 4) + 4) % 4;
  const W = plan.width, H = plan.height;
  const m = ([x, y]) => (mirror ? [W - x, y] : [x, y]);
  // A quarter turn clockwise in y-down axes: (x, y) -> (H' - y, x) where H' is the height before the turn.
  const t = ([x, y]) => {
    let p = [x, y], w = W, h = H;
    for (let i = 0; i < turn; i++) { p = [h - p[1], p[0]]; [w, h] = [h, w]; }
    return p;
  };
  const f = (p) => t(m(p)).map((v) => +v.toFixed(4));
  const rot = (deg = 0) => { let d = mirror ? 180 - deg : deg; d += 90 * turn; return ((Math.round(d) % 360) + 360) % 360; };
  const shape = (s) => {
    if (s.polygon) return { polygon: s.polygon.map(f) };
    if (s.rect) { const [x, y, w, h] = s.rect; const ps = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(f); return { polygon: ps }; }
    if (s.circle) { const [cx, cy, r] = s.circle; return { circle: [...f([cx, cy]), r] }; }
    if (s.ellipse) { const [cx, cy, rx, ry] = s.ellipse; return { ellipse: [...f([cx, cy]), ...(turn % 2 ? [ry, rx] : [rx, ry])] }; }
    return s;
  };
  const pos = (o) => { const [x, y] = f([o.x, o.y]); return { ...o, x, y }; };
  const odd = turn % 2 === 1;
  return {
    ...plan,
    width: odd ? H : W, height: odd ? W : H,
    areas: plan.areas.map((a) => ({ ...a, shape: shape(a.shape) })),
    walls: plan.walls.map((w) => ({ ...w, points: w.points.map(f) })),
    lights: plan.lights.map(pos), marks: plan.marks.map(pos),
    items: plan.items.map((it) => ({ ...pos(it), ...(it.rotation != null || mirror || turn ? { rotation: rot(it.rotation) } : {}) })),
  };
}
