import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Code-review fix: wf_propose_mutations must attach diff.mjs's field-level
// diff to each proposed upsert_entity/upsert_edge mutation before persisting
// it, so grain.mjs's renderEntityDiff can show "field: from -> to" instead
// of always falling back to a raw-JSON-dump view. See wf-mcp-server/index.mjs's
// attachDiffs (exported for testing only) and the "before it's persisted via
// createBatch" wiring in the wf_propose_mutations handler.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-propose-diff-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const { attachDiffs } = await import("../wf-mcp-server/index.mjs");
const { createBatch, loadBatch } = await import("../mutation-engine/review-state.mjs");
const { summarizeBatch, renderEntityDiff, renderRegionDiff } = await import("../mutation-engine/grain.mjs");

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

const WORLD = "wf-test";

// Stand-in for the live snapshot's entities/edges (what loadSnapshot(dir, w)
// would hand wf_propose_mutations -- "mocking the snapshot lookup").
const entities = [
  { id: "alvor", name: "Alvor", type: "person", importance: 0.5, description: "A smith.", summary: "A smith." },
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.4 }
];
const edges = [
  { id: "e-alvor-gerdur", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.5 }
];

// Stand-in for texture.mjs's textureBatch() output -- already-validated
// Mutation-shaped objects with regionId/entityContext attached, no diff yet.
function proposedMutations() {
  return [
    {
      op: "upsert_entity",
      id: "alvor",
      data: { importance: 0.7, description: "Shaken by the siege." },
      rationale: "The siege reached his forge.",
      batchId: "placeholder",
      sourceKind: "seeded-propagation",
      impactScore: 0.6,
      regionId: "region-0",
      entityContext: { name: "Alvor", importance: 0.5, tags: [] }
    },
    {
      op: "upsert_edge",
      id: "e-alvor-gerdur",
      data: { strength: 0.2 },
      rationale: "Trust erodes after the betrayal.",
      batchId: "placeholder",
      sourceKind: "ambient-decay",
      regionId: "region-0"
    },
    {
      op: "upsert_entity",
      data: { name: "A New Rumor", type: "concept" },
      rationale: "A rumor spreads.",
      batchId: "placeholder",
      sourceKind: "manual",
      regionId: "region-1"
    }
  ];
}

// ------------------------------------------------------------- attachDiffs

test("attachDiffs: computes a real field-level diff for an upsert_entity against the live snapshot", () => {
  const [entityMutation] = attachDiffs(proposedMutations(), entities, edges);
  assert.ok(Array.isArray(entityMutation.diff), "diff should be attached");
  assert.deepEqual(
    entityMutation.diff.find((d) => d.field === "importance"),
    { field: "importance", from: 0.5, to: 0.7 }
  );
  assert.deepEqual(
    entityMutation.diff.find((d) => d.field === "description"),
    { field: "description", from: "A smith.", to: "Shaken by the siege." }
  );
});

test("attachDiffs: computes a real field-level diff for an upsert_edge against the live snapshot", () => {
  const [, edgeMutation] = attachDiffs(proposedMutations(), entities, edges);
  assert.deepEqual(edgeMutation.diff, [{ field: "strength", from: 0.5, to: 0.2 }]);
});

test("attachDiffs: a create op (no live match) gets diff.mjs's own '(created)' marker, not per-field noise", () => {
  const [, , createMutation] = attachDiffs(proposedMutations(), entities, edges);
  assert.deepEqual(createMutation.diff, [
    { field: "(created)", from: null, to: { name: "A New Rumor", type: "concept" } }
  ]);
});

// --------------------------------------------- end-to-end: attach -> persist -> render

test("wired end-to-end: attachDiffs -> createBatch -> grain.renderEntityDiff shows the field-level view, not the raw-JSON fallback", () => {
  const diffed = attachDiffs(proposedMutations(), entities, edges);
  const batch = createBatch(WORLD, { mode: "seed", anchorId: "alvor" }, "1 session", diffed, {
    makeId: () => "batch_propose_diff_test"
  });

  // review-state file was actually written (task 1.8 smoke-test coverage).
  const reloaded = loadBatch(WORLD, batch.id);
  assert.equal(reloaded.id, "batch_propose_diff_test");
  assert.equal(reloaded.mutations.length, 3);
  assert.ok(reloaded.mutations.every((m) => Array.isArray(m.diff)), "diff must survive the createBatch round-trip");

  const summary = summarizeBatch(reloaded);
  const alvorEntry = summary.regions.flatMap((r) => r.entities).find((e) => e.entityId === "alvor");
  const rendered = renderEntityDiff(alvorEntry);

  assert.ok(rendered.includes("Changes:"), "field-level view should be used, not the raw-data fallback");
  assert.ok(rendered.includes("importance: 0.5 -> 0.7"), `expected a real field-level diff line, got:\n${rendered}`);
  assert.ok(!rendered.includes("Proposed values"), "raw-JSON fallback should not be used when a diff is present");

  // Region-level render should surface the same field-level detail for the
  // non-collapsed entity (Alvor, importance 0.5 -> above collapse threshold
  // once entityContext's stale importance is superseded by rendering the
  // mutation itself -- this just re-confirms renderRegionDiff delegates to
  // renderEntityDiff for visible entities).
  const region0 = summary.regions.find((r) => r.regionId === "region-0");
  const regionText = renderRegionDiff(region0);
  assert.ok(regionText.includes("importance: 0.5 -> 0.7") || regionText.includes("Alvor"), "region render should mention the diffed entity");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
