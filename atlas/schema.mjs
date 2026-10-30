/**
 * Atlas schema — the places, depths and passages of one site (a city's underground, a dungeon, a district), stored as
 * data and drawn as maps. Plan: plans/atlas-plan.md (approved 2026-10-30).
 *
 * Coordinates are feet on one flat frame per atlas: x east, y SOUTH (screen order), origin wherever the frame says
 * (for a ringed city, the centre). Depth is feet below street level, positive down. Polar helpers (radius, bearing)
 * live in geometry.mjs; storage is always cartesian.
 *
 * Two files per atlas (store.mjs): `<id>.json` (GM truth, this schema) and `<id>.known.json` (what the table knows,
 * KnownFile below). "Known" is deliberately NOT narrative-state: there, no record means fully open; here, no record
 * means the party has never heard of the place.
 *
 * Claude's additions carry `draft: true` until the GM accepts them (plan §8, q-drafts). Drafts never reach a survey
 * or a section brief.
 */
import { z } from "zod";

// v1 grew two optional fields without a bump (old files still parse): Area.fabric and Atlas.city (2026-10-30).
export const ATLAS_SCHEMA_VERSION = 1;
export const KNOWN_SCHEMA_VERSION = 1;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lower-case words joined by hyphens");
const Pt = z.object({ x: z.number(), y: z.number() }).strict();

export const WATER = ["dry", "ankle", "waist", "chest", "full"];
export const ROUTES = ["straight", "arc", "radial", "path"];
export const KNOWN_LEVELS = ["heard", "seen", "walked"];
export const GATE_STATES = ["open", "closed", "locked", "sealed", "broken"];

/** An area's outline. Circles, rings and sectors are centred on a point; a polygon is absolute feet. */
export const AreaShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("circle"), cx: z.number(), cy: z.number(), r: z.number().positive() }).strict(),
  z.object({ type: z.literal("annulus"), cx: z.number(), cy: z.number(), r0: z.number().nonnegative(), r1: z.number().positive() }).strict(),
  z.object({ type: z.literal("sector"), cx: z.number(), cy: z.number(), r0: z.number().nonnegative(), r1: z.number().positive(),
    from: z.number(), to: z.number() }).strict(),
  z.object({ type: z.literal("polygon"), points: z.array(Pt).min(3) }).strict(),
]);

/** A node's footprint, relative to the node's own x,y. Without one a node draws as a small chamber. */
export const NodeShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("circle"), r: z.number().positive() }).strict(),
  z.object({ type: z.literal("rect"), w: z.number().positive(), h: z.number().positive(), rot: z.number().default(0) }).strict(),
  z.object({ type: z.literal("polygon"), points: z.array(Pt).min(3) }).strict(),
]);

/** What fills a city block in an area (atlas-city.mjs). Feet. Highest z wins where areas overlap. */
export const Fabric = z.object({
  z: z.number().default(0),
  kind: z.enum(["houses", "compounds", "sheds", "none"]).default("houses"),
  lot: z.tuple([z.number().positive(), z.number().positive()]).optional(),   // frontage, depth
  gap: z.number().nonnegative().optional(),        // between neighbours along a street
  vacancy: z.number().min(0).max(1).optional(),    // share of lots left empty
  open: z.number().min(0).max(1).optional(),       // share of blocks left open: squares, yards, gardens, waste
  patchy: z.number().min(0).max(1).optional(),     // how far density swings between neighbourhoods (0 = even)
  // How the streets are laid: "ring" (default) follows the bands; "grid" is the city's old straight grid (city.grid),
  // uniform blocks and lots; "sprawl" is unplanned growth: skewed cross streets, kinked rings, narrow deep lots.
  plan: z.enum(["ring", "grid", "sprawl"]).optional(),
}).strict();

export const Area = z.object({
  id: Id, name: z.string(), kind: z.string(), shape: AreaShape,
  wf: z.string().optional(), note: z.string().optional(), draft: z.boolean().optional(),
  fabric: Fabric.optional(),
}).strict();

/** The street grid the city layer is laid on (atlas-city.mjs). Optional; additive to schema v1. */
export const City = z.object({
  seed: z.number().int().default(1),
  street: z.number().positive().optional(),        // ft between blocks
  grain: z.number().positive().optional(),         // ft across one neighbourhood of the density noise (default 700)
  bands: z.array(z.object({ r0: z.number().nonnegative(), r1: z.number().positive(),
    block: z.tuple([z.number().positive(), z.number().positive()]) }).strict()).default([]),   // length (along the ring), depth
  avenues: z.array(z.object({ bearing: z.number(), width: z.number().positive().optional(), name: z.string().optional() }).strict()).default([]),
  // The old grid every "grid" area shares (one alignment, as if they were all pieces of one older city).
  grid: z.object({ angle: z.number().default(0), block: z.tuple([z.number().positive(), z.number().positive()]),
    street: z.number().positive().optional() }).strict().optional(),
}).strict();

export const Stratum = z.object({
  id: z.string(), name: z.string(), top: z.number(), bottom: z.number(),
  era: z.string().optional(), what: z.string().optional(),
}).strict();

export const System = z.object({
  id: Id, name: z.string(), who: z.string().optional(), logic: z.string().optional(),
  model: z.string().optional(), colour: z.string().optional(), dash: z.string().optional(),
}).strict();

