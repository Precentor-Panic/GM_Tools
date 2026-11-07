// map-plan/makers: the drawing surface, the tracer, the recipes, wear, turning plans. Deterministic: every test here
// runs on seeds, no published map involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Canvas } from "../map-plan/makers/canvas.mjs";
import { toPlan } from "../map-plan/makers/trace.mjs";
import { rng, fbm } from "../map-plan/makers/rng.mjs";
import { transformPlan } from "../map-plan/makers/transform.mjs";
import { makeTavern } from "../map-plan/makers/tavern.mjs";
import { makeTemple } from "../map-plan/makers/temple.mjs";
import { makeFort } from "../map-plan/makers/fort.mjs";
import { makeSewer } from "../map-plan/makers/sewer.mjs";
import { makeCave } from "../map-plan/makers/cave.mjs";
import { RECIPES, make } from "../map-plan/makers/index.mjs";
import { profile } from "../map-plan/profile.mjs";
import { briefScore } from "../map-plan/similar.mjs";
import { parsePlan, segments, shapePolygon } from "../map-plan/plan.mjs";

const BRIEFS = JSON.parse(readFileSync(new URL("../map-plan/bench/briefs.json", import.meta.url), "utf8")).briefs;
const strip = ({ trace, links, regions, ...p }) => p;

test("rng: same seed, same stream; forks are independent and stable", () => {
  const a = rng(7), b = rng(7);
  assert.deepEqual([a.next(), a.next(), a.int(1, 6)], [b.next(), b.next(), b.int(1, 6)]);
  assert.equal(rng(7).fork("x").next(), rng(7).fork("x").next());
  assert.notEqual(rng(7).fork("x").next(), rng(7).fork("y").next());
  const v = fbm(3.3, 4.4, [[2, 1], [1, 0.5]], 9);
  assert.ok(v >= 0 && v <= 1);
});

test("trace: two rooms, a door, a window, a round tower and a chamfer come out true", () => {
  const cv = new Canvas(24, 16, { voidKind: "ground" });
  const hall = cv.region({ kind: "floor", key: "hall" }), back = cv.region({ kind: "floor", key: "back" }), tower = cv.region({ kind: "floor", key: "tower" });
  cv.paint({ rect: [2, 2, 12, 8] }, hall);
  cv.paint({ rect: [2, 10, 12, 4] }, back);
  cv.paint({ circle: [16, 6, 3] }, tower);
  cv.paint({ polygon: [[2, 2], [5, 2], [2, 5]] }, 0);
  const plan = toPlan(cv, { links: [{ a: "hall", b: "back", kind: "door", at: [5, 10] }, { a: "hall", b: "tower", kind: "arch", width: 1.5 },
    { a: "back", b: "void", kind: "door", at: [12, 14] }, { a: "hall", b: "void", kind: "window", at: [9, 2] }] });
  const doors = plan.walls.filter((w) => w.kind === "door");
  assert.equal(doors.length, 2);
  // The inner door sits on y = 10, centred where asked, one square wide.
  const d = doors.find((w) => w.points.every(([, y]) => Math.abs(y - 10) < 1e-6));
  assert.ok(d, "a door on the shared wall");
  assert.ok(Math.abs((d.points[0][0] + d.points[1][0]) / 2 - 5) < 0.07 && Math.abs(Math.abs(d.points[1][0] - d.points[0][0]) - 1) < 1e-6);
  assert.equal(plan.walls.filter((w) => w.kind === "window").length, 1);
  // Straight walls are exactly on their lines: every wall point of the back room is on x=2, x=14, y=10 or y=14.
  const backArea = plan.areas.find((a) => a.id === "back");
  for (const [x, y] of backArea.shape.polygon) assert.ok([2, 14].includes(+x.toFixed(6)) || [10, 14].includes(+y.toFixed(6)), `${x},${y} off the box`);
  // The chamfer is one straight diagonal; the tower's wall is round (every point within 0.03 of the circle).
  const segs = segments(plan);
  assert.ok(segs.some((s) => Math.abs(Math.abs(s.b[0] - s.a[0]) - Math.abs(s.b[1] - s.a[1])) < 1e-6 && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 4));
  const towerArea = plan.areas.find((a) => a.id === "tower");
  const off = towerArea.shape.polygon.filter(([x, y]) => x > 14.1).map(([x, y]) => Math.abs(Math.hypot(x - 16, y - 6) - 3));
  assert.ok(off.length > 12 && Math.max(...off) < 0.03, `tower wall off the circle by ${Math.max(...off)}`);
  // The arch merges hall and tower into one room; the door splits the back room off.
  assert.equal(profile(plan).rooms.count, 2);
});

