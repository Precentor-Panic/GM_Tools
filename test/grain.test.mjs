import assert from "node:assert/strict";
import {
  summarizeBatch,
  renderHeadline,
  renderRegionDiff,
  renderEntityDiff,
  HEADLINE_IMPORTANCE_THRESHOLD
} from "../mutation-engine/grain.mjs";

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

function mutation(overrides) {
  return {
    op: "upsert_entity",
    id: "ent1",
    data: { description: "changed" },
    rationale: "Something happened.",
    batchId: "batch1",
    sourceKind: "seeded-propagation",
    mutationId: "m0",
    status: "pending",
    regionId: "region-0",
    entityContext: { name: "Alvor", importance: 0.5, tags: [] },
    ...overrides
  };
}

const batch = {
  id: "batch1",
  world: "wf-test",
  createdAt: new Date().toISOString(),
  scope: { mode: "seed", anchorId: "ent1", depth: 2 },
  status: "open",
  mutations: [
    mutation({ mutationId: "m0", id: "alvor", regionId: "region-0", entityContext: { name: "Alvor", importance: 0.7, tags: [] } }),
    mutation({ mutationId: "m1", id: "gerdur", regionId: "region-0", entityContext: { name: "Gerdur", importance: 0.2, tags: [] } }),
    mutation({ mutationId: "m2", id: "whiterun", regionId: "region-1", entityContext: { name: "Whiterun", importance: 0.9, tags: [] } })
  ]
};

// --------------------------------------------------------------- summarizeBatch

test("summarizeBatch: groups mutations by regionId", () => {
  const summary = summarizeBatch(batch);
  assert.equal(summary.regions.length, 2);
  const r0 = summary.regions.find((r) => r.regionId === "region-0");
  const r1 = summary.regions.find((r) => r.regionId === "region-1");
  assert.equal(r0.entities.length, 2);
  assert.equal(r1.entities.length, 1);
});

test("summarizeBatch: mutations without a regionId each become a singleton region", () => {
  const soloBatch = {
    ...batch,
    mutations: [mutation({ mutationId: "solo1", regionId: undefined, id: "orphan" })]
  };
  const summary = summarizeBatch(soloBatch);
  assert.equal(summary.regions.length, 1);
  assert.equal(summary.regions[0].regionId, "solo-solo1");
});

test("summarizeBatch: entity below HEADLINE_IMPORTANCE_THRESHOLD collapses by default", () => {
  const summary = summarizeBatch(batch);
  const r0 = summary.regions.find((r) => r.regionId === "region-0");
  const gerdur = r0.entities.find((e) => e.name === "Gerdur"); // importance 0.2 < threshold
  const alvor = r0.entities.find((e) => e.name === "Alvor"); // importance 0.7 >= threshold
  assert.ok(importanceBelowThreshold(gerdur.importance));
  assert.equal(gerdur.collapsed, true);
  assert.equal(alvor.collapsed, false);
});

test("summarizeBatch: 'pin-review' tag forces an otherwise-collapsed entity into full visibility", () => {
  const pinnedBatch = {
    ...batch,
    mutations: [
      mutation({
        mutationId: "m9",
        id: "minor-npc",
        regionId: "region-9",
        entityContext: { name: "Minor NPC", importance: 0.1, tags: ["pin-review"] }
      })
    ]
  };
  const summary = summarizeBatch(pinnedBatch);
  const entity = summary.regions[0].entities[0];
  assert.equal(entity.importance < HEADLINE_IMPORTANCE_THRESHOLD, true, "importance alone would collapse this entity");
  assert.equal(entity.pinned, true);
  assert.equal(entity.collapsed, false, "pin-review tag should override the importance-based collapse");
  // And it should surface in the top-level headline, not just the region headline.
  assert.ok(summary.headline.includes("Minor NPC"));
});

function importanceBelowThreshold(imp) {
  return imp < HEADLINE_IMPORTANCE_THRESHOLD;
}

// ----------------------------------------------- flaggedEntityIds (Phase 4 task 4.2)

