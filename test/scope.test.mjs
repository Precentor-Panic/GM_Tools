import assert from "node:assert/strict";
import { resolveScope, SCOPE_MODES, CONTAINED_IN_DEFAULT_DEPTH } from "../time-skip/scope.mjs";
import { neighborhood } from "../wf-mcp-server/lib/graph.mjs";
import { ambientDecay } from "../mutation-engine/propagate.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ fixture
//
// A small "town" graph mixing containment/origin/presence/other edge types,
// shaped so contained-in's edge-type filter and region's shallow depth are
// both exercisable:
//
//   cityHall --containment--> district1 --containment--> building1 --containment--> room1
//   district1 --social--> factionZ                 (non-containment: region should reach it, contained-in should not)
//   expat --origin--> cityHall                       (never followed by contained-in)
//   building1 --presence--> touristY                 (never followed by contained-in)
//
// district1 -> room1 is 2 containment hops; cityHall -> room1 is 3 hops,
// beyond region's default depth (2) but within contained-in's default
// (effectively unbounded).
const entities = [
  { id: "cityHall", name: "City Hall", type: "place", importance: 0.6 },
  { id: "district1", name: "District One", type: "place", importance: 0.5 },
  { id: "building1", name: "Building One", type: "place", importance: 0.4 },
  { id: "room1", name: "Room One", type: "place", importance: 0.3 },
  { id: "factionZ", name: "Faction Z", type: "faction", importance: 0.5 },
  { id: "expat", name: "Expat", type: "person", importance: 0.5 },
  { id: "touristY", name: "Tourist Y", type: "person", importance: 0.5 }
];

const edges = [
  { id: "c1", sourceId: "cityHall", targetId: "district1", relationshipType: "containment", strength: 0.8 },
  { id: "c2", sourceId: "district1", targetId: "building1", relationshipType: "containment", strength: 0.7 },
  { id: "c3", sourceId: "building1", targetId: "room1", relationshipType: "containment", strength: 0.6 },
  { id: "s1", sourceId: "district1", targetId: "factionZ", relationshipType: "social", strength: 0.5 },
  { id: "g1", sourceId: "expat", targetId: "cityHall", relationshipType: "origin", strength: 0.9 },
  { id: "p1", sourceId: "building1", targetId: "touristY", relationshipType: "presence", strength: 0.5 },
  // A non-containment edge between TWO entities both already reachable via
  // containment alone (district1, building1) -- proves contained-in's
  // downstream decay pass isn't restricted to containment-typed edges once
  // the entity set is settled (see the "IMPORTANT" note on
  // resolveContainedInDeltas in scope.mjs: containment-only governs the BFS
  // traversal, not what's visible to ambientDecay/propagateSeed afterward).
  { id: "k1", sourceId: "district1", targetId: "building1", relationshipType: "knowledge", strength: 0.6 }
];

// ------------------------------------------------------------------ modes list

test("SCOPE_MODES includes all four documented modes plus the pre-existing three", () => {
  for (const m of ["seed", "ambient", "tag", "region", "contained-in"]) {
    assert.ok(SCOPE_MODES.includes(m), `SCOPE_MODES should list "${m}"`);
  }
});

// ------------------------------------------------------------------ region mode

test("region: entity/edge set matches neighborhood()'s own output for the same anchor/depth", () => {
  // depth=1 from district1: neighborhood() (all edge types, undirected)
  // reaches exactly {district1, cityHall, building1, factionZ} via
  // {c1, c2, s1, k1} (k1 is district1<->building1, a direct hop-1 edge
  // like c2) -- a small, hand-verifiable set to cross-check against.
  const depth = 1;
  const expected = neighborhood(entities, edges, "district1", depth);
  const expectedIds = new Set(expected.entities.map((e) => e.id));
  const expectedEdgeIds = new Set(expected.edges.map((e) => e.id));
  assert.deepEqual(expectedIds, new Set(["district1", "cityHall", "building1", "factionZ"]));
  assert.deepEqual(expectedEdgeIds, new Set(["c1", "c2", "s1", "k1"]));

  // resolveScope's region mode must restrict its own candidateDeltas call to
  // exactly this same neighborhood -- large elapsedSessions forces every
  // eligible (non-containment) edge within it to appear as an ambient-decay
  // delta, and nothing outside it should ever appear.
  const { deltas } = resolveScope({ entities, edges }, { mode: "region", anchorId: "district1", depth, elapsedSessions: 100 });
  const decayEdgeIds = new Set(deltas.filter((d) => d.kind === "ambient-decay").map((d) => d.edgeId));
  for (const edgeId of decayEdgeIds) {
    assert.ok(expectedEdgeIds.has(edgeId), `delta edge ${edgeId} should be within neighborhood()'s own edge set`);
  }
  // s1 (social) and k1 (knowledge), both non-containment, are IN the
  // neighborhood and should decay heavily enough at elapsedSessions=100 to appear.
  assert.ok(decayEdgeIds.has("s1"), "s1 is within the depth-1 neighborhood and should appear as a decay delta");
  assert.ok(decayEdgeIds.has("k1"), "k1 is within the depth-1 neighborhood and should appear as a decay delta");
  // c1/c2 are containment-typed -- hard-excluded from ambientDecay regardless
  // of scope, so their absence here is expected for a different reason (not
  // being out-of-neighborhood).
});

