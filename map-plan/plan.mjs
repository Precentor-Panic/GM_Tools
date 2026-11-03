// The map format. A PLAN is a battle map as geometry: what the ground is (areas), what stops movement and sight
// (walls, doors), where light comes from, and the marks a GM or player cares about (entrances, exits, landmarks).
// Art is a separate, optional layer: any image aligned to the plan's grid can sit under it (a Dungeondraft render, a
// preview, a published map whose walls these are, or a painted pass made later). Nothing here assumes one renderer.
//
// Every length is in grid squares, origin top-left, x right and y down. Shapes take the same forms as the Dungeondraft
// layout spec's elements: {rect: [x, y, w, h]}, {circle: [cx, cy, r]}, {ellipse: [cx, cy, rx, ry]}, {polygon: [[x, y], ...]}.
//
// The PROFILE (profile.mjs) is a plan's character, computed from its walls: what the shelf searches on and what the
// play check reads. It is derived data and never edited by hand.
//
// SCHEMA HISTORY
//   plan v1 (2026-11-03): areas, walls, lights, marks, art, brief, source. Later the same day, additive: items.
//   profile v1 (2026-11-03), v2 (2026-11-03): see profile.mjs.
import { z } from "zod";

export const PLAN_SCHEMA_VERSION = 1;

const Pt = z.tuple([z.number(), z.number()]);
export const Shape = z.union([
  z.object({ rect: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]) }),
  z.object({ circle: z.tuple([z.number(), z.number(), z.number().positive()]) }),
  z.object({ ellipse: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]) }),
  z.object({ polygon: z.array(Pt).min(3) }),
]);

export const AREA_KINDS = ["floor", "water", "pit", "ledge", "solid", "open"];
export const Area = z.object({
  id: z.string().min(1),
  kind: z.enum(AREA_KINDS),
  shape: Shape,
  label: z.string().optional(),
  depth: z.enum(["shallow", "waist", "chest", "deep"]).optional(), // water
  height: z.number().optional(),                                   // feet above the plan's base level (ledges, pits below 0)
  material: z.string().optional(),                                 // "brick", "cave rock", "sand", ...
});

// A wall is a polyline. `move` and `sight` say what it stops; a door is a wall that opens.
export const WALL_KINDS = ["wall", "door", "secret", "window", "low", "terrain", "invisible"];
export const Wall = z.object({
  points: z.array(Pt).min(2),
  kind: z.enum(WALL_KINDS).default("wall"),
  move: z.boolean().default(true),
  sight: z.boolean().default(true),
  closed: z.boolean().optional(), // doors: closed at the start
});

export const Light = z.object({ x: z.number(), y: z.number(), bright: z.number().nonnegative().optional(), dim: z.number().nonnegative().optional(), color: z.string().optional() });

export const MARK_KINDS = ["entrance", "exit", "landmark", "interactable", "objective", "spot"];
export const Mark = z.object({ kind: z.enum(MARK_KINDS), x: z.number(), y: z.number(), label: z.string().optional(), to: z.string().optional() });

// Things standing or lying on the map: furniture, props, dressing. `what` is a plain name or an asset name; `kinds`
// are content kinds from vocab.json when the name doesn't say (theme.mjs, kindsOfName).
export const Item = z.object({ what: z.string().min(1), x: z.number(), y: z.number(), size: z.number().positive().optional(), kinds: z.array(z.string()).optional() });

export const Art = z.object({
  src: z.string().min(1),
  role: z.enum(["background", "overlay"]).default("background"),
  rect: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional(), // default: the whole plan
  maker: z.string().optional(), // "dungeondraft", "preview", "published", ...
});

export const Plan = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION).default(PLAN_SCHEMA_VERSION),
  name: z.string().optional(),
  width: z.number().positive(),
  height: z.number().positive(),
  areas: z.array(Area).default([]),
  walls: z.array(Wall).default([]),
  lights: z.array(Light).default([]),
  marks: z.array(Mark).default([]),
  items: z.array(Item).default([]),
  art: z.array(Art).default([]),
  brief: z.record(z.string(), z.unknown()).optional(),
  // Where the plan came from, for the shelf: { kind: "dd2vtt" | "foundry-scene" | "maker", ref, pack? }.
  source: z.object({ kind: z.string(), ref: z.string().optional(), pack: z.string().optional() }).passthrough().optional(),
});

export const parsePlan = (p) => Plan.parse(p);

/** Every wall polyline as two-point segments, with its flags. */
export function segments(plan) {
  const out = [];
  for (const w of plan.walls) {
    for (let i = 1; i < w.points.length; i++) out.push({ a: w.points[i - 1], b: w.points[i], kind: w.kind, move: w.move, sight: w.sight });
  }
  return out;
}

/** A shape as a polygon (circles and ellipses as 32-gons), in squares. */
export function shapePolygon(s, n = 32) {
  if (s.polygon) return s.polygon;
  if (s.rect) { const [x, y, w, h] = s.rect; return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
  const [cx, cy, rx, ry] = s.circle ? [s.circle[0], s.circle[1], s.circle[2], s.circle[2]] : s.ellipse;
  return Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
}
