import assert from "node:assert/strict";
import {
  EDGE_TYPE_WEIGHT,
  DECAY_HALF_LIFE_SESSIONS,
  IMPACT_THRESHOLD,
  IMPORTANCE_FLOOR,
  PRUNE_FLOOR,
  propagateSeed,
  ambientDecay,
  candidateDeltas
} from "../mutation-engine/propagate.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

// Fixture, in the shape of e2e-m2.mjs's Riverwood/Whiterun/Companions town
// graph: an event epicenter ("siege") with three hop-1 neighbors reached via
// different edge types/strengths, one hop-2 neighbor, and one hop-3 neighbor
// whose propagated impact should fall below IMPACT_THRESHOLD.
const entities = [
  { id: "siege", name: "The Siege", type: "event", importance: 0.9 },
  { id: "alvor", name: "Alvor", type: "person", importance: 0.5 },
  { id: "shop", name: "Riverwood Trader", type: "place", importance: 0.5 },
  { id: "bystander", name: "Sven", type: "person", importance: 0.1 }, // below IMPORTANCE_FLOOR
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5 },
  { id: "distant", name: "Whiterun", type: "place", importance: 0.8 } // high importance, but reached too weakly
];

const edges = [
  { id: "e1", sourceId: "siege", targetId: "alvor", relationshipType: "kinship", strength: 0.9 },
  { id: "e2", sourceId: "siege", targetId: "shop", relationshipType: "presence", strength: 0.5 },
  { id: "e3", sourceId: "siege", targetId: "bystander", relationshipType: "causal", strength: 0.9 },
  { id: "e4", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.8 },
  { id: "e5", sourceId: "gerdur", targetId: "distant", relationshipType: "social", strength: 0.3 },
  // Dedicated ambient-decay fixture edges: a low-strength, long-half-life
  // causal edge that should decay too little to bother texturing, alongside
  // e3's short-half-life social-strength comparison in ambientDecay's own
  // unit tests above.
  { id: "e6", sourceId: "shop", targetId: "bystander", relationshipType: "causal", strength: 0.2 },
  { id: "e7", sourceId: "alvor", targetId: "shop", relationshipType: "social", strength: 0.6 }
];

// ------------------------------------------------------------ propagateSeed

test("propagateSeed: constants match the documented defaults", () => {
  assert.equal(EDGE_TYPE_WEIGHT.causal, 1.0);
  assert.equal(EDGE_TYPE_WEIGHT.unspecified, 0.3);
  assert.equal(DECAY_HALF_LIFE_SESSIONS.social, 2);
  assert.equal(DECAY_HALF_LIFE_SESSIONS.fealty, 8);
  assert.equal(IMPACT_THRESHOLD, 0.15);
  assert.equal(IMPORTANCE_FLOOR, 0.2);
  assert.equal(PRUNE_FLOOR, 0.01);
});

test("propagateSeed: impact strictly decreases with hop distance along a path", () => {
  const impact = propagateSeed(entities, edges, "siege", 1.0, 3);
  // alvor is hop 1, gerdur is hop 2 (reached only via alvor)
  assert.ok(impact.get("alvor") > impact.get("gerdur"),
    `hop-1 impact (${impact.get("alvor")}) should exceed hop-2 impact (${impact.get("gerdur")})`);
  assert.ok(impact.get("gerdur") > impact.get("distant"),
    `hop-2 impact (${impact.get("gerdur")}) should exceed hop-3 impact (${impact.get("distant")})`);
});

test("propagateSeed: at equal hop distance, stronger/higher-weight edge outranks weaker one", () => {
  const impact = propagateSeed(entities, edges, "siege", 1.0, 3);
  // alvor (kinship 0.85*0.9) vs shop (presence 0.55*0.5), both hop 1 from siege
  assert.ok(impact.get("alvor") > impact.get("shop"),
    "strong kinship edge should outrank weaker presence edge at the same hop distance");
});

test("propagateSeed: includes the seed itself at seedMagnitude", () => {
  const impact = propagateSeed(entities, edges, "siege", 1.0, 3);
  assert.equal(impact.get("siege"), 1.0);
});

test("propagateSeed: respects maxDepth (nodes beyond it are unreached)", () => {
  const impact = propagateSeed(entities, edges, "siege", 1.0, 1);
  assert.ok(impact.has("alvor"));
  assert.equal(impact.has("gerdur"), false, "gerdur is 2 hops away, beyond maxDepth=1");
});

test("propagateSeed: prunes below PRUNE_FLOOR rather than propagating negligible impact forever", () => {
  const impact = propagateSeed(entities, edges, "siege", 0.001, 5);
  // seedMagnitude itself is tiny; every downstream candidate should be pruned
  assert.equal(impact.has("alvor"), false);
});

// ------------------------------------------------------------- ambientDecay