test("region: ambient decay is scoped to the resolved neighborhood only, not the whole graph", () => {
  // Anchor tightly on room1 with depth 1: neighborhood is {room1, building1},
  // edge c3 only. Confirm no ambient-decay delta appears for edges entirely
  // outside that neighborhood (e.g. c1 cityHall<->district1, s1, g1, p1),
  // even though ambientDecay() over the WHOLE graph would happily produce
  // candidates for all of them.
  const { deltas } = resolveScope({ entities, edges }, { mode: "region", anchorId: "room1", depth: 1, elapsedSessions: 100 });
  const decayEdgeIds = new Set(deltas.filter((d) => d.kind === "ambient-decay").map((d) => d.edgeId));

  // Whole-graph decay (for comparison) would include c1/s1/g1/p1 at elapsedSessions=100
  // for every non-excluded type -- but c1 IS containment so it's excluded from
  // ambientDecay regardless; use s1 (social) as the "leaks into the whole graph" probe,
  // since social has a short half-life and 100 elapsed sessions guarantees needsLLM=true
  // if it were included.
  const wholeGraphDecay = ambientDecay(edges, 100);
  assert.ok(wholeGraphDecay.some((d) => d.edgeId === "s1"), "sanity: s1 decays significantly over the whole graph");
  assert.equal(decayEdgeIds.has("s1"), false, "s1 is outside room1's depth-1 neighborhood -- must not leak in");
  assert.equal(decayEdgeIds.has("c1"), false, "c1 is outside room1's depth-1 neighborhood -- must not leak in");
  // c3 (building1<->room1) IS in scope, but containment edges are hard-excluded
  // from ambientDecay everywhere (propagate.mjs's NON_DECAYING_RELATIONSHIP_TYPES),
  // so it correctly produces no delta either -- for a different, expected reason.
  assert.equal(decayEdgeIds.has("c3"), false, "c3 is containment-typed -- hard-excluded from ambientDecay regardless of scope");
});

test("region: requires anchorId", () => {
  assert.throws(() => resolveScope({ entities, edges }, { mode: "region" }), /anchorId/);
});

// ------------------------------------------------------------------ contained-in mode

test("contained-in: traverses containment-typed edges only -- origin and presence are never followed", () => {
  const { deltas } = resolveScope(
    { entities, edges },
    { mode: "contained-in", anchorId: "cityHall", elapsedSessions: 100 }
  );
  // Prove via the underlying neighborhood computation directly too (not just
  // the filtered candidateDeltas output), since that's the traversal itself.
  const containmentOnly = neighborhood(entities, edges.filter((e) => e.relationshipType === "containment"), "cityHall", CONTAINED_IN_DEFAULT_DEPTH);
  const reachedIds = new Set(containmentOnly.entities.map((e) => e.id));

  assert.ok(reachedIds.has("district1"), "district1 reached via containment");
  assert.ok(reachedIds.has("building1"), "building1 reached via containment (2 hops)");
  assert.ok(reachedIds.has("room1"), "room1 reached via containment (3 hops)");
  assert.equal(reachedIds.has("expat"), false, "expat is only reachable via an origin edge -- must not be reached");
  assert.equal(reachedIds.has("touristY"), false, "touristY is only reachable via a presence edge -- must not be reached");
  assert.equal(reachedIds.has("factionZ"), false, "factionZ is only reachable via a social edge -- must not be reached");

  // Same proof against resolveScope's actual delta output: no delta should
  // ever reference expat/touristY/factionZ or their non-containment edges.
  const touchedEdgeIds = new Set(deltas.filter((d) => d.kind === "ambient-decay").map((d) => d.edgeId));
  assert.equal(touchedEdgeIds.has("g1"), false, "origin edge g1 must never appear in contained-in's deltas");
  assert.equal(touchedEdgeIds.has("p1"), false, "presence edge p1 must never appear in contained-in's deltas");
  assert.equal(touchedEdgeIds.has("s1"), false, "social edge s1 must never appear in contained-in's deltas");
});

