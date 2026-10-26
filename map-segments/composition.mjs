// Map segments: the two persisted formats.
//
// A SEGMENT is one grid-aligned piece cut from a published battle map: its art
// in several variants (all the same size, so they swap in place), its walls in
// segment-local pixels, and its exits tagged per side. Written by
// map-segments/tools/cut.py as <library>/<segment-id>/segment.json.
//
// A COMPOSITION places segments on a grid and says where they open into each
// other. assemble.mjs turns one into tiles + walls for the bridge's
// set_scene_layout op.
//
// SCHEMA HISTORY
//   segment v1 (2026-10-24): prototype shape, kept verbatim (edges/shape/themes
//     were added by hand after the cut, so they are optional).
//   composition v1 (2026-10-25): pieces/openings as prototyped, plus optional
//     `overlays` (tinted tiles over a piece, e.g. a water layer), `seams`, an
//     opaque `puzzle` passed to the scene, and opening `via: "any"`.
//   segment v2 (2026-10-26): adds what the clash checks read (clash.mjs), all
//     optional so v1 files still load unchanged:
//       tags        { role, unique, setting, floor[], light }   set by a person (tag.py applies a pack's tag sheet)
//       variantInfo { <variant>: { state, time } }               story state ("clean" when absent) and time of day
//       colours     { <file>: [L, a, b] }                        mean Lab colour per art file, measured by tag.py
//     and an optional `socket` name on each exit (standard exit positions, used by kits).
//   composition v1, additive (2026-10-26): optional `clash` { colourDelta, ignore[] }
//     to tune the clash checks per map and dismiss a warning the GM has accepted.
import { z } from "zod";

export const SEGMENT_SCHEMA_VERSION = 2; // v1 still accepted
export const COMPOSITION_SCHEMA_VERSION = 1;

const Exit = z.object({ kind: z.enum(["walk", "water"]), from: z.number(), to: z.number(), socket: z.string().optional() });

// Free strings wherever a campaign or pack might need its own word (setting, floor, state, time).
export const SEGMENT_ROLES = ["corridor", "room", "transition", "set-piece"];
export const LIGHT_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw", "top"]; // where the light comes from; "top" = overhead, no cast direction
const Tags = z.object({
  role: z.enum(SEGMENT_ROLES).optional(),
  unique: z.boolean().optional(), // a landmark the players would notice twice
  setting: z.string().optional(),
  floor: z.array(z.string()).optional(),
  light: z.enum(LIGHT_DIRECTIONS).optional()
}).passthrough();
const VariantInfo = z.object({ state: z.string().optional(), time: z.string().optional() }).passthrough();
const Wall = z.object({ c: z.array(z.number()).length(4) }).passthrough();

export const Segment = z.object({
  schema: z.union([z.literal(1), z.literal(2)]),
  id: z.string().min(1),
  gridSize: z.number().positive(),
  widthSquares: z.number().int().positive(),
  heightSquares: z.number().int().positive(),
  variants: z.record(z.string(), z.string()),
  walls: z.array(Wall),
  edges: z.object({ n: z.array(Exit), e: z.array(Exit), s: z.array(Exit), w: z.array(Exit) }).nullable().optional(),
  themes: z.record(z.string(), z.object({ variants: z.record(z.string(), z.string()) }).passthrough()).optional(),
  tags: Tags.optional(),
  variantInfo: z.record(z.string(), VariantInfo).optional(),
  colours: z.record(z.string(), z.array(z.number()).length(3)).optional()
}).passthrough();

const Piece = z.object({
  key: z.string().min(1),
  segment: z.string().min(1),
  at: z.tuple([z.number().int(), z.number().int()]),
  variant: z.string().min(1),
  label: z.string().optional(),
  library: z.string().optional() // a piece from another pack's library
});

const Opening = z.object({
  id: z.string().min(1),
  line: z.enum(["h", "v"]), // h: a horizontal edge at y = at; v: a vertical edge at x = at
  at: z.number().int(),
  from: z.number(),
  to: z.number(),
  kind: z.enum(["open", "door"]),
  locked: z.boolean().optional(),
  via: z.enum(["walk", "water", "any"]).optional() // "any": a walk exit on one side may meet water on the other
}).refine((o) => o.to > o.from, { message: "opening `to` must be greater than `from`" });

const Overlay = z.object({
  key: z.string().min(1), // stable id the puzzle panel addresses
  piece: z.string().min(1),
  src: z.string().min(1),
  alpha: z.number().min(0).max(1).default(0),
  sort: z.number().default(500)
});

export const Composition = z.object({
  schema: z.literal(COMPOSITION_SCHEMA_VERSION),
  name: z.string().min(1),
  library: z.string().min(1), // Foundry-Data-relative folder holding the segments
  gridSize: z.number().positive().default(100),
  widthSquares: z.number().int().positive(),
  heightSquares: z.number().int().positive(),
  theme: z.string().optional(),
  backgroundColor: z.string().default("#0b0d0c"),
  pieces: z.array(Piece).min(1),
  openings: z.array(Opening).default([]),
  overlays: z.array(Overlay).default([]),
  seams: z.object({ width: z.number().positive().default(0.4), alpha: z.number().min(0).max(1).default(0.6) }).optional(),
  // Opaque to the assembler: a puzzle definition carried onto the scene (flags["world-fabric"].puzzle)
  // for the module's puzzle panel. Its shape is the panel's contract, not this schema's.
  puzzle: z.record(z.string(), z.unknown()).optional(),
  clash: z.object({
    colourDelta: z.number().positive().optional(), // ΔE between mean colours across an open join; clash.mjs has the default
    ignore: z.array(z.string()).default([])        // warning ids the GM has looked at and accepted
  }).optional()
}).superRefine((c, ctx) => {
  const keys = new Set();
  for (const p of c.pieces) {
    if (keys.has(p.key)) ctx.addIssue({ code: "custom", message: `duplicate piece key "${p.key}"` });
    keys.add(p.key);
  }
  for (const o of c.overlays) if (!keys.has(o.piece)) ctx.addIssue({ code: "custom", message: `overlay "${o.key}" names unknown piece "${o.piece}"` });
});
