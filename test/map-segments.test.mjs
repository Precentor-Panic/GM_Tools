// map-segments: composition schema + the pure assembler, on synthetic segments only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleComposition, layoutOpData, mergeIntervals, subtractIntervals } from "../map-segments/assemble.mjs";

const seg = (id, w, h, edges = { n: [], e: [], s: [], w: [] }, walls = []) => ({
  schema: 1, id, gridSize: 100, widthSquares: w, heightSquares: h,
  variants: { original: "original.webp", flooded: "flooded.webp" }, walls, edges
});
const LIB = {
  room: seg("room", 4, 4, { n: [], e: [{ kind: "walk", from: 1, to: 3 }], s: [], w: [] }, [{ c: [100, 100, 300, 100], move: 20, cut: true }]),
  hall: seg("hall", 6, 4, { n: [], e: [], s: [], w: [{ kind: "walk", from: 0, to: 4 }] })
};
const load = (id) => LIB[id];
const comp = (over = {}) => ({
  schema: 1, name: "Test", library: "lib", widthSquares: 10, heightSquares: 4,
  pieces: [{ key: "A", segment: "room", at: [0, 0], variant: "original" }, { key: "B", segment: "hall", at: [4, 0], variant: "flooded" }],
  openings: [{ id: "d1", line: "v", at: 4, from: 1, to: 2, kind: "door", locked: true }], ...over
});

test("intervals merge and subtract", () => {
  assert.deepEqual(mergeIntervals([[0, 4], [4, 10], [12, 13]]), [[0, 10], [12, 13]]);
  assert.deepEqual(subtractIntervals([[0, 10]], [[1, 2], [5, 6]]), [[0, 1], [2, 5], [6, 10]]);
});

test("one tile per piece, top-left pixels, the chosen variant", () => {
  const a = assembleComposition(comp(), load);
  assert.deepEqual(a.tiles.map((t) => [t.key, t.src, t.x, t.y, t.width, t.height]), [
    ["piece:A", "lib/room/original.webp", 0, 0, 400, 400], ["piece:B", "lib/hall/flooded.webp", 400, 0, 600, 400]]);
  assert.equal(a.width, 1000); assert.equal(a.height, 400);
  assert.deepEqual(a.pieces.B.variants.original, "lib/hall/original.webp");
  assert.deepEqual(a.problems, []);
});

test("segment walls move into place and lose the cut flag", () => {
  const w = assembleComposition(comp(), load).walls.find((x) => x.key === "seg:A");
  assert.deepEqual(w.c, [100, 100, 300, 100]); assert.equal(w.cut, undefined);
});

test("the shared edge is walled except the opening, which is a locked door", () => {
  const walls = assembleComposition(comp(), load).walls;
  const shared = walls.filter((x) => x.key === "edge" && x.c[0] === 400 && x.c[2] === 400).map((x) => x.c);
  assert.deepEqual(shared, [[400, 0, 400, 100], [400, 200, 400, 400]]);
  const door = walls.find((x) => x.key === "door:d1");
  assert.deepEqual(door.c, [400, 100, 400, 200]); assert.equal(door.door, 1); assert.equal(door.ds, 2);
});

test("an opening into solid art is reported", () => {
  const a = assembleComposition(comp({ openings: [{ id: "bad", line: "v", at: 4, from: 0, to: 1, kind: "open" }] }), load);
  assert.match(a.problems.join("\n"), /bad: no tagged walk exit on A \(room\) side e at 0-1/);
});

test("an opening on no edge, and a piece off the map, are reported", () => {
  const a = assembleComposition(comp({ widthSquares: 9, openings: [{ id: "x", line: "h", at: 2, from: 0, to: 1, kind: "open" }] }), load);
  assert.ok(a.problems.some((p) => p.startsWith("x: touches no piece edge")));
  assert.ok(a.problems.some((p) => p.startsWith("B: piece runs off")));
});

test("overlays cover their piece; seams add four strips per piece", () => {
  const a = assembleComposition(comp({ overlays: [{ key: "water:A", piece: "A", src: "w.png", alpha: 0.3 }], seams: { width: 0.5, alpha: 0.7 } }), load);
  const ov = a.tiles.find((t) => t.key === "overlay:water:A");
  assert.deepEqual([ov.x, ov.y, ov.width, ov.height, ov.alpha], [0, 0, 400, 400, 0.3]);
  assert.equal(a.tiles.filter((t) => t.key.startsWith("seam:")).length, 8);
});

test("schema refusals: unknown variant, duplicate key, unknown overlay piece, wrong schema", () => {
  assert.throws(() => assembleComposition(comp({ pieces: [{ key: "A", segment: "room", at: [0, 0], variant: "lava" }] }), load), /no variant "lava"/);
  assert.throws(() => assembleComposition(comp({ pieces: [{ key: "A", segment: "room", at: [0, 0], variant: "original" }, { key: "A", segment: "hall", at: [4, 0], variant: "original" }] }), load), /duplicate piece key/);
  assert.throws(() => assembleComposition(comp({ overlays: [{ key: "w", piece: "Z", src: "w.png" }] }), load), /unknown piece/);
  assert.throws(() => assembleComposition(comp({ schema: 2 }), load));
});

test("layoutOpData clears the old background and sets padding 0", () => {
  const d = layoutOpData("Scene.abc", assembleComposition(comp(), load));
  assert.equal(d.sceneUuid, "Scene.abc"); assert.equal(d.padding, 0);
  assert.deepEqual(d.background, { src: null, color: "#0b0d0c" });
});
