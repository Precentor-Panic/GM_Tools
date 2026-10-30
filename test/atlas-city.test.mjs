import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCity, fabricAt } from "../atlas/city.mjs";
import { parseAtlas } from "../atlas/schema.mjs";
import { pointInArea } from "../atlas/geometry.mjs";

const town = () => parseAtlas({
  schemaVersion: 1, id: "t", name: "t", revision: 0, units: "ft",
  frame: { bounds: [-1200, -1200, 1200, 1200] },
  strata: [{ id: "S0", name: "street", top: 0, bottom: 0 }],
  areas: [
    { id: "lake", name: "Lake", kind: "lake", shape: { type: "circle", cx: 0, cy: 0, r: 200 } },
    { id: "town", name: "Town", kind: "ring", shape: { type: "annulus", cx: 0, cy: 0, r0: 200, r1: 1000 }, fabric: { z: 1, lot: [25, 30] } },
    { id: "posh", name: "Posh", kind: "ring", shape: { type: "annulus", cx: 0, cy: 0, r0: 200, r1: 500 }, fabric: { z: 2, kind: "compounds", lot: [80, 90] } },
    { id: "pit", name: "Pit", kind: "arena", shape: { type: "polygon", points: [{ x: 600, y: -100 }, { x: 800, y: -100 }, { x: 800, y: 100 }, { x: 600, y: 100 }] } },
    { id: "wall", name: "Wall", kind: "wall", shape: { type: "annulus", cx: 0, cy: 0, r0: 980, r1: 1010 } },
  ],
  city: { seed: 3, bands: [{ r0: 210, r1: 970, block: [150, 70] }], avenues: [{ bearing: 0, width: 50 }] },
});

test("the highest-z fabric wins; reserved ground wins outright", () => {
  const a = town();
  assert.equal(fabricAt(a, { x: 300, y: 0 }).area, "posh");
  assert.equal(fabricAt(a, { x: 900, y: 0 }).area, "town");
  assert.equal(fabricAt(a, { x: 700, y: 0 }).reserved, true);
  assert.equal(fabricAt(a, { x: 0, y: 0 }).reserved, true);
});

test("houses fill the town but never the lake, the arena, the avenue or past the wall; same seed, same city", () => {
  const a = town();
  const c = buildCity(a);
  assert.ok(c.buildings.length > 200, `${c.buildings.length} buildings`);
  assert.ok(c.stats.posh > 0 && c.stats.town > 0);
  for (const b of c.buildings) for (const [x, y] of b.pts) {
    assert.ok(Math.hypot(x, y) > 200 && Math.hypot(x, y) <= 980.5);
    assert.ok(!pointInArea({ x, y }, a.areas.find((q) => q.id === "pit").shape));
  }
  const onAvenue = c.buildings.filter((b) => { const mx = (b.pts[0][0] + b.pts[2][0]) / 2, my = (b.pts[0][1] + b.pts[2][1]) / 2; return my < 0 && Math.abs(mx) < 20; });
  assert.equal(onAvenue.length, 0);
  assert.deepEqual(buildCity(town()).buildings, c.buildings);
});

test("open blocks and patchy density thin the city unevenly, deterministically", async () => {
  const { buildCity } = await import("../atlas/city.mjs");
  const base = {
    frame: { centre: { x: 0, y: 0 } },
    city: { seed: 3, street: 16, bands: [{ r0: 1000, r1: 3000, block: [200, 80] }] },
    areas: [{ id: "town", name: "Town", kind: "ring", shape: { type: "annulus", cx: 0, cy: 0, r0: 900, r1: 3100 }, fabric: { z: 1, kind: "houses", lot: [22, 28], vacancy: 0.04 } }],
  };
  const even = buildCity(base);
  const loose = structuredClone(base);
  loose.areas[0].fabric = { ...loose.areas[0].fabric, open: 0.15, patchy: 0.6 };
  const a = buildCity(loose), b = buildCity(loose);
  assert.equal(a.buildings.length, b.buildings.length, "same seed, same city");
  assert.ok(a.opens.length > 0, "some blocks are left open");
  assert.ok(a.buildings.length < even.buildings.length * 0.9, "noticeably fewer houses");
});

