import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 13 task 13.3 -- "Link to existing instead": a mention-scan
 * "propose new" row, redirected to an already-existing entity instead of
 * creating a duplicate. Deterministic (no LLM call): builds the mention-scan
 * batch directly via graph-import/scan-mentions.mjs's own previewMentionScan
 * (the real dedup/mutation-shaping step, not a hand-fabricated substitute),
 * then exercises redirectMentionScanRowToExistingOp against it.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-redirect-mention-scan-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;

const { previewMentionScan } = await import("../../graph-import/scan-mentions.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { redirectMentionScanRowToExistingOp, acceptMutationIds } = await import("../lib/mutation-ops.mjs");
const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const WORLD = "redirect-mention-scan-test-world";

const existingSnapshot = {
  entities: [
    { id: "kael", name: "Kael", type: "person", importance: 0.5 },
    { id: "mira", name: "Mira", type: "person", importance: 0.4 }
  ],
  edges: [],
  entityTypes: []
};

// A real snapshot file is needed too now -- redirectMentionScanRowToExistingOp
// validates existingEntityId against the live graph (self-review remediation:
// defense-in-depth against a direct/buggy caller pointing a redirect at a
// nonexistent id), matching addEdgeOp's own established validation convention.
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, existingSnapshot.entities.map((e) => ({ op: "upsert_entity", data: e })));

let idCounter = 0;
const makeId = () => `wf_test_${idCounter++}`;