test("ambientDecay: reduces strength monotonically as elapsed sessions increase", () => {
  const edge = { id: "e1", relationshipType: "fealty", strength: 0.8 };
  const at0 = ambientDecay([edge], 0)[0].to;
  const at4 = ambientDecay([edge], 4)[0].to;
  const at8 = ambientDecay([edge], 8)[0].to;
  assert.ok(at0 > at4, "strength should decrease as elapsed sessions grow");
  assert.ok(at4 > at8, "strength should keep decreasing");
});

test("ambientDecay: respects per-type half-life ordering (social decays faster than fealty)", () => {
  const social = { id: "s1", relationshipType: "social", strength: 0.8 };
  const fealty = { id: "f1", relationshipType: "fealty", strength: 0.8 };
  const [socialResult] = ambientDecay([social], 4);
  const [fealtyResult] = ambientDecay([fealty], 4);
  assert.ok(socialResult.to < fealtyResult.to,
    `social (half-life ${DECAY_HALF_LIFE_SESSIONS.social}) should decay faster than fealty (half-life ${DECAY_HALF_LIFE_SESSIONS.fealty})`);
});

test("ambientDecay: unknown relationshipType falls back to the unspecified half-life", () => {
  const edge = { id: "u1", relationshipType: "made-up-type", strength: 0.8 };
  const [result] = ambientDecay([edge], 3);
  const expected = 0.8 * Math.pow(0.5, 3 / DECAY_HALF_LIFE_SESSIONS.unspecified);
  assert.ok(Math.abs(result.to - expected) < 1e-9);
});

test("ambientDecay: delta is negative (strength only decays, never grows)", () => {
  const edge = { id: "e1", relationshipType: "knowledge", strength: 0.6 };
  const [result] = ambientDecay([edge], 2);
  assert.ok(result.delta < 0);
  assert.ok(Math.abs(result.delta - (result.to - result.from)) < 1e-9);
});

// ---------------------------------- Phase 1.5: containment/presence split ---

test("ambientDecay: containment edges are hard-excluded, not just slow-decaying", () => {
  const containment = { id: "c1", relationshipType: "containment", strength: 0.8 };
  const other = { id: "o1", relationshipType: "unspecified", strength: 0.8 };
  // A very large elapsed-sessions value would decay every other type to ~0
  // under any finite half-life -- proving containment's absence from the
  // results isn't just a slow decay hiding under IMPACT_THRESHOLD, but a
  // genuine exclusion from the candidate list.
  const results = ambientDecay([containment, other], 100000);
  assert.equal(results.some((r) => r.edgeId === "c1"), false,
    "containment edge should produce no candidate at all, at any elapsed time");
  assert.equal(results.some((r) => r.edgeId === "o1"), true,
    "non-containment edge should still produce a candidate (sanity check on the fixture)");
  assert.ok(results.find((r) => r.edgeId === "o1").to < 0.01,
    "sanity check: the large elapsed value really does decay other types near zero");
});

test("ambientDecay: presence-typed edges decay exactly as location-typed edges did pre-Phase-1.5 (rename, not behavior change)", () => {
  // Phase 1.5 renamed the "location" DECAY_HALF_LIFE_SESSIONS/EDGE_TYPE_WEIGHT
  // key to "presence" without changing its value (half-life 4, per the
  // pre-Phase-1.5 constant). Recompute against that same half-life by hand
  // and confirm ambientDecay's presence output matches -- proving the rename
  // preserved behavior instead of silently changing it.
  const preSplitLocationHalfLife = 4;
  assert.equal(DECAY_HALF_LIFE_SESSIONS.presence, preSplitLocationHalfLife,
    "presence's half-life should equal location's old half-life (4) -- a rename, not a retune");
  const edge = { id: "p1", relationshipType: "presence", strength: 0.8 };
  const elapsed = 3;
  const [result] = ambientDecay([edge], elapsed);
  const expected = 0.8 * Math.pow(0.5, elapsed / preSplitLocationHalfLife);
  assert.ok(Math.abs(result.to - expected) < 1e-9);
});

test("propagateSeed: still traverses containment edges normally (exclusion is scoped to ambientDecay only)", () => {
  const ents = [
    { id: "district", name: "District", type: "place", importance: 0.9 },
    { id: "building", name: "Building", type: "place", importance: 0.6 }
  ];
  const containmentEdges = [
    { id: "c1", sourceId: "district", targetId: "building", relationshipType: "containment", strength: 0.9 }
  ];
  const impact = propagateSeed(ents, containmentEdges, "district", 1.0, 2);
  assert.ok(impact.has("building"), "a seeded event should still ripple through a containment edge");
  assert.ok(impact.get("building") > 0, "containment-traversed impact should be a real positive score");
});

// ------------------------------------- Phase 1.5b: origin (homeLocation) ---

