import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GM_TOOLS_ATLAS_DIR = mkdtempSync(join(tmpdir(), "atlas-lib-"));

const { parseAtlas } = await import("../atlas/schema.mjs");
const geo = await import("../atlas/geometry.mjs");
const { applyOps, remapRadius, applyAtlasOps, undoAtlasOps } = await import("../atlas/ops.mjs");
const { lintAtlas, sectionExits } = await import("../atlas/lint.mjs");
const q = await import("../atlas/query.mjs");
const { sectionBrief, checkExits } = await import("../atlas/section-brief.mjs");
const { surveyView } = await import("../atlas/survey.mjs");
const store = await import("../atlas/store.mjs");
const { millAtlas } = await import("./fixtures/atlas-dungeon.mjs");

const mill = () => parseAtlas({ schemaVersion: 1, revision: 0, units: "ft", ...millAtlas() });

test("polar round-trips; bearings clockwise from north, y south", () => {
  const p = geo.fromPolar(100, 90);
  assert.ok(Math.abs(p.x - 100) < 1e-9 && Math.abs(p.y) < 1e-9);
  const n = geo.fromPolar(100, 0);
  assert.ok(n.y < 0);
  const back = geo.polar({ x: 70, y: 70 });
  assert.ok(Math.abs(back.th - 135) < 1e-9);
});

test("an arc keeps its radius; a radial goes out then round", () => {
  const a = geo.fromPolar(1000, 10), b = geo.fromPolar(1000, 60);
  const arc = geo.routePoints({ route: "arc" }, a, b);
  for (const p of arc) assert.ok(Math.abs(geo.polar(p).r - 1000) < 1);
  assert.ok(geo.polylineLength(arc) > Math.hypot(a.x - b.x, a.y - b.y));
  const c = geo.fromPolar(2000, 60);
  const rad = geo.routePoints({ route: "radial" }, a, c);
  assert.ok(Math.abs(geo.polar(rad[1]).th - 10) < 1e-6 && Math.abs(geo.polar(rad[1]).r - 2000) < 1e-6);
});

test("travel minutes: water slows, crawls halve the pace, shafts go by the climb", () => {
  const a = { x: 0, y: 0, depth: 0 }, b = { x: 600, y: 0, depth: 0 };
  assert.equal(geo.travelMinutes({ route: "straight", water: "dry", width: "walk" }, a, b), 3);
  assert.equal(geo.travelMinutes({ route: "straight", water: "chest", width: "walk" }, a, b), 10);
  assert.equal(geo.travelMinutes({ route: "straight", water: "dry", width: "crawl" }, a, b), 6);
  assert.equal(geo.travelMinutes({ kind: "shaft", route: "straight" }, a, { x: 0, y: 0, depth: 40 }), 2);
  assert.equal(geo.travelMinutes({ minutes: 9 }, a, b), 9);
});

test("ops: add marks drafts for Claude, remove cascades, accept clears, unknown op throws", () => {
  const { atlas, results } = applyOps(mill(), [
    { op: "add-node", data: { id: "well", name: "Village well", kind: "shaft", stratum: "S1", x: 100, y: -100, depth: 10 } },
    { op: "add-edge", data: { id: "well--drain", from: "well", to: "drain-head", kind: "gallery" } },
    { op: "remove-node", id: "outfall" },
  ], { draftNew: true });
  assert.equal(atlas.nodes.find((n) => n.id === "well").draft, true);
  assert.deepEqual(results[2].alsoRemoved, ["drain-main"]);
  const acc = applyOps(atlas, [{ op: "accept", ids: ["well"] }]).atlas;
  assert.equal(acc.nodes.find((n) => n.id === "well").draft, undefined);
  assert.throws(() => applyOps(mill(), [{ op: "fly" }]), /unknown op/);
});

