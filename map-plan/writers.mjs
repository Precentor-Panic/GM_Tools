// Writers: a plan out to a file another tool reads. The plan is the source of truth for walls, so a map's Foundry
// walls come from here, not from whatever drew its picture.
//
//   toUvtt(plan, {image, ppi})   Universal VTT (dd2vtt 0.3, the format Foundry's importers read): walls that stop
//                                sight as line_of_sight, walls that stop feet only (windows, ledges, fences) as
//                                objects_line_of_sight, doors and windows as portals, lights. `image` is base64 PNG/WebP.

const P = ([x, y]) => ({ x: +x.toFixed(4), y: +y.toFixed(4) });

export function toUvtt(plan, { image = "", ppi = 100 } = {}) {
  const los = [], olos = [], portals = [];
  for (const w of plan.walls) {
    const pts = w.points.map(P);
    if (w.kind === "door" || w.kind === "secret") {
      const [a, b] = [w.points[0], w.points[w.points.length - 1]];
      portals.push({ position: P([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), bounds: [P(a), P(b)], rotation: Math.atan2(b[1] - a[1], b[0] - a[0]),
        closed: w.closed !== false, freestanding: false });
      continue;
    }
    if (w.move === false && w.sight === false) continue; // a counter: shown on the picture, stops nothing
    if (w.sight !== false) los.push(pts); else olos.push(pts);
  }
  return {
    format: 0.3,
    resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: plan.width, y: plan.height }, pixels_per_grid: ppi },
    line_of_sight: los, objects_line_of_sight: olos, portals,
    environment: { baked_lighting: true, ambient_light: "ff000000" },
    lights: plan.lights.map((l) => ({ position: P([l.x, l.y]), range: l.dim ?? 5, intensity: 1, color: (l.color ?? "#ffeecd").replace("#", "ff"), shadows: true })),
    image,
  };
}
