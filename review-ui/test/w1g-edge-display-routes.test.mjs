import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W1g -- HTTP layer: every EDGE row in the batch detail
 * payload carries `edgeDisplay` with real endpoint NAMES ("A —label→ B",
 * never raw ids): batch-create names for not-yet-created endpoints, live
 * snapshot names for existing ones, the raw id only as an honest last
 * resort, and live-edge endpoint resolution for a delete of an existing
 * edge whose own data carries no endpoints.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w1g-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w1g-edge-display-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");
const { createReviewServer } = await import("../server.mjs");

const liveEntities = [
  { id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." },
  { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster." }
];
const liveEdges = [{ id: "edge_live_0", sourceId: "vane", targetId: "skein", relationshipType: "works-in" }];
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  ...liveEntities.map((e) => ({ op: "upsert_entity", data: e })),
  ...liveEdges.map((e) => ({ op: "upsert_edge", data: e }))
]);

function wm(extra) {
  return { rationale: "r", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}
const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed" },
  undefined,
  attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_t1", data: { name: "Thread T-1", type: "object", description: "A strand." } }),
      wm({ op: "upsert_edge", id: "wf_e_0", data: { sourceId: "wf_new_t1", targetId: "skein", relationshipType: "hidden-in" } }),
      wm({ op: "upsert_edge", id: "wf_e_1", data: { sourceId: "wf_new_t1", targetId: "wf_ghost", relationshipType: "tied-to" } }),
      wm({ op: "delete_edge", id: "edge_live_0", data: {} })
    ],
    liveEntities,
    liveEdges
  ),
  { makeId: () => "batch_w1g_test" }
);

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

test("W1g: edge rows resolve endpoint names from batch creates, live snapshot, and raw-id fallback", async () => {
  const res = await fetch(`${base}/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(res.status, 200);
  const rows = (await res.json()).regions.flatMap((r) => r.entities);
  const byMid = (mid) => rows.find((e) => e.mutationId === mid);

  const newEdge = byMid(batch.mutations[1].mutationId);
  assert.deepEqual(newEdge.edgeDisplay, {
    sourceId: "wf_new_t1",
    targetId: "skein",
    sourceName: "Thread T-1",
    targetName: "The Skein",
    label: "hidden-in"
  }, "batch-create name for the new endpoint, live name for the existing one");

  const ghostEdge = byMid(batch.mutations[2].mutationId);
  assert.equal(ghostEdge.edgeDisplay.targetName, "wf_ghost", "an unresolvable endpoint falls back to the raw id, honestly");

  const deleteEdge = byMid(batch.mutations[3].mutationId);
  assert.equal(deleteEdge.edgeDisplay.sourceName, "Master Aldric Vane", "a delete of an existing edge resolves endpoints via the live edge record");
  assert.equal(deleteEdge.edgeDisplay.targetName, "The Skein");
  assert.equal(deleteEdge.edgeDisplay.label, "works-in");

  const nodeRow = byMid(batch.mutations[0].mutationId);
  assert.equal(nodeRow.edgeDisplay, undefined, "node rows carry no edgeDisplay");
});

console.log("w1g-edge-display-routes.test.mjs: all node:test cases registered.");