test("summarizeBatch: a flagged (long-unreviewed) low-importance entity is forced into the headline even though HEADLINE_IMPORTANCE_THRESHOLD alone would have collapsed it", () => {
  const flaggedBatch = {
    ...batch,
    mutations: [
      mutation({
        mutationId: "m10",
        id: "quiet-shopkeep",
        regionId: "region-10",
        entityContext: { name: "Quiet Shopkeep", importance: 0.1, tags: [] } // no pin-review tag, low importance
      })
    ]
  };

  const withoutFlag = summarizeBatch(flaggedBatch);
  const unflaggedEntity = withoutFlag.regions[0].entities[0];
  assert.equal(unflaggedEntity.collapsed, true, "sanity: importance alone collapses this entity when nothing flags it");
  assert.ok(!withoutFlag.headline.includes("Quiet Shopkeep"), "sanity: not in the headline when unflagged");

  const withFlag = summarizeBatch(flaggedBatch, { flaggedEntityIds: new Set(["quiet-shopkeep"]) });
  const flaggedEntity = withFlag.regions[0].entities[0];
  assert.equal(flaggedEntity.importance, 0.1, "importance itself is unchanged");
  assert.equal(flaggedEntity.flaggedUnreviewed, true);
  assert.equal(flaggedEntity.collapsed, false, "flagged-unreviewed status must force it out of collapse regardless of importance");
  assert.ok(withFlag.headline.includes("Quiet Shopkeep"), "must surface by name in the top-level headline, not just avoid collapse in isolation");
  assert.ok(
    withFlag.regions[0].headline.includes("Quiet Shopkeep"),
    "must also surface in its own region's one-line headline -- this is the actual 'force into headline' mechanism"
  );
});

test("summarizeBatch: flaggedEntityIds has no effect on an entity NOT in the set (default behavior preserved)", () => {
  const summary = summarizeBatch(batch, { flaggedEntityIds: new Set(["some-other-entity-entirely"]) });
  const r0 = summary.regions.find((r) => r.regionId === "region-0");
  const gerdur = r0.entities.find((e) => e.name === "Gerdur");
  assert.equal(gerdur.flaggedUnreviewed, false);
  assert.equal(gerdur.collapsed, true, "untouched by an unrelated flagged set");
});

test("summarizeBatch: omitting flaggedEntityIds entirely is identical to passing an empty Set (backward compatible)", () => {
  const withoutOpts = summarizeBatch(batch);
  const withEmptySet = summarizeBatch(batch, { flaggedEntityIds: new Set() });
  assert.deepEqual(withoutOpts, withEmptySet);
});

// ------------------------------------------------------------------ render*

test("renderHeadline: produces readable plain text mentioning batch id and region headlines", () => {
  const summary = summarizeBatch(batch);
  const text = renderHeadline(summary);
  assert.ok(typeof text === "string" && text.length > 0);
  assert.ok(text.includes("batch1"));
  assert.ok(text.includes("region-0"));
  assert.ok(text.includes("region-1"));
  assert.ok(!text.includes("undefined"), "rendered text should never leak 'undefined'");
});

test("renderRegionDiff: shows full detail for non-collapsed entities, terse line for collapsed ones", () => {
  const summary = summarizeBatch(batch);
  const r0 = summary.regions.find((r) => r.regionId === "region-0");
  const text = renderRegionDiff(r0);
  assert.ok(text.includes("Alvor"), "non-collapsed entity should be named");
  assert.ok(text.includes("Something happened."), "non-collapsed entity should show its rationale");
  assert.ok(text.includes("Gerdur"), "collapsed entity should still be mentioned");
  // Collapsed entity gets a terse one-liner, not a full "### Gerdur" heading.
  assert.ok(!text.includes("### Gerdur"));
  assert.ok(!text.includes("undefined"));
});

test("renderEntityDiff: shows diff field changes when a diff array is present", () => {
  const entity = {
    name: "Alvor",
    op: "upsert_entity",
    rationale: "The siege reached his forge.",
    pinned: false,
    data: { importance: 0.6 },
    diff: [{ field: "importance", from: 0.5, to: 0.6 }]
  };
  const text = renderEntityDiff(entity);
  assert.ok(text.includes("Alvor"));
  assert.ok(text.includes("importance"));
  assert.ok(text.includes("0.5"));
  assert.ok(text.includes("0.6"));
});

test("renderEntityDiff: falls back to raw proposed data when no diff array is present", () => {
  const entity = {
    name: "Gerdur",
    op: "upsert_entity",
    rationale: "Word reaches the mill.",
    pinned: false,
    data: { description: "Worried about her brother." },
    diff: null
  };
  const text = renderEntityDiff(entity);
  assert.ok(text.includes("Proposed values"));
  assert.ok(text.includes("Worried about her brother."));
});

test("renderEntityDiff: marks pinned entities explicitly", () => {
  const entity = { name: "Minor NPC", op: "upsert_entity", rationale: "x", pinned: true, data: {}, diff: null };
  const text = renderEntityDiff(entity);
  assert.ok(text.toLowerCase().includes("pinned"));
});

console.log(`\n${passed} passed`);
