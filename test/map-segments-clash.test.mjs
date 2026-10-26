// map-segments clash checks (clash.mjs via the assembler), on synthetic segments only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleComposition } from "../map-segments/assemble.mjs";
import { clashWarnings, deltaE, CLASH_DEFAULTS } from "../map-segments/clash.mjs";
import { Segment } from "../map-segments/composition.mjs";

const OPEN_E = { n: [], e: [{ kind: "walk", from: 0, to: 4 }], s: [], w: [{ kind: "walk", from: 0, to: 4 }] };
const seg = (id, over = {}) => ({
  schema: 2, id, gridSize: 100, widthSquares: 4, heightSquares: 4,
  variants: { day: "day.webp", night: "night.webp", gore: "gore.webp" }, walls: [], edges: OPEN_E,
  variantInfo: { day: { state: "clean", time: "day" }, night: { state: "clean", time: "night" }, gore: { state: "massacre", time: "day" } },
  colours: { "day.webp": [50, 0, 10], "night.webp": [20, 5, -20], "gore.webp": [45, 25, 15] },
  ...over
});
const LIB = {
  hall: seg("hall", { tags: { role: "corridor", floor: ["stone"], light: "top" } }),
  shrine: seg("shrine", { tags: { role: "set-piece", unique: true, floor: ["stone"] } }),
  deck: seg("deck", { tags: { role: "room", floor: ["wood"] } }),
  stair: seg("stair", { tags: { role: "transition", floor: ["wood"] } }),
  west: seg("west", { tags: { light: "w" } }),
  east: seg("east", { tags: { light: "e" } }),
  bare: { schema: 1, id: "bare", gridSize: 100, widthSquares: 4, heightSquares: 4, variants: { day: "day.webp", night: "night.webp" }, walls: [], edges: OPEN_E }
};
const load = (id) => LIB[id];
// A row of pieces, 4 squares apart, joined by OPEN openings unless kinds says otherwise.
const row = (specs, over = {}) => ({
  schema: 1, name: "T", library: "lib", widthSquares: 4 * specs.length, heightSquares: 4,
  pieces: specs.map(([segment, variant], i) => ({ key: String.fromCharCode(65 + i), segment, variant, at: [4 * i, 0] })),
  openings: specs.slice(1).map((_, i) => ({ id: `o${i + 1}`, line: "v", at: 4 * (i + 1), from: 1, to: 3, kind: over.kinds?.[i] ?? "open" })),
  ...(over.comp ?? {})
});
const codes = (a) => a.warnings.map((w) => w.code).sort();

test("untagged v1 segments never warn, and v1 still parses beside v2", () => {
  const a = assembleComposition(row([["bare", "day"], ["bare", "night"]]), load);
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(a.problems, []);
});

test("segment v2: sockets on exits are allowed, an unknown schema is not", () => {
  assert.ok(Segment.parse({ ...LIB.hall, edges: { ...OPEN_E, e: [{ kind: "walk", from: 0, to: 2, socket: "corridor-2" }] } }));
  assert.throws(() => Segment.parse({ ...LIB.hall, schema: 3 }));
  assert.throws(() => Segment.parse({ ...LIB.hall, tags: { role: "attic" } }));
});

test("overlapping pieces are a problem, not a warning", () => {
  const c = row([["hall", "day"], ["hall", "day"]]);
  c.pieces[1].at = [2, 0]; c.openings = [];
  assert.deepEqual(assembleComposition(c, load).problems, ["A and B overlap"]);
});

test("a unique landmark used twice warns once, with both pieces named", () => {
  const a = assembleComposition(row([["shrine", "day"], ["hall", "day"], ["shrine", "day"]]), load);
  const w = a.warnings.find((x) => x.code === "unique-repeat");
  assert.equal(w.id, "unique-repeat:shrine");
  assert.deepEqual(w.pieces, ["A", "C"]);
});

test("mixed story state names the odd piece out against the majority", () => {
  const a = assembleComposition(row([["hall", "day"], ["hall", "gore"], ["hall", "day"]], { kinds: ["door", "door"] }), load);
  const w = a.warnings.find((x) => x.code === "mixed-state");
  assert.deepEqual(w.pieces, ["B"]);
  assert.match(w.message, /B is massacre, while the other 2 are clean/);
});

test("mixed time of day warns; variants without time are left out", () => {
  const a = assembleComposition(row([["hall", "day"], ["hall", "night"]], { kinds: ["door"] }), load);
  assert.deepEqual(codes(a), ["mixed-time"]);
  const b = assembleComposition(row([["bare", "day"], ["hall", "night"]], { kinds: ["door"] }), load);
  assert.deepEqual(codes(b), []);
});

test("light direction: different sides warn, overhead light goes with anything", () => {
  assert.deepEqual(codes(assembleComposition(row([["west", "day"], ["east", "day"]], { kinds: ["door"] }), load)), ["mixed-light"]);
  assert.deepEqual(codes(assembleComposition(row([["west", "day"], ["hall", "day"]], { kinds: ["door"] }), load)), []);
});

test("floor jump: only across an OPEN join, and a transition piece or a door excuses it", () => {
  assert.deepEqual(codes(assembleComposition(row([["hall", "day"], ["deck", "day"]]), load)), ["floor-jump"]);
  assert.deepEqual(codes(assembleComposition(row([["hall", "day"], ["deck", "day"]], { kinds: ["door"] }), load)), []);
  assert.deepEqual(codes(assembleComposition(row([["hall", "day"], ["stair", "day"], ["deck", "day"]]), load)), []);
});

test("colour jump: measured ΔE across an open join, with a per-map limit", () => {
  // day [50,0,10] vs night [20,5,-20]: ΔE ≈ 42.7, but those also differ in time; compare day vs gore instead.
  const d = deltaE([50, 0, 10], [45, 25, 15]);
  assert.ok(d > CLASH_DEFAULTS.colourDelta);
  const a = assembleComposition(row([["hall", "day"], ["hall", "gore"]]), load);
  const w = a.warnings.find((x) => x.code === "colour-jump");
  assert.equal(w.id, "colour-jump:o1"); assert.equal(w.deltaE, Math.round(d)); assert.equal(w.opening, "o1");
  const loose = assembleComposition(row([["hall", "day"], ["hall", "gore"]], { comp: { clash: { colourDelta: 40 } } }), load);
  assert.ok(!loose.warnings.some((x) => x.code === "colour-jump"));
});

test("clash.ignore drops exactly the accepted warnings", () => {
  const c = row([["hall", "day"], ["hall", "gore"]], { comp: { clash: { ignore: ["colour-jump:o1"] } } });
  assert.deepEqual(codes(assembleComposition(c, load)), ["mixed-state"]);
});

test("warnings never become problems", () => {
  const a = assembleComposition(row([["shrine", "day"], ["deck", "gore"], ["shrine", "night"]]), load);
  assert.ok(a.warnings.length >= 3);
  assert.deepEqual(a.problems, []);
});

test("clashWarnings is usable on its own (pure, no loader)", () => {
  const placed = [{ key: "A", segment: "hall", seg: LIB.hall, variant: "day", file: "day.webp" }];
  assert.deepEqual(clashWarnings({ clash: undefined }, placed, []), []);
});