test("trace: neighbouring rooms share exactly the same edge", () => {
  const cv = new Canvas(20, 12, { voidKind: "ground" });
  const a = cv.region({ kind: "floor", key: "a" }), b = cv.region({ kind: "floor", key: "b" });
  cv.paint({ rect: [2, 2, 8, 8] }, a);
  cv.paint({ polygon: [[10, 2], [17, 3.3], [16.2, 9.6], [10, 10]] }, b);
  const plan = toPlan(cv, {});
  const pa = plan.areas.find((x) => x.id === "a").shape.polygon, pb = plan.areas.find((x) => x.id === "b").shape.polygon;
  const onShared = (p) => Math.abs(p[0] - 10) < 1e-9;
  assert.deepEqual(pa.filter(onShared).map((p) => p[1]).sort(), pb.filter(onShared).map((p) => p[1]).sort());
});

test("trace: an edge override turns a boundary into a ledge, and a link still cuts it", () => {
  const cv = new Canvas(16, 10, { voidKind: "rock", organicRock: false });
  const lo = cv.region({ kind: "floor", key: "lo" }), hi = cv.region({ kind: "floor", key: "hi" });
  cv.paint({ rect: [1, 1, 7, 8] }, lo); cv.paint({ rect: [8, 1, 7, 8] }, hi);
  const plan = toPlan(cv, { edges: [{ a: "lo", b: "hi", kind: "ledge" }], links: [{ a: "lo", b: "hi", kind: "arch", width: 2, at: [8, 7] }] });
  const ledge = plan.walls.filter((w) => w.kind === "ledge");
  assert.ok(ledge.length === 2 && ledge.every((w) => w.move && !w.sight));
  const len = ledge.reduce((s, w) => s + Math.hypot(w.points[1][0] - w.points[0][0], w.points[1][1] - w.points[0][1]), 0);
  assert.ok(Math.abs(len - 6) < 1e-6, `ledge length ${len}`);
});

test("trace: walls carry a material: a building's outside, its partitions, a solid mass, a cave's rock", () => {
  const cv = new Canvas(14, 10, { voidKind: "ground", outerWall: "stone", innerWall: "wood" });
  const a = cv.region({ kind: "floor", key: "a" }), b = cv.region({ kind: "floor", key: "b" }), m = cv.region({ kind: "solid", key: "m", material: "brick" });
  cv.paint({ rect: [1, 1, 6, 6] }, a); cv.paint({ rect: [7, 1, 6, 6] }, b); cv.paint({ rect: [3, 3, 1, 1] }, m);
  const mats = new Set(toPlan(cv, {}).walls.map((w) => w.material));
  assert.deepEqual([...mats].sort(), ["brick", "stone", "wood"]);
  const { plan } = makeCave({ width: 20, height: 14, chambers: [{ id: "c", at: [10, 7], r: 4 }], passages: [] }, 3);
  assert.ok(plan.walls.length && plan.walls.every((w) => w.material === "rock"));
});

test("recipes: deterministic by seed, different seeds differ, every plan valid", () => {
  for (const name of Object.keys(RECIPES)) {
    const a = JSON.stringify(strip(make(name, {}, 4))), b = JSON.stringify(strip(make(name, {}, 4))), c = JSON.stringify(strip(make(name, {}, 5)));
    assert.equal(a, b, `${name} not deterministic`);
    assert.notEqual(a, c, `${name} ignores its seed`);
    parsePlan(JSON.parse(a));
  }
});

