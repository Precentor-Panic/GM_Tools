import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W1d -- HTTP layer: the reject route surfaces
 * `cascadeRejected` (so the UI can grey the edge cards and offer Undo), and
 * POST .../revert-to-pending performs that undo. Logic depth lives in
 * wf-mcp-server/test/reject-cascade.test.mjs; this guards the wiring.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w1d-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w1d-cascade-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");
const { createReviewServer } = await import("../server.mjs");

const liveEntities = [{ id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." }];
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, liveEntities.map((e) => ({ op: "upsert_entity", data: e })));

let idCounter = 0;
function wm(extra) {
  return { rationale: "r", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}
function buildBatch() {
  const mutations = attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_vane", data: { name: "Master Vane", type: "person", description: "Placed the threads." } }),
      wm({ op: "upsert_edge", id: "wf_e_0", data: { sourceId: "wf_new_vane", targetId: "skein", relationshipType: "works-in" } })
    ],
    liveEntities,
    []
  );
  return createBatch(WORLD, { mode: "writeup-import", text: "seed" }, undefined, mutations, {
    makeId: () => `batch_w1d_route_${idCounter++}`
  });
}

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function getRows(batchId) {
  const res = await fetch(`${base}/api/batches/${batchId}?world=${WORLD}`);
  return (await res.json()).regions.flatMap((r) => r.entities);
}

test("W1d routes: reject returns cascadeRejected; revert-to-pending undoes it", async () => {
  const batch = buildBatch();
  const [createM, edgeM] = batch.mutations;

  const rej = await postJson(`/api/batches/${batch.id}/reject`, { world: WORLD, scope: "entity", id: createM.mutationId });
  assert.equal(rej.status, 200);
  assert.deepEqual(rej.body.cascadeRejected, [edgeM.mutationId]);
  let rows = await getRows(batch.id);
  assert.equal(rows.find((e) => e.mutationId === edgeM.mutationId).status, "rejected");

  const undo = await postJson(`/api/batches/${batch.id}/revert-to-pending`, { world: WORLD, mutationIds: [edgeM.mutationId] });
  assert.equal(undo.status, 200);
  rows = await getRows(batch.id);
  assert.equal(rows.find((e) => e.mutationId === edgeM.mutationId).status, "pending");
  assert.equal(rows.find((e) => e.mutationId === createM.mutationId).status, "rejected", "the create's own reject stands");
});

test("W1d routes: bulk-reject carries the cascade too; revert refuses non-rejected (400)", async () => {
  const batch = buildBatch();
  const [createM, edgeM] = batch.mutations;
  const rej = await postJson(`/api/batches/${batch.id}/bulk-reject`, { world: WORLD, mutationIds: [createM.mutationId] });
  assert.equal(rej.status, 200);
  assert.deepEqual(rej.body.cascadeRejected, [edgeM.mutationId]);

  const acc = await postJson(`/api/batches/${batch.id}/revert-to-pending`, { world: WORLD, mutationIds: ["m999"] });
  assert.equal(acc.status, 400);
});

console.log("w1d-cascade-routes.test.mjs: all node:test cases registered.");