test("the old grid: uniform, aligned to city.grid, kept inside its area; nothing else is built over it", async () => {
  const { buildCity, fabricAt } = await import("../atlas/city.mjs");
  const atlas = {
    frame: { centre: { x: 0, y: 0 } },
    city: { seed: 5, street: 14, bands: [{ r0: 300, r1: 2000, block: [180, 90] }], grid: { angle: 12, block: [240, 240], street: 30 } },
    areas: [
      { id: "town", name: "Town", kind: "ring", shape: { type: "annulus", cx: 0, cy: 0, r0: 200, r1: 2100 }, fabric: { z: 1, lot: [22, 28] } },
      { id: "old", name: "Old", kind: "quarter", shape: { type: "circle", cx: 1000, cy: 0, r: 500 }, fabric: { z: 3, plan: "grid", lot: [30, 45] } },
    ],
  };
  const c = buildCity(atlas);
  const old = c.buildings.filter((b) => b.area === "old");
  assert.ok(old.length > 40, `${old.length} grid buildings`);
  const t = (12 * Math.PI) / 180;
  for (const b of old) {
    const [[x0, y0], [x1, y1]] = b.pts;
    const a = Math.atan2(y1 - y0, x1 - x0);
    const off = Math.abs(Math.sin(2 * (a - t)));
    assert.ok(off < 1e-2, "every grid edge runs along or across the grid");
    for (const [x, y] of b.pts) assert.equal(fabricAt(atlas, { x, y })?.area, "old");
  }
  const houses = old.filter((b) => b.kind === "houses");
  const fronts = new Set(houses.map((b) => Math.round(Math.hypot(b.pts[1][0] - b.pts[0][0], b.pts[1][1] - b.pts[0][1]))));
  assert.ok(fronts.size <= 3, `frontages are uniform (${[...fronts]})`);
  for (const b of c.buildings.filter((b) => b.area !== "old"))
    for (const [x, y] of b.pts) assert.notEqual(fabricAt(atlas, { x, y })?.area, "old");
  assert.deepEqual(buildCity(atlas).buildings, c.buildings);
});

test("sprawl: cross streets run askew, and the same seed gives the same town", async () => {
  const { buildCity } = await import("../atlas/city.mjs");
  const mk = (plan) => ({
    frame: { centre: { x: 0, y: 0 } },
    city: { seed: 9, street: 14, bands: [{ r0: 1000, r1: 2400, block: [200, 120] }] },
    areas: [{ id: "town", name: "Town", kind: "ring", shape: { type: "annulus", cx: 0, cy: 0, r0: 900, r1: 2500 }, fabric: { z: 1, lot: [18, 60], plan } }],
  });
  // A house's side edge (pts[1] -> pts[2]) runs radially in a ring block; in sprawl the block ends are askew, so the
  // end houses facing the side streets are turned off the radius.
  const radialOff = (city) => city.buildings.map((b) => {
    const [x0, y0] = b.pts[0], [x3, y3] = b.pts[3], mx = (x0 + x3) / 2, my = (y0 + y3) / 2;
    const e = Math.atan2(y3 - y0, x3 - x0), r = Math.atan2(my, mx);
    return Math.abs(Math.sin(e - r));
  });
  const ring = buildCity(mk("ring")), sprawl = buildCity(mk("sprawl"));
  const askew = (xs) => xs.filter((v) => v > 0.15 && v < 0.85).length / xs.length;
  assert.ok(askew(radialOff(sprawl)) > askew(radialOff(ring)) + 0.02, `sprawl ${askew(radialOff(sprawl))} vs ring ${askew(radialOff(ring))}`);
  assert.deepEqual(buildCity(mk("sprawl")).buildings, sprawl.buildings);
});