test("ambientDecay: origin edges are hard-excluded, not just slow-decaying", () => {
  const origin = { id: "g1", relationshipType: "origin", strength: 0.8 };
  const other = { id: "o1", relationshipType: "unspecified", strength: 0.8 };
  // A very large elapsed-sessions value would decay every other type to ~0
  // under any finite half-life -- proving origin's absence from the results
  // isn't just a slow decay hiding under IMPACT_THRESHOLD, but a genuine
  // exclusion from the candidate list (same proof shape as the containment
  // test above).
  const results = ambientDecay([origin, other], 100000);
  assert.equal(results.some((r) => r.edgeId === "g1"), false,
    "origin edge should produce no candidate at all, at any elapsed time");
  assert.equal(results.some((r) => r.edgeId === "o1"), true,
    "non-origin edge should still produce a candidate (sanity check on the fixture)");
  assert.ok(results.find((r) => r.edgeId === "o1").to < 0.01,
    "sanity check: the large elapsed value really does decay other types near zero");
});

test("propagateSeed: still traverses origin edges normally (exclusion is scoped to ambientDecay only)", () => {
  const ents = [
    { id: "hometown", name: "Hometown", type: "place", importance: 0.9 },
    { id: "expat", name: "Expat", type: "person", importance: 0.6 }
  ];
  const originEdges = [
    { id: "g1", sourceId: "expat", targetId: "hometown", relationshipType: "origin", strength: 0.9 }
  ];
  // e.g. news of a hometown's fall should still reach someone who's from there.
  const impact = propagateSeed(ents, originEdges, "hometown", 1.0, 2);
  assert.ok(impact.has("expat"), "a seeded event should still ripple through an origin edge");
  assert.ok(impact.get("expat") > 0, "origin-traversed impact should be a real positive score");
});

// ---------------------------------------------------------- candidateDeltas

test("candidateDeltas: entity below IMPORTANCE_FLOOR gets needsLLM:false even with high impact", () => {
  const deltas = candidateDeltas(entities, edges, { seedId: "siege", seedMagnitude: 1.0, depth: 3 });
  const bystander = deltas.find((d) => d.kind === "seed-propagated" && d.entityId === "bystander");
  assert.ok(bystander, "bystander should appear in candidateDeltas (reached at hop 1)");
  assert.ok(bystander.impactScore >= IMPACT_THRESHOLD, "bystander's impact should clear IMPACT_THRESHOLD");
  assert.ok(bystander.importance < IMPORTANCE_FLOOR, "bystander's importance should be below IMPORTANCE_FLOOR");
  assert.equal(bystander.needsLLM, false);
});

test("candidateDeltas: entity below IMPACT_THRESHOLD gets needsLLM:false even with high importance", () => {
  const deltas = candidateDeltas(entities, edges, { seedId: "siege", seedMagnitude: 1.0, depth: 3 });
  const distant = deltas.find((d) => d.kind === "seed-propagated" && d.entityId === "distant");
  assert.ok(distant, "distant should appear (reached at hop 3)");
  assert.ok(distant.importance >= IMPORTANCE_FLOOR, "distant has high intrinsic importance");
  assert.ok(distant.impactScore < IMPACT_THRESHOLD, "distant's propagated impact should be below IMPACT_THRESHOLD");
  assert.equal(distant.needsLLM, false);
});

test("candidateDeltas: entity clearing both floors gets needsLLM:true", () => {
  const deltas = candidateDeltas(entities, edges, { seedId: "siege", seedMagnitude: 1.0, depth: 3 });
  const alvor = deltas.find((d) => d.kind === "seed-propagated" && d.entityId === "alvor");
  assert.ok(alvor);
  assert.equal(alvor.needsLLM, true);
});

test("candidateDeltas: the seed entity itself is excluded from the propagated list", () => {
  const deltas = candidateDeltas(entities, edges, { seedId: "siege", seedMagnitude: 1.0, depth: 3 });
  assert.equal(deltas.some((d) => d.kind === "seed-propagated" && d.entityId === "siege"), false);
});

test("candidateDeltas: ambient-decay deltas are included and flagged by decay magnitude", () => {
  const deltas = candidateDeltas(entities, edges, { elapsedSessions: 3 });
  const socialDelta = deltas.find((d) => d.kind === "ambient-decay" && d.edgeId === "e7");
  const causalDelta = deltas.find((d) => d.kind === "ambient-decay" && d.edgeId === "e6");
  assert.ok(socialDelta && causalDelta);
  // e7: social, half-life=2, strength=0.6, 3 elapsed sessions -> heavy decay -> needsLLM true
  assert.equal(socialDelta.needsLLM, true);
  // e6: causal, half-life=12, strength=0.2, 3 elapsed sessions -> light decay -> needsLLM false
  assert.equal(causalDelta.needsLLM, false);
});

test("candidateDeltas: combines seed propagation and ambient decay when both are requested", () => {
  const deltas = candidateDeltas(entities, edges, { seedId: "siege", seedMagnitude: 1.0, elapsedSessions: 6 });
  assert.ok(deltas.some((d) => d.kind === "seed-propagated"));
  assert.ok(deltas.some((d) => d.kind === "ambient-decay"));
});

test("candidateDeltas: with no seedId/elapsedSessions, returns an empty list", () => {
  assert.deepEqual(candidateDeltas(entities, edges, {}), []);
});

console.log(`\n${passed} passed`);