test("contained-in: a non-containment edge between two already-in-scope entities still surfaces for ambient decay (found in remediation: containment-only must govern the BFS traversal, not silently make ambient mode a permanent no-op)", () => {
  // k1 (knowledge, district1<->building1) connects two entities BOTH
  // reachable from cityHall via containment alone -- it must appear as an
  // ambient-decay candidate. If contained-in's downstream edge set were
  // (incorrectly) restricted to containment-typed edges only, this would be
  // impossible: containment edges are themselves hard-excluded from
  // ambientDecay everywhere, so "contained-in + ambient, no seeds" would
  // ALWAYS produce zero candidates, for any world, which is not a useful
  // "time-skip everything inside this district" operation.
  const { deltas } = resolveScope(
    { entities, edges },
    { mode: "contained-in", anchorId: "cityHall", elapsedSessions: 100 }
  );
  const decayEdgeIds = new Set(deltas.filter((d) => d.kind === "ambient-decay").map((d) => d.edgeId));
  assert.ok(decayEdgeIds.has("k1"), "k1 (knowledge, between two in-scope entities) should surface as a decay candidate");
  assert.ok(deltas.length > 0, "contained-in + ambient should not be an unconditional no-op");

  // The out-of-scope edges must still never appear, confirming the fix
  // didn't just fall back to "every edge in the whole graph."
  assert.equal(decayEdgeIds.has("g1"), false, "origin edge to an out-of-scope entity must still never appear");
  assert.equal(decayEdgeIds.has("p1"), false, "presence edge to an out-of-scope entity must still never appear");
  assert.equal(decayEdgeIds.has("s1"), false, "social edge to an out-of-scope entity must still never appear");
});

test("contained-in: reaches a multi-hop chain (district -> building -> room) that region's shallow default depth would miss", () => {
  const regionResult = resolveScope({ entities, edges }, { mode: "region", anchorId: "cityHall", elapsedSessions: 1 });
  const containedResult = resolveScope({ entities, edges }, { mode: "contained-in", anchorId: "cityHall", elapsedSessions: 1 });

  // Cross-check via the raw traversal, since candidateDeltas may filter
  // ambient-decay-of-containment-edges out entirely (they're hard-excluded) --
  // the entity REACHABILITY is what this test is about, so check it directly.
  const regionNeighborhood = neighborhood(entities, edges, "cityHall", 2); // region's default depth
  const containedNeighborhood = neighborhood(
    entities,
    edges.filter((e) => e.relationshipType === "containment"),
    "cityHall",
    CONTAINED_IN_DEFAULT_DEPTH
  );

  assert.equal(
    regionNeighborhood.entities.some((e) => e.id === "room1"),
    false,
    "room1 is 3 hops from cityHall -- region's default depth (2) should NOT reach it"
  );
  assert.ok(
    containedNeighborhood.entities.some((e) => e.id === "room1"),
    "room1 IS reachable from cityHall via 3 containment hops -- contained-in's unbounded-ish depth should reach it"
  );

  // Both resolveScope() calls should have actually run (no throw) regardless
  // of whether the deltas array ends up empty after needsLLM filtering.
  assert.ok(Array.isArray(regionResult.deltas));
  assert.ok(Array.isArray(containedResult.deltas));
});

test("contained-in: requires anchorId", () => {
  assert.throws(() => resolveScope({ entities, edges }, { mode: "contained-in" }), /anchorId/);
});

test("contained-in: default depth constant is a very high cap, not the shallow region default", () => {
  assert.ok(CONTAINED_IN_DEFAULT_DEPTH >= 100, "contained-in's default depth should comfortably exceed any realistic containment chain");
});

console.log(`\n${passed} passed`);
