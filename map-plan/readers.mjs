// Readers: turn map files that carry walls into plans (plan.mjs). Walls only: areas are left empty and the profile
// derives rooms from the walls. Readers never touch art pixels; an image path is recorded in `art` only when given.
//
//   fromDd2vtt(json)            a Universal VTT export (our Dungeondraft maps). Its walls are split around doors, so
//                               each portal becomes a door wall across its gap.
//   fromFoundryScene(scene)     a Foundry scene document (v9 NeDB era and v10+), walls in canvas pixels.
import { parsePlan } from "./plan.mjs";

const pt = (p) => [p.x, p.y];

export function fromDd2vtt(d, { name, ref } = {}) {
  const { map_origin: o = { x: 0, y: 0 }, map_size: size } = d.resolution;
  const at = (p) => [p.x - o.x, p.y - o.y];
  const walls = (d.line_of_sight || []).filter((r) => r.length >= 2).map((run) => ({ points: run.map(at) }));
  for (const run of d.objects_line_of_sight || []) if (run.length >= 2) walls.push({ points: run.map(at), kind: "low", move: false });
  for (const p of d.portals || []) {
    if (!p.bounds || p.bounds.length < 2) continue;
    walls.push({ points: p.bounds.map(at), kind: "door", closed: !!p.closed });
  }
  const lights = (d.lights || []).map((l) => ({ x: l.position.x - o.x, y: l.position.y - o.y, dim: l.range }));
  return parsePlan({ name, width: size.x, height: size.y, walls, lights, source: { kind: "dd2vtt", ref } });
}

// Foundry wall flags changed in v10: move 0/1 became 0/20, `sense` became `sight` (and `light`, `sound`).
// Limited walls (old sense 2, new sight 10) block sight only on the second wall crossed; we count them as not blocking.
const blocksMove = (w) => (w.move ?? 1) > 0;
const blocksSight = (w) => ("sight" in w ? w.sight : w.sense ?? 1) === ("sight" in w ? 20 : 1);
const DOOR_KIND = { 1: "door", 2: "secret" };

export function fromFoundryScene(s, { ref, pack } = {}) {
  const g = typeof s.grid === "object" ? s.grid.size : s.grid;
  if (!(g > 0)) throw new Error(`scene ${s.name ?? s._id}: no grid size`);
  const pad = s.padding ?? 0.25;
  // The canvas puts the scene rect at a padding offset rounded up to whole squares; walls are in canvas pixels.
  const ox = Math.ceil((s.width * pad) / g) * g + (s.shiftX || 0);
  const oy = Math.ceil((s.height * pad) / g) * g + (s.shiftY || 0);
  const sq = (x, y) => [(x - ox) / g, (y - oy) / g];
  const walls = [];
  for (const w of s.walls || []) {
    const [x1, y1, x2, y2] = w.c || [];
    if (![x1, y1, x2, y2].every(Number.isFinite) || (x1 === x2 && y1 === y2)) continue;
    const door = DOOR_KIND[w.door] || null;
    walls.push({ points: [sq(x1, y1), sq(x2, y2)], kind: door || (blocksMove(w) ? (blocksSight(w) ? "wall" : "window") : (blocksSight(w) ? "invisible" : "low")),
      move: blocksMove(w), sight: door ? true : blocksSight(w), ...(door ? { closed: (w.ds ?? 0) !== 1 } : {}) });
  }
  const lights = (s.lights || []).filter((l) => Number.isFinite(l.x)).map((l) => {
    const [x, y] = sq(l.x, l.y);
    const dim = l.config?.dim ?? l.dim, bright = l.config?.bright ?? l.bright;
    return { x, y, ...(Number.isFinite(dim) ? { dim } : {}), ...(Number.isFinite(bright) ? { bright } : {}) };
  });
  return parsePlan({ name: s.name, width: s.width / g, height: s.height / g, walls, lights, source: { kind: "foundry-scene", ref: ref ?? s._id, pack } });
}
