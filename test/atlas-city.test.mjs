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
