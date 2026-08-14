import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Friction Wave 1, W1b -- HTTP-layer test for POST
 * /api/batches/:batchId/mutations/:mutationId/convert-to-existing, plus the
 * end-to-end promise: after converting, accepting, and syncing, the EXISTING
 * entity is updated and NO duplicate entity is ever created. (The sync test
 * pays the live-bridge 7s poll before the headless fallback -- deliberate,
 * per this repo's generous-timeout e2e convention.)
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w1b-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w1b-convert-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../time-skip/run.mjs");
const { createReviewServer } = await import("../server.mjs");

const liveEntities = [
  { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." },
  { id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." }
];
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, liveEntities.map((e) => ({ op: "upsert_entity", data: e })));

let idCounter = 0;
function wm(extra) {
  return { rationale: "from the writeup", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}
function buildBatch() {
  const mutations = attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_vane", data: { name: "Master Vane", type: "person", description: "Placed the fate-threads over three years." } }),
      wm({ op: "upsert_edge", id: "wf_e_0", data: { sourceId: "wf_new_vane", targetId: "skein", relationshipType: "works-in" } })
    ],
    liveEntities,
    []
  );
  return createBatch(WORLD, { mode: "writeup-import", text: "seed" }, undefined, mutations, {
    makeId: () => `batch_w1b_route_${idCounter++}`
  });
}

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("W1b route: converts and re-points, verified via GET batch detail", async () => {
  const batch = buildBatch();
  const [createM, edgeM] = batch.mutations;
  const { status, body } = await postJson(
    `/api/batches/${batch.id}/mutations/${createM.mutationId}/convert-to-existing`,
    { world: WORLD, existingEntityId: "vane" }
  );
  assert.equal(status, 200);
  assert.equal(body.convertedTo, "vane");
  assert.deepEqual(body.repointedEdgeMutationIds, [edgeM.mutationId]);

  const detail = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  const rows = detail.body.regions.flatMap((r) => r.entities);
  const converted = rows.find((e) => e.mutationId === createM.mutationId);
  assert.equal(converted.entityId, "vane");
  assert.equal(converted.name, "Master Aldric Vane", "card reads as the canon entity now");
  assert.equal(converted.nearMatches, undefined, "an update carries no duplicate advisory");
  const edge = rows.find((e) => e.mutationId === edgeM.mutationId);
  assert.equal(edge.data.sourceId, "vane");
});

test("W1b route: 400s cleanly on a missing existingEntityId", async () => {
  const batch = buildBatch();
  const { status } = await postJson(`/api/batches/${batch.id}/mutations/${batch.mutations[0].mutationId}/convert-to-existing`, { world: WORLD });
  assert.equal(status, 400);
});

test("W1b end to end: convert -> accept -> sync updates the EXISTING entity, creates no duplicate", async () => {
  const batch = buildBatch();
  const [createM, edgeM] = batch.mutations;
  await postJson(`/api/batches/${batch.id}/mutations/${createM.mutationId}/convert-to-existing`, { world: WORLD, existingEntityId: "vane" });
  const acc = await postJson(`/api/batches/${batch.id}/bulk-accept`, { world: WORLD, mutationIds: [createM.mutationId, edgeM.mutationId], reviewedMutationIds: [createM.mutationId, edgeM.mutationId] });
  assert.equal(acc.status, 200);
  const sync = await postJson(`/api/batches/${batch.id}/sync`, { world: WORLD });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.path, "headless", "no live Foundry client in the test env -- headless fallback");

  const { snapshot: snap } = JSON.parse(readFileSync(snapPath, "utf8"));
  const vane = snap.entities.find((e) => e.id === "vane");
  assert.equal(vane.description, "Placed the fate-threads over three years.", "the existing entity got the new text");
  assert.equal(vane.name, "Master Aldric Vane", "canon name untouched");
  const dupes = snap.entities.filter((e) => (e.name || "").includes("Vane"));
  assert.equal(dupes.length, 1, "no duplicate 'Master Vane' entity was ever created");
  const edge = snap.edges.find((e) => e.sourceId === "vane" && e.targetId === "skein" && e.relationshipType === "works-in");
  assert.ok(edge, "the re-pointed edge landed on the existing entity");
});

console.log("w1b-convert-routes.test.mjs: all node:test cases registered.");
