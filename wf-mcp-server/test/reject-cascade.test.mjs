import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

/**
 * Friction Wave 1, W1d -- reject-cascade: rejecting a CREATE auto-rejects
 * every still-pending edge in the batch referencing its would-be-new id
 * (greyed + undoable via revertMutationsToPending), applied at the ONE
 * shared reject choke point (rejectMutationIds). The Kilmarn batch
 * (batch_mssa9fid_zldbi0) accepted 6 edges onto the rejected "Master Vane"
 * create -- this fixture reproduces that exact shape.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-reject-cascade-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const { createBatch, loadBatch, updateMutationStatus } = await import("../../mutation-engine/review-state.mjs");
const { rejectMutationIds, revertMutationsToPending } = await import("../lib/mutation-ops.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");

const WORLD = "reject-cascade-test-world";

const liveEntities = [
  { id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." }
];

after(() => rmSync(scratchDir, { recursive: true, force: true }));

let idCounter = 0;
function wm(extra) {
  return { rationale: "from the writeup", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}

/**
 * m0: create "Master Vane" (wf_new_vane)
 * m1: create "Thread T-1" (wf_new_t1)
 * m2: edge vane->t1        (references BOTH creates, pending)
 * m3: edge vane->skein     (pending)
 * m4: edge t1->skein       (pending, does NOT reference vane)
 * m5: edge skein->vane     (ALREADY ACCEPTED -- settled, never cascaded)
 * m6: update of live skein (non-create)
 */
function buildBatch() {
  const mutations = attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_vane", data: { name: "Master Vane", type: "person", description: "Placed the threads." } }),
      wm({ op: "upsert_entity", id: "wf_new_t1", data: { name: "Thread T-1", type: "object", description: "A strand of wrong color." } }),
      wm({ op: "upsert_edge", id: "wf_e_0", data: { sourceId: "wf_new_vane", targetId: "wf_new_t1", relationshipType: "placed" } }),
      wm({ op: "upsert_edge", id: "wf_e_1", data: { sourceId: "wf_new_vane", targetId: "skein", relationshipType: "works-in" } }),
      wm({ op: "upsert_edge", id: "wf_e_2", data: { sourceId: "wf_new_t1", targetId: "skein", relationshipType: "hidden-in" } }),
      wm({ op: "upsert_edge", id: "wf_e_3", data: { sourceId: "skein", targetId: "wf_new_vane", relationshipType: "hosts" } }),
      wm({ op: "upsert_entity", id: "skein", data: { description: "Now with looms." } })
    ],
    liveEntities,
    []
  );
  const batch = createBatch(WORLD, { mode: "writeup-import", text: "seed" }, undefined, mutations, {
    makeId: () => `batch_cascade_test_${idCounter++}`
  });
  updateMutationStatus(WORLD, batch.id, batch.mutations[5].mutationId, "accepted"); // m5 settled
  return loadBatch(WORLD, batch.id);
}

test("W1d: rejecting a create auto-rejects every still-pending edge referencing it, with the cascade stamp", () => {
  const batch = buildBatch();
  const [m0, , m2, m3, m4, m5, m6] = batch.mutations;
  const result = rejectMutationIds(WORLD, batch.id, [m0.mutationId]);
  assert.deepEqual(result.rejected, [m0.mutationId]);
  assert.deepEqual([...result.cascadeRejected].sort(), [m2.mutationId, m3.mutationId].sort(), "both pending edges touching wf_new_vane cascade");

  const saved = loadBatch(WORLD, batch.id);
  const byId = (mid) => saved.mutations.find((m) => m.mutationId === mid);
  assert.equal(byId(m2.mutationId).status, "rejected");
  assert.equal(byId(m2.mutationId).entityContext.cascadeRejectedWith, m0.mutationId, "cascade is auditable");
  assert.equal(byId(m3.mutationId).status, "rejected");
  assert.equal(byId(m4.mutationId).status, "pending", "an edge not referencing the rejected create is untouched");
  assert.equal(byId(m5.mutationId).status, "accepted", "a settled edge is history -- never cascaded");
  assert.equal(byId(m6.mutationId).status, "pending", "the unrelated update is untouched");
});

test("W1d: rejecting a NON-create (update) never cascades", () => {
  const batch = buildBatch();
  const m6 = batch.mutations[6];
  const result = rejectMutationIds(WORLD, batch.id, [m6.mutationId]);
  assert.equal(result.cascadeRejected, undefined);
  const saved = loadBatch(WORLD, batch.id);
  assert.equal(saved.mutations[2].status, "pending");
  assert.equal(saved.mutations[3].status, "pending");
});

test("W1d: an edge explicitly rejected in the same call is not double-counted as cascade", () => {
  const batch = buildBatch();
  const [m0, , m2, m3] = batch.mutations;
  const result = rejectMutationIds(WORLD, batch.id, [m0.mutationId, m2.mutationId]);
  assert.deepEqual(result.cascadeRejected, [m3.mutationId], "only the edge NOT already in the reject set cascades");
});

test("W1d: revertMutationsToPending restores cascaded edges (undo) and clears the stamp", () => {
  const batch = buildBatch();
  const [m0, , m2, m3] = batch.mutations;
  const { cascadeRejected } = rejectMutationIds(WORLD, batch.id, [m0.mutationId]);
  const result = revertMutationsToPending(WORLD, { batchId: batch.id, mutationIds: cascadeRejected });
  assert.deepEqual(result.revertedToPending, cascadeRejected);

  const saved = loadBatch(WORLD, batch.id);
  const byId = (mid) => saved.mutations.find((m) => m.mutationId === mid);
  assert.equal(byId(m2.mutationId).status, "pending");
  assert.equal(byId(m3.mutationId).status, "pending");
  assert.ok(!("cascadeRejectedWith" in (byId(m2.mutationId).entityContext ?? {})), "the cascade stamp is cleared on undo");
  assert.equal(byId(m0.mutationId).status, "rejected", "the create's own reject stands -- undo restores only the edges");
});

test("W1d: revertMutationsToPending refuses an accepted mutation and an unknown one", () => {
  const batch = buildBatch();
  const m5 = batch.mutations[5]; // accepted
  assert.throws(() => revertMutationsToPending(WORLD, { batchId: batch.id, mutationIds: [m5.mutationId] }), /only a rejected mutation/);
  assert.throws(() => revertMutationsToPending(WORLD, { batchId: batch.id, mutationIds: ["m999"] }), /No mutation "m999"/);
  assert.throws(() => revertMutationsToPending(WORLD, { batchId: batch.id, mutationIds: [] }), /non-empty/);
});