test("recipes: each lands near its benchmark brief over a few seeds", () => {
  // The bar is "close": a brief score under 0.6 on average (0 = inside every range). The S3 review page shows the
  // numbers per map; this keeps a recipe from drifting far from what it was made for.
  for (const [name, briefId] of [["tavern", "tavern"], ["temple", "temple-hall"], ["fort", "ruined-fort"], ["cave", "river-cave"], ["sewer", "sewer-junction"]]) {
    const want = BRIEFS.find((x) => x.id === briefId).want;
    const scores = [1, 2, 3].map((s) => briefScore(profile(make(name, {}, s)), want));
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    assert.ok(mean < 0.6, `${name}: mean brief score ${mean.toFixed(2)} (${scores.map((v) => v.toFixed(2)).join(", ")})`);
  }
});

test("recipes: the tavern has its rooms and the temple its axis", () => {
  const t = makeTavern({ mirror: false }, 2);
  const labels = new Set(t.areas.map((a) => a.label));
  for (const l of ["common room", "kitchen", "stair hall", "back room", "yard", "street"]) assert.ok(labels.has(l), `tavern lacks ${l}`);
  assert.ok(t.items.some((i) => i.what === "bar counter") && t.items.some((i) => i.what === "fireplace"));
  assert.ok(t.walls.some((w) => w.kind === "door") && t.walls.some((w) => w.kind === "window"));
  const tp = makeTemple({ mirror: false }, 2), p = profile(tp);
  assert.ok(p.walls.squareness > 0.6 && p.building.rooms >= 3);
  assert.ok(tp.items.filter((i) => i.what === "pew").length >= 8);
});

test("wear: a ruined fort is rougher than a whole one, and its breach opens the yard", () => {
  const whole = profile(makeFort({ ruin: false, round: false, mirror: false }, 3)), ruin = profile(makeFort({ ruin: true, round: false, mirror: false }, 3));
  assert.ok(ruin.walls.organic > whole.walls.organic + 0.04, `organic ${whole.walls.organic} -> ${ruin.walls.organic}`);
  assert.ok(ruin.enclosure < whole.enclosure, "the breach should make the yard part of the outside");
});

test("transform: mirror twice and four turns are the identity; a turn swaps the sides", () => {
  const p = strip(makeSewer({ mirror: false }, 2));
  // Compare what moves: area outlines (as polygons), walls, items (a missing turn reads as 0), lights, marks.
  const round = (q) => JSON.parse(JSON.stringify({ w: q.width, h: q.height, areas: q.areas.map((a) => shapePolygon(a.shape)), walls: q.walls.map((w) => w.points),
    items: q.items.map((i) => [i.x, i.y, ((i.rotation ?? 0) % 360 + 360) % 360]), lights: q.lights, marks: q.marks }, (k, v) => (typeof v === "number" ? +v.toFixed(3) : v)));
  assert.deepEqual(round(transformPlan(transformPlan(p, { mirror: true }), { mirror: true })), round(p));
  let q = p; for (let i = 0; i < 4; i++) q = transformPlan(q, { turn: 1 });
  assert.deepEqual(round(q), round(p));
  const t = transformPlan(p, { turn: 1 });
  assert.equal(t.width, p.height); assert.equal(t.height, p.width);
  assert.equal(profile(parsePlan(t)).rooms.count, profile(parsePlan(p)).rooms.count);
});

test("profile v3: a cave whose mouth runs off the map is a room; a rock mass inside it is a loop", () => {
  const { plan } = makeCave({ width: 30, height: 20,
    chambers: [{ id: "a", at: [8, 10], r: 4 }, { id: "b", at: [21, 10], r: 4 }],
    passages: [{ a: [-3, 10], b: "a", width: 3, wind: 0 }, { a: "a", b: [15, 5], width: 2.4, wind: 0 }, { a: [15, 5], b: "b", width: 2.4, wind: 0 },
      { a: "a", b: [15, 15], width: 2.4, wind: 0 }, { a: [15, 15], b: "b", width: 2.4, wind: 0 }] }, 11);
  const p = profile(plan);
  assert.ok(p.rooms.count >= 1 && p.enclosure > 0.2, `enclosure ${p.enclosure}`);
  assert.ok(p.graph.loops >= 1, "the rock between the two passages is a way round");
});
