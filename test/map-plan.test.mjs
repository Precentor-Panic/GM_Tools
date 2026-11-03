// map-plan: the map format, readers, character profile, similarity and preview. Synthetic fixtures only: no
// published map's walls belong in this public repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlan, segments, shapePolygon } from "../map-plan/plan.mjs";
import { fromDd2vtt, fromFoundryScene } from "../map-plan/readers.mjs";
import { profile, analyse } from "../map-plan/profile.mjs";
import { distance, briefScore, nearest, WANT_FEATURES } from "../map-plan/similar.mjs";
import { planSvg } from "../map-plan/svg.mjs";
import { themeFromText, kindsOfName, contentsFromItems, CONTENT_KINDS, PLACES, TERRAINS } from "../map-plan/theme.mjs";
import { groupLayouts, lookup, character } from "../map-plan/shelf.mjs";
import { lookJob, lookTags } from "../map-plan/look.mjs";

const box = (x, y, w, h) => ({ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]] });
const door = (a, b) => ({ points: [a, b], kind: "door", closed: true });
// Wall with a gap from `from` to `to` along a line, so a door can sit in it.
const hgap = (y, x0, x1, from, to) => [{ points: [[x0, y], [from, y]] }, { points: [[to, y], [x1, y]] }, door([from, y], [to, y])];
const vgap = (x, y0, y1, from, to) => [{ points: [[x, y0], [x, from]] }, { points: [[x, to], [x, y1]] }, door([x, from], [x, to])];

// Two rooms side by side in a 20 x 12 map: a door between them, and a door out of the left room.
function twoRooms() {
  return parsePlan({ width: 20, height: 12, walls: [
    ...hgap(2, 2, 10, 5, 6), { points: [[2, 2], [2, 10], [10, 10]] }, { points: [[10, 2], [18, 2], [18, 10], [10, 10]] },
    ...vgap(10, 2, 10, 5, 6),
  ] });
}

test("plan: schema fills defaults and rejects a bad shape", () => {
  const p = parsePlan({ width: 10, height: 8 });
  assert.equal(p.schemaVersion, 1);
  assert.deepEqual([p.areas, p.walls, p.art], [[], [], []]);
  assert.throws(() => parsePlan({ width: 10, height: 8, areas: [{ id: "a", kind: "floor", shape: { polygon: [[0, 0], [1, 1]] } }] }));
  assert.equal(shapePolygon({ circle: [0, 0, 1] }, 8).length, 8);
  assert.equal(segments(parsePlan({ width: 4, height: 4, walls: [box(0, 0, 2, 2)] })).length, 4);
});

test("profile: two rooms, one door between and one out", () => {
  const p = profile(twoRooms());
  assert.equal(p.rooms.count, 2);
  assert.equal(p.graph.links, 2);
  assert.equal(p.graph.doorsOut, 1);
  assert.equal(p.graph.loops, 0);
  assert.equal(p.graph.deadEnds, 1); // the right room is reached only from the left
  assert.equal(p.walls.squareness, 1);
  // An 8 x 8 room measures a little under 64: the walls, grown to close gaps, take up to half a square.
  assert.ok(p.rooms.median > 44 && p.rooms.median <= 64, `room size ${p.rooms.median}`);
  assert.deepEqual([p.building.count, p.building.rooms], [1, 2]);
  assert.ok(p.enclosure > 0.4 && p.enclosure < 0.7, `enclosure ${p.enclosure}`);
  assert.equal(p.footprint.rooms.length, 144);
});

test("profile: a room cropped tight to the map edge is still a room", () => {
  // Walls on the map's right and bottom edges sit exactly on width/height.
  const p = profile(parsePlan({ width: 10, height: 8, walls: [box(0, 0, 10, 8)] }));
  assert.equal(p.rooms.count, 1);
  assert.equal(p.enclosure, 1);
});

