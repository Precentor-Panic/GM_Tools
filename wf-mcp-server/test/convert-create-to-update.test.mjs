import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

/**
 * Friction Wave 1, W1b -- convertCreateToUpdateOfExistingOp: a still-pending
 * proposed CREATE converted into an UPDATE of a reviewer-chosen existing
 * entity, with batch-wide re-pointing of still-pending edges that referenced
 * the would-be-new id. The fixture reproduces the real Kilmarn shape that
 * motivated it: a "Master Vane" create (canon: "Master Aldric Vane") with
 * several sibling edges hanging off the would-be-new id, one of them already
 * settled.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-convert-create-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;

const { createBatch, loadBatch, updateMutationStatus } = await import("../../mutation-engine/review-state.mjs");
const { convertCreateToUpdateOfExistingOp, isCreateEntityMutation } = await import("../lib/mutation-ops.mjs");
const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");

const WORLD = "convert-create-test-world";

const liveEntities = [
  { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." },
  { id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." }
];

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, liveEntities.map((e) => ({ op: "upsert_entity", data: e })));

after(() => rmSync(scratchDir, { recursive: true, force: true }));

let idCounter = 0;
function wm(extra) {
  return { rationale: "from the writeup", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}

/** create "Master Vane" (would-be id wf_new_vane) + edges touching it + an unrelated edge */
function buildBatch() {
  const mutations = attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_vane", data: { name: "Master Vane", type: "person", description: "Placed the fate-threads over three years.", importance: 0.8 } }),
      wm({ op: "upsert_edge", id: "wf_e_0", data: { sourceId: "wf_new_vane", targetId: "skein", relationshipType: "works-in" } }),
      wm({ op: "upsert_edge", id: "wf_e_1", data: { sourceId: "skein", targetId: "wf_new_vane", relationshipType: "hosts" } }),
      wm({ op: "upsert_edge", id: "wf_e_2", data: { sourceId: "skein", targetId: "vane", relationshipType: "unrelated" } })
    ],
    liveEntities,
    []
  );
  return createBatch(WORLD, { mode: "writeup-import", text: "seed" }, undefined, mutations, {
    makeId: () => `batch_convert_test_${idCounter++}`
  });
}

test("W1b: converts the create in place into an update of the existing entity (same mutationId, name/type dropped, new info kept)", () => {
  const batch = buildBatch();
  const createMid = batch.mutations[0].mutationId;
  const result = convertCreateToUpdateOfExistingOp(dataDir, WORLD, {
    batchId: batch.id,
    mutationId: createMid,
    existingEntityId: "vane"
  });
  assert.equal(result.convertedTo, "vane");
  assert.equal(result.originalId, "wf_new_vane");
  assert.equal(result.originalName, "Master Vane");

  const saved = loadBatch(WORLD, batch.id);
  const entry = saved.mutations.find((m) => m.mutationId === createMid);
  assert.equal(entry.op, "upsert_entity");
  assert.equal(entry.id, "vane", "the mutation now targets the existing entity");
  assert.equal(entry.data.name, undefined, "must not silently rename canon");
  assert.equal(entry.data.type, undefined, "must not silently retype canon");
  assert.equal(entry.data.description, "Placed the fate-threads over three years.", "the genuinely new text is kept for the merge");
  assert.equal(entry.entityContext.name, "Master Aldric Vane", "card identity is the canon entity now");
  assert.deepEqual(entry.entityContext.convertedFromCreate, { originalId: "wf_new_vane", originalName: "Master Vane" });
  // Re-diffed: no longer a "(created)" diff -- a real before/after against canon.
  assert.notEqual(entry.diff?.[0]?.field, "(created)");
  const descChange = entry.diff.find((c) => c.field === "description");
  assert.equal(descChange.from, "Guildmaster of the weavers.");
  assert.equal(descChange.to, "Placed the fate-threads over three years.");
  assert.equal(isCreateEntityMutation(entry, new Set(["vane", "skein"])), false);
});

test("W1b: re-points every still-pending edge referencing the would-be id (both directions), skips settled ones", () => {
  const batch = buildBatch();
  const [createM, edgeOut, edgeIn, unrelated] = batch.mutations;
  // Settle one referencing edge first -- it must NOT be re-pointed.
  updateMutationStatus(WORLD, batch.id, edgeIn.mutationId, "accepted");

  const result = convertCreateToUpdateOfExistingOp(dataDir, WORLD, {
    batchId: batch.id,
    mutationId: createM.mutationId,
    existingEntityId: "vane"
  });
  assert.deepEqual(result.repointedEdgeMutationIds, [edgeOut.mutationId]);
  assert.equal(result.skippedNonPendingEdgeCount, 1);

  const saved = loadBatch(WORLD, batch.id);
  const savedOut = saved.mutations.find((m) => m.mutationId === edgeOut.mutationId);
  assert.equal(savedOut.data.sourceId, "vane", "pending edge re-pointed to the existing entity");
  assert.equal(savedOut.data.targetId, "skein");
  const savedIn = saved.mutations.find((m) => m.mutationId === edgeIn.mutationId);
  assert.equal(savedIn.data.targetId, "wf_new_vane", "settled edge left untouched -- decisions are history");
  const savedUnrelated = saved.mutations.find((m) => m.mutationId === unrelated.mutationId);
  assert.deepEqual(savedUnrelated.data, { sourceId: "skein", targetId: "vane", relationshipType: "unrelated" });
});

test("W1b: refuses a non-create (an update of a live entity)", () => {
  const mutations = attachDiffs(
    [wm({ op: "upsert_entity", id: "vane", data: { description: "already an update" } })],
    liveEntities,
    []
  );
  const batch = createBatch(WORLD, { mode: "writeup-import", text: "seed" }, undefined, mutations, {
    makeId: () => `batch_convert_test_${idCounter++}`
  });
  assert.throws(
    () => convertCreateToUpdateOfExistingOp(dataDir, WORLD, { batchId: batch.id, mutationId: batch.mutations[0].mutationId, existingEntityId: "skein" }),
    /not a proposed CREATE/
  );
});

test("W1b: refuses a settled create and a nonexistent target entity", () => {
  const batch = buildBatch();
  const createMid = batch.mutations[0].mutationId;
  assert.throws(
    () => convertCreateToUpdateOfExistingOp(dataDir, WORLD, { batchId: batch.id, mutationId: createMid, existingEntityId: "nope" }),
    /No entity "nope"/
  );
  updateMutationStatus(WORLD, batch.id, createMid, "rejected");
  assert.throws(
    () => convertCreateToUpdateOfExistingOp(dataDir, WORLD, { batchId: batch.id, mutationId: createMid, existingEntityId: "vane" }),
    /not pending/
  );
});