test("radial remap: a band grows, everything outside it is unchanged, sections keep their size", () => {
  assert.equal(remapRadius(150, [{ from: [150, 380], to: [150, 600] }]), 150);
  assert.equal(remapRadius(380, [{ from: [150, 380], to: [150, 600] }]), 600);
  const { atlas } = applyOps(mill(), [{ op: "radial-remap", bands: [{ from: [150, 380], to: [150, 600] }] }]);
  const out = atlas.nodes.find((n) => n.id === "outfall");
  assert.ok(Math.hypot(out.x, out.y) > Math.hypot(200, 200) + 50);
  assert.equal(atlas.nodes.find((n) => n.id === "cellar").x, 10);
  assert.equal(atlas.areas.find((a) => a.id === "village").shape.r1, 600);
  assert.deepEqual(atlas.sections[0].sizeSq, { w: 18, h: 14 });
});

test("lint: depth outside its band, a band skipped, a draft the table knows", () => {
  const a = mill();
  a.nodes.find((n) => n.id === "cellar").depth = 45;
  a.edges.push({ id: "skip", from: "mill", to: "cistern", kind: "gallery", route: "straight", systems: [], water: "dry", flow: "none", width: "walk", tells: [] });
  a.nodes.find((n) => n.id === "vault").draft = true;
  const f = lintAtlas(a, { known: { vault: "heard", nowhere: "seen" } });
  const ids = f.map((x) => x.check);
  for (const c of ["depth-band", "band-skip", "known-draft", "known-unknown", "drafts"]) assert.ok(ids.includes(c), c);
});

test("queries: neighbourhood, quickest route around a locked grate, search", () => {
  const a = mill();
  const nb = q.neighbourhood(a, "drain-head", 1);
  assert.deepEqual(nb.nodes.map((n) => n.id).sort(), ["cellar", "cistern", "outfall"]);
  assert.equal(q.route(a, "mill", "cistern"), null);                         // the grate is locked
  assert.ok(q.route(a, "mill", "cistern", { avoid: [] }).minutes > 0);
  assert.equal(q.search(a, "boat")[0].id, "cistern");
  assert.equal(q.summary(a).counts.nodes, 7);
});

test("section exits and the brief: a passage leaving the cellar map is an exit on the right side", () => {
  const a = mill();
  const exits = sectionExits(a, a.sections[0]);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].edge, "cellar-drain");
  assert.ok(["e", "s"].includes(exits[0].side));
  const brief = sectionBrief(a, "cellar-map");
  assert.deepEqual(brief.places.map((p) => p.id).sort(), ["cellar", "mill"]);
  assert.equal(checkExits(brief, [{ id: "drain-crawl", side: exits[0].side }]).ok, true);
  assert.equal(checkExits(brief, []).ok, false);
});

test("SPOILER: the survey carries no GM-only text, no unknown place, no draft, no hidden World Fabric place", () => {
  const a = mill();
  a.nodes.find((n) => n.id === "drain-head").draft = true;
  a.nodes.find((n) => n.id === "cellar").wf = "wf_secret";
  const known = { known: { mill: "walked", cellar: "walked", "drain-head": "seen", cistern: "heard", "rumour-vault": "heard",
    "cellar-shaft": "walked" } };
  const s = surveyView(a, known, { hiddenWf: new Set(["wf_secret"]) });
  const text = JSON.stringify(s);
  for (const secret of ["Gullet keep their boat", "miller's father", "Sealed vault", "drain-head", "wf_secret", "the miller", "Gullet gang"]) {
    assert.ok(!text.includes(secret), `survey leaks "${secret}"`);
  }
  assert.deepEqual(s.nodes.map((n) => n.id).sort(), ["cistern", "mill", "rumour-vault"]);
  const heard = s.nodes.find((n) => n.id === "cistern");
  assert.equal(heard.depth, null);
  assert.deepEqual(heard.tells, []);
  assert.equal(s.nodes.find((n) => n.id === "rumour-vault").belief, true);
});

test("applyAtlasOps writes under the lock and keeps one undo", () => {
  store.createAtlas("w", millAtlas());
  applyAtlasOps("w", "old-mill", [{ op: "move-node", id: "cellar", x: 30, y: 5 }]);
  assert.equal(store.loadAtlas("w", "old-mill").nodes.find((n) => n.id === "cellar").x, 30);
  undoAtlasOps("w", "old-mill");
  assert.equal(store.loadAtlas("w", "old-mill").nodes.find((n) => n.id === "cellar").x, 10);
  assert.throws(() => undoAtlasOps("w", "old-mill"), /nothing to undo/);
});