test("profile: four rooms round a solid block make one loop", () => {
  // A 12 x 12 building with a solid 4 x 4 block in the middle, split into a ring of four rooms by a wall from each
  // side of the block to the outer wall, each with a door in it.
  const walls = [box(1, 1, 12, 12), box(5, 5, 4, 4),
    ...vgap(7, 1, 5, 2, 3), ...vgap(7, 9, 13, 11, 12), ...hgap(7, 1, 5, 2, 3), ...hgap(7, 9, 13, 11, 12)];
  const p = profile(parsePlan({ width: 14, height: 14, walls }));
  assert.equal(p.rooms.count, 4); // the block is solid, not a fifth room
  assert.equal(p.graph.links, 4);
  assert.equal(p.graph.loops, 1);
  assert.equal(p.graph.deadEnds, 0);
});

test("profile: a gap under half a square doesn't leak a room", () => {
  // A 6 x 6 room whose corner walls stop 0.3 squares short of meeting.
  const p = profile(parsePlan({ width: 10, height: 10, walls: [
    { points: [[2, 2], [7.7, 2]] }, { points: [[8, 2.3], [8, 8]] }, { points: [[8, 8], [2, 8]] }, { points: [[2, 8], [2, 2]] }] }));
  assert.equal(p.rooms.count, 1);
});

test("profile: a round room is organic, open ground is open", () => {
  const ring = shapePolygon({ circle: [10, 10, 7] }, 36);
  const round = profile(parsePlan({ width: 20, height: 20, walls: [{ points: [...ring, ring[0]] }] }));
  assert.ok(round.walls.organic > 0.6, `organic ${round.walls.organic}`);
  assert.ok(round.walls.squareness < 0.25);
  const field = profile(parsePlan({ width: 30, height: 20 }));
  assert.equal(field.rooms.count, 0);
  assert.equal(field.enclosure, 0);
  assert.ok(field.openness.median > 0.95);
  assert.ok(field.openness.longest >= 25, `longest ${field.openness.longest}`);
});

test("readers: Foundry scene walls in both eras, padding offset, doors and windows", () => {
  const scene = { name: "t", width: 1000, height: 800, grid: 100, padding: 0.25, walls: [
    { c: [300, 200, 1300, 200], move: 1, sense: 1, door: 0 },          // v9 wall along the top
    { c: [300, 200, 300, 1000], move: 1, sense: 1, door: 1, ds: 0 },   // v9 closed door down the left
    { c: [1300, 200, 1300, 1000], move: 20, sight: 0, door: 0 },       // v10: stops feet, not eyes
    { c: [300, 1000, 1300, 1000], move: 0, sight: 20, door: 0 },       // v10: stops eyes only
    { c: [400, 300, 600, 300], move: 20, sight: 10, door: 0 },         // v10 limited: a hedge
    { c: [400, 500, 600, 500], move: 1, sense: 2, door: 0 },           // v9 limited
  ], lights: [{ x: 800, y: 600, config: { dim: 30, bright: 15 } }] };
  const p = fromFoundryScene(scene, { pack: "synthetic" });
  assert.deepEqual([p.width, p.height], [10, 8]);
  assert.deepEqual(p.walls[0].points, [[0, 0], [10, 0]]);
  assert.deepEqual(p.walls.map((w) => w.kind), ["wall", "door", "window", "invisible", "terrain", "terrain"]);
  assert.equal(p.walls[1].closed, true);
  assert.deepEqual([p.walls[2].move, p.walls[2].sight], [true, false]);
  assert.deepEqual(p.lights[0], { x: 5, y: 4, dim: 30, bright: 15 });
  assert.equal(p.source.pack, "synthetic");
});