export const Node = z.object({
  id: Id, name: z.string().optional(), kind: z.string(), stratum: z.string(),
  x: z.number(), y: z.number(), depth: z.number(),
  shape: NodeShape.optional(),
  systems: z.array(z.string()).default([]),
  owner: z.string().optional(),
  wf: z.string().optional(),                       // a World Fabric place; its name is used when this has none
  tells: z.array(z.string()).default([]),          // what a party standing here can tell about it
  note: z.string().optional(),                     // GM-only
  draft: z.boolean().optional(),
  partyOnly: z.boolean().optional(),               // a belief, drawn only on the survey
  standsFor: z.string().optional(),                // the real node a belief is about
}).strict();

export const Gate = z.object({
  kind: z.string(), state: z.enum(GATE_STATES), controlledBy: z.string().optional(), note: z.string().optional(),
}).strict();

export const Edge = z.object({
  id: Id, from: Id, to: Id,
  route: z.enum(ROUTES).default("straight"),
  path: z.array(Pt).optional(),                    // bend points between the ends, for route "path"
  kind: z.string(),
  systems: z.array(z.string()).default([]),
  water: z.enum(WATER).default("dry"),
  flow: z.enum(["none", "forward", "back"]).default("none"),   // forward = from -> to
  width: z.enum(["crawl", "walk", "cart", "canal"]).default("walk"),
  minutes: z.number().nonnegative().optional(),    // overrides the length-based estimate
  gate: Gate.optional(),
  tells: z.array(z.string()).default([]),
  note: z.string().optional(),
  hook: z.boolean().optional(),
  draft: z.boolean().optional(),
}).strict();

export const Section = z.object({
  id: Id, name: z.string(), vibe: z.string().optional(),
  origin: Pt,                                      // the map's top-left corner, in atlas feet
  rotation: z.number().default(0),                 // degrees, clockwise
  sizeSq: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).strict(),   // 5 ft squares
  sceneId: z.string().optional(),                  // the planner scene; it holds the Foundry reference
  build: z.object({ kind: z.enum(["dd-layout", "composition", "asset"]), ref: z.string() }).strict().optional(),
  note: z.string().optional(),
}).strict();

export const Frame = z.object({
  north: z.number().default(0),                    // degrees the map's up is turned from north
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),   // minX, minY, maxX, maxY in feet
  centre: Pt.default({ x: 0, y: 0 }),              // the polar origin
}).strict();

export const Atlas = z.object({
  schemaVersion: z.literal(ATLAS_SCHEMA_VERSION),
  id: Id, name: z.string(), revision: z.number().int().nonnegative(),
  units: z.literal("ft"),
  frame: Frame,
  areas: z.array(Area).default([]),
  strata: z.array(Stratum).min(1),
  systems: z.array(System).default([]),
  nodes: z.array(Node).default([]),
  edges: z.array(Edge).default([]),
  sections: z.array(Section).default([]),
  city: City.optional(),
}).strict();

export const KnownEntry = z.object({
  at: z.string(), id: z.string(), level: z.enum([...KNOWN_LEVELS, "forgotten"]),
  by: z.string().optional(), note: z.string().optional(),
}).strict();

export const KnownFile = z.object({
  schemaVersion: z.literal(KNOWN_SCHEMA_VERSION),
  atlasId: Id,
  known: z.record(z.string(), z.enum(KNOWN_LEVELS)).default({}),   // node or edge id -> level
  log: z.array(KnownEntry).default([]),            // append-only
}).strict();

/** Parse and check cross-references (ids unique, edges and sections point at real things). Throws on failure. */
export function parseAtlas(raw) {
  const atlas = Atlas.parse(raw);
  const problems = referenceProblems(atlas);
  if (problems.length) throw new Error(`Atlas "${atlas.id}" is inconsistent:\n- ${problems.join("\n- ")}`);
  return atlas;
}

export function referenceProblems(atlas) {
  const out = [];
  const seen = new Set();
  for (const [kind, list] of [["area", atlas.areas], ["node", atlas.nodes], ["edge", atlas.edges], ["section", atlas.sections], ["system", atlas.systems]]) {
    for (const x of list) {
      if (seen.has(x.id)) out.push(`duplicate id "${x.id}" (${kind})`);
      seen.add(x.id);
    }
  }
  const nodes = new Set(atlas.nodes.map((n) => n.id));
  const strata = new Set(atlas.strata.map((s) => s.id));
  const systems = new Set(atlas.systems.map((s) => s.id));
  for (const n of atlas.nodes) {
    if (!strata.has(n.stratum)) out.push(`node "${n.id}" is in unknown stratum "${n.stratum}"`);
    for (const s of n.systems) if (!systems.has(s)) out.push(`node "${n.id}" names unknown system "${s}"`);
    if (n.standsFor && !nodes.has(n.standsFor)) out.push(`node "${n.id}" stands for unknown node "${n.standsFor}"`);
  }
  for (const e of atlas.edges) {
    if (!nodes.has(e.from)) out.push(`edge "${e.id}" starts at unknown node "${e.from}"`);
    if (!nodes.has(e.to)) out.push(`edge "${e.id}" ends at unknown node "${e.to}"`);
    for (const s of e.systems) if (!systems.has(s)) out.push(`edge "${e.id}" names unknown system "${s}"`);
    if (e.route === "path" && !(e.path && e.path.length)) out.push(`edge "${e.id}" has route "path" but no bend points`);
  }
  return out;
}

export function emptyKnown(atlasId) {
  return { schemaVersion: KNOWN_SCHEMA_VERSION, atlasId, known: {}, log: [] };
}