function buildScanBatch(mentions) {
  const { mutations } = previewMentionScan(mentions, "kael", existingSnapshot, { makeId });
  return createBatch(WORLD, { mode: "mention-scan", sourceEntityId: "kael", sourceEntityName: "Kael" }, undefined, mutations, {
    makeId: () => `batch_redirect_test_${idCounter++}`
  });
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

await test("sanity: a genuinely new-named mention produces a PROPOSE-NEW pair (create + edge), 2 mutations", () => {
  const batch = buildScanBatch([{ name: "Gorrim the Smith", type: "person", description: "A blacksmith." }]);
  assert.equal(batch.mutations.length, 2);
  const create = batch.mutations.find((m) => m.op === "upsert_entity");
  const edge = batch.mutations.find((m) => m.op === "upsert_edge");
  assert.ok(create && edge);
  assert.equal(create.entityContext.scanResultKind, "new");
  assert.equal(edge.entityContext.scanResultKind, "new");
  assert.equal(edge.data.targetId, create.id);
});

await test('redirectMentionScanRowToExistingOp: converts the CREATE row into a genuine upsert_edge (not a modified create), removes the sibling edge, leaving exactly ONE mutation for this mention', () => {
  const batch = buildScanBatch([{ name: "Gorrim the Smith", type: "person", description: "A blacksmith." }]);
  const createEntry = batch.mutations.find((m) => m.op === "upsert_entity");
  const originalMutationId = createEntry.mutationId;

  const result = redirectMentionScanRowToExistingOp(dataDir, WORLD, {
    batchId: batch.id,
    mutationId: originalMutationId,
    existingEntityId: "mira",
    existingEntityName: "Mira"
  });
  assert.equal(result.redirectedTo, "mira");

  const updated = loadBatch(WORLD, batch.id);
  assert.equal(updated.mutations.length, 1, "the sibling edge-to-would-be-new-entity must be REMOVED, leaving exactly one mutation for this mention");
  const row = updated.mutations[0];
  assert.equal(row.mutationId, originalMutationId, "same mutationId -- client-side open/scroll state keyed by mutationId keeps working");
  assert.equal(row.op, "upsert_edge", "a GENUINE upsert_edge, not a modified upsert_entity");
  assert.equal(row.data.sourceId, "kael");
  assert.equal(row.data.targetId, "mira", "targets the CHOSEN EXISTING entity id");
  assert.equal(row.id, undefined, "no leftover entity-create id sitting on what is now an edge mutation");
  assert.equal(row.entityContext.scanResultKind, "link", "visually/functionally becomes a LINK row");
  assert.equal(row.status, "pending", "still pending -- redirect is a correction to the proposal, not an accept");
});

await test("redirecting then accepting the batch creates the edge, NOT a duplicate entity", () => {
  const batch = buildScanBatch([{ name: "Gorrim the Smith", type: "person", description: "A blacksmith." }]);
  const createEntry = batch.mutations.find((m) => m.op === "upsert_entity");

  redirectMentionScanRowToExistingOp(dataDir, WORLD, {
    batchId: batch.id,
    mutationId: createEntry.mutationId,
    existingEntityId: "mira"
  });

  const updated = loadBatch(WORLD, batch.id);
  const remaining = updated.mutations[0];
  // Simulate the real accept path (acceptMutationIds -- the same function
  // review-ui's accept routes call), then confirm what WOULD actually be
  // applied to the graph: exactly one edge mutation, no entity create.
  acceptMutationIds(WORLD, batch.id, [remaining.mutationId], { entities: existingSnapshot.entities, edges: existingSnapshot.edges });
  const accepted = loadBatch(WORLD, batch.id);
  const acceptedMutations = accepted.mutations.filter((m) => m.status === "accepted");
  assert.equal(acceptedMutations.length, 1);
  assert.equal(acceptedMutations[0].op, "upsert_edge");
  assert.equal(acceptedMutations[0].data.targetId, "mira");
  assert.ok(!acceptedMutations.some((m) => m.op === "upsert_entity"), "no entity-create mutation must survive to be applied -- redirecting must not silently ALSO create the duplicate");
});

await test("redirect refuses a non-pending row", () => {
  const batch = buildScanBatch([{ name: "Gorrim the Smith", type: "person" }]);
  const createEntry = batch.mutations.find((m) => m.op === "upsert_entity");
  acceptMutationIds(WORLD, batch.id, [createEntry.mutationId, batch.mutations.find((m) => m.op === "upsert_edge").mutationId], {
    entities: existingSnapshot.entities,
    edges: existingSnapshot.edges
  });
  assert.throws(
    () => redirectMentionScanRowToExistingOp(dataDir, WORLD, { batchId: batch.id, mutationId: createEntry.mutationId, existingEntityId: "mira" }),
    /not pending/
  );
});

await test("redirect refuses a LINK row (already correct by definition) and a non-mention-scan batch", () => {
  const linkBatch = buildScanBatch([{ name: "Mira", type: "person" }]); // matches an EXISTING entity -> a link row, not propose-new
  const linkEntry = linkBatch.mutations.find((m) => m.op === "upsert_edge");
  assert.equal(linkEntry.entityContext.scanResultKind, "link");
  assert.throws(
    () => redirectMentionScanRowToExistingOp(dataDir, WORLD, { batchId: linkBatch.id, mutationId: linkEntry.mutationId, existingEntityId: "kael" }),
    /propose new/
  );

  const manualBatch = createBatch(
    WORLD,
    { mode: "manual" },
    undefined,
    [{ op: "upsert_entity", id: "x", data: { name: "X", type: "person" }, rationale: "r", batchId: "placeholder", sourceKind: "manual" }],
    { makeId: () => `batch_redirect_test_manual_${idCounter++}` }
  );
  assert.throws(
    () => redirectMentionScanRowToExistingOp(dataDir, WORLD, { batchId: manualBatch.id, mutationId: manualBatch.mutations[0].mutationId, existingEntityId: "kael" }),
    /not a mention-scan batch/
  );
});

await test("self-review remediation: redirect refuses a nonexistent existingEntityId rather than silently pointing the mutation at garbage", () => {
  const batch = buildScanBatch([{ name: "Gorrim the Smith", type: "person" }]);
  const createEntry = batch.mutations.find((m) => m.op === "upsert_entity");
  assert.throws(
    () => redirectMentionScanRowToExistingOp(dataDir, WORLD, { batchId: batch.id, mutationId: createEntry.mutationId, existingEntityId: "no-such-entity" }),
    /No entity "no-such-entity" found/
  );
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