test("readers: dd2vtt portals become doors across the gap", () => {
  const d = { resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 8, y: 6 }, pixels_per_grid: 100 },
    line_of_sight: [[{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 5 }, { x: 1, y: 5 }, { x: 1, y: 3.5 }], [{ x: 1, y: 2.5 }, { x: 1, y: 1 }]],
    portals: [{ position: { x: 1, y: 3 }, bounds: [{ x: 1, y: 2.5 }, { x: 1, y: 3.5 }], closed: true }], lights: [] };
  const p = fromDd2vtt(d);
  assert.equal(p.walls.filter((w) => w.kind === "door").length, 1);
  const pr = profile(p);
  assert.equal(pr.rooms.count, 1);
  assert.equal(pr.graph.doorsOut, 1);
});

test("similar: distance, nearest and brief ranges", () => {
  const a = profile(twoRooms()), field = profile(parsePlan({ width: 30, height: 20 }));
  const round = profile(parsePlan({ width: 20, height: 20, walls: [{ points: [...shapePolygon({ circle: [10, 10, 7] }, 36), [17, 10]] }] }));
  assert.equal(distance(a, a), 0);
  assert.ok(distance(a, round) < distance(a, field));
  const rows = [{ id: "field", profile: field }, { id: "round", profile: round }, { id: "two", profile: a }];
  assert.equal(nearest(a, rows, 1)[0].id, "two");
  assert.equal(nearest({ enclosure: [null, 0.1] }, rows, 1)[0].id, "field");
  assert.equal(briefScore(a, { rooms: [1, 3], squareness: [0.9, null] }), 0);
  assert.ok(briefScore(a, { rooms: [5, 8] }) > 0);
  assert.throws(() => briefScore(a, { rooms_count: [1, 2] }), /unknown feature/);
});

test("bench: every brief's wants name known features", () => {
  const bench = JSON.parse(readFileSync(new URL("../map-plan/bench/briefs.json", import.meta.url), "utf8"));
  assert.equal(bench.briefs.length, 9);
  for (const b of bench.briefs) for (const k of Object.keys(b.want)) assert.ok(WANT_FEATURES.includes(k), `${b.id}: ${k}`);
});

test("svg: a preview with rooms, walls and the door", () => {
  const plan = twoRooms();
  const svg = planSvg(plan, { analysis: analyse(plan), title: "two <rooms>" });
  assert.match(svg, /^<svg /);
  assert.match(svg, /#e0a040/);       // a door
  assert.match(svg, /hsl\(/);         // a tinted room
  assert.match(svg, /two &lt;rooms&gt;/);
});

test("theme: place, terrain, mood and setting from names, camelCase and plurals included", () => {
  const t = themeFromText("Riverside Inn - Upstairs (WinterNight)");
  assert.deepEqual(t.place, ["tavern"]);
  assert.deepEqual(t.terrain, ["river", "snow"]);
  assert.deepEqual(t.mood, ["night", "winter"]);
  assert.equal(t.setting, "interior");
  assert.deepEqual(themeFromText("Goblin Bridge, Night").place, ["bridge"]);
  assert.equal(themeFromText("The Yard and the Hall").setting, null); // both: say neither
});

test("contents: kinds from asset and object names", () => {
  assert.deepEqual(kindsOfName("res://packs/x/Barrel_Wood_Dark_A_1x1.webp"), ["storage"]);
  assert.deepEqual(kindsOfName("Gore/Corpses/Humanoid/Burnt_Body_A_01_1x2.webp"), ["remains"]);
  assert.deepEqual(kindsOfName("tables"), ["seating"]);
  assert.deepEqual(kindsOfName("Wall_Torch_01_A_Lit_1x1"), []);
  assert.deepEqual(contentsFromItems([{ what: "Crate_A" }, { what: "barrel" }, { what: "altar", kinds: ["altar"] }]),
    { count: 3, kinds: { storage: 2, altar: 1 } });
});

test("profile v2: room bands, see-through and terrain walls, lit rooms, items", () => {
  const base = twoRooms();
  const p = profile(parsePlan({ ...base, walls: [...base.walls,
    { points: [[12, 8], [16, 8]], kind: "window", move: true, sight: false },
    { points: [[3, 8], [6, 8]], kind: "terrain", move: true, sight: false }],
    lights: [{ x: 4, y: 4 }], items: [{ what: "Table_Wood", x: 4, y: 4 }, { what: "chair", x: 5, y: 4 }] }));
  assert.equal(p.schemaVersion, 2);
  assert.equal(p.rooms.bands.medium, 2); // two 8 x 8 rooms
  assert.deepEqual([p.features.windows, p.features.low, p.features.litRooms], [4, 3, 0.5]);
  assert.deepEqual(p.items.kinds, { seating: 2 });
  assert.ok(p.items.density > 1 && p.items.density < 3);
});

test("shelf: variants of one layout group; a brief scores shape, theme and contents and says what matched", () => {
  const p = profile(twoRooms());
  const other = profile(parsePlan({ width: 20, height: 12, walls: [box(1, 1, 18, 10)] }));
  const rows = [
    { id: "a/day", pack: "a", name: "Riverside Inn Day", profile: p, theme: themeFromText("Riverside Inn Day") },
    { id: "a/night", pack: "a", name: "Riverside Inn Night", profile: p, theme: themeFromText("Riverside Inn Night") },
    { id: "a/hall", pack: "a", name: "Great Hall", profile: other, theme: themeFromText("Great Hall") },
    { id: "b/inn", pack: "b", name: "Inn", profile: p, theme: themeFromText("Inn"), look: { place: [], terrain: [], contents: { bar: 1, seating: 2 } } },
  ];
  const groups = groupLayouts(rows);
  assert.equal(groups.length, 3);
  assert.equal(rows[0].layout, rows[1].layout);
  const brief = { want: { buildingRooms: [2, 4] }, theme: { place: ["tavern"] }, contents: ["bar", "seating", "hearth"] };
  const hits = lookup(brief, rows, 3);
  assert.equal(hits[0].r.id, "b/inn");
  assert.deepEqual(hits[0].matched, { theme: ["tavern"], contents: ["bar", "seating"] });
  assert.equal(hits[1].variants.length, 1); // day and night: one entry
  assert.ok(Math.abs(hits[1].parts.contents) < 1e-9 && hits[1].parts.theme === 1 && hits[1].parts.shape === 1);
  const c = character(rows[3]);
  assert.match(c.size, /2 rooms \(2 medium\)/);
  assert.match(c.contents, /seating, bar/);
});

test("look: jobs mark rooms and outside per square; tags keep only what stands out across the shelf", () => {
  const plan = twoRooms(), A = analyse(plan);
  const job = lookJob(plan, A, { id: "x", img: "/nowhere.jpg", gridPx: 100, sceneW: 2000, sceneH: 1200 });
  assert.equal(job.cells.length, 20 * 12);
  assert.equal(job.cells[0], -1);                      // corner: outside
  assert.equal(job.rooms.length, 2);
  assert.ok(job.rooms.includes(job.cells[5 * 20 + 5])); // middle of the left room
  const base = CONTENT_KINDS.map(() => 0.2);
  const looks = [0, 1, 2, 3].map((i) => ({ id: `m${i}`, emb: [1, 0], place: { ...Object.fromEntries(PLACES.map((p) => [p, 0.2])), tavern: i === 0 ? 0.3 : 0.2 },
    terrain: Object.fromEntries(TERRAINS.map((t) => [t, 0.2])), rooms: { 1: base.map((v, j) => (i === 0 && CONTENT_KINDS[j] === "bar" ? 0.3 : v + 0.001 * i)) }, out: null }));
  const tags = lookTags(looks);
  assert.deepEqual(tags.get("m0").place, ["tavern"]);
  assert.deepEqual(tags.get("m0").rooms["1"].slice(0, 1), ["bar"]);
  assert.deepEqual(tags.get("m0").contents.bar, 1);
});
