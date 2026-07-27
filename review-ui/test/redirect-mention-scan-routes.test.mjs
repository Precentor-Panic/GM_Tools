import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Phase 13 task 13.3 -- HTTP-layer route test for "Link to existing
 * instead" (POST /api/batches/:batchId/mutations/:mutationId/redirect-to-
 * existing). Deterministic: builds the mention-scan batch directly via
 * scan-mentions.mjs's own previewMentionScan (no LLM call), matching
 * wf-mcp-server/test/redirect-mention-scan.test.mjs's own fixture approach
 * one layer down, then drives the route the same way routes.test.mjs/
 * manual-edit-routes.test.mjs already do (real HTTP against an in-process
 * server.listen(0)).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-redirect-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "redirect-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { previewMentionScan } = await import("../../graph-import/scan-mentions.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "kael", name: "Kael", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "mira", name: "Mira", type: "person", importance: 0.4 } }
]);

const existingSnapshot = { entities: [{ id: "kael", name: "Kael", type: "person" }, { id: "mira", name: "Mira", type: "person" }], edges: [], entityTypes: [] };
let idCounter = 0;
function buildScanBatch() {
  const { mutations } = previewMentionScan(
    [{ name: "Gorrim the Smith", type: "person", description: "A blacksmith." }],
    "kael",
    existingSnapshot,
    { makeId: () => `wf_route_test_${idCounter++}` }
  );
  return createBatch(WORLD, { mode: "mention-scan", sourceEntityId: "kael", sourceEntityName: "Kael" }, undefined, mutations, {
    makeId: () => `batch_redirect_route_test_${idCounter++}`
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

test("POST .../redirect-to-existing converts a propose-new row into a genuine link, verified via GET batch detail", async () => {
  const batch = buildScanBatch();
  const createEntry = batch.mutations.find((m) => m.op === "upsert_entity");

  const { status, body } = await postJson(
    `/api/batches/${batch.id}/mutations/${createEntry.mutationId}/redirect-to-existing`,
    { world: WORLD, existingEntityId: "mira", existingEntityName: "Mira" }
  );
  assert.equal(status, 200);
  assert.equal(body.redirectedTo, "mira");

  const detail = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  const allEntities = detail.body.regions.flatMap((r) => r.entities);
  assert.equal(allEntities.length, 1, "the sibling edge-to-would-be-new-entity must be gone, exactly one row remains");
  assert.equal(allEntities[0].op, "upsert_edge");
  assert.equal(allEntities[0].scanResultKind, "link", "badge/border must now read as a LINK row");
  assert.equal(allEntities[0].data.targetId, "mira");
});

test("POST .../redirect-to-existing 400s cleanly with a missing existingEntityId", async () => {
  const batch = buildScanBatch();
  const createEntry = batch.mutations.find((m) => m.op === "upsert_entity");
  const { status } = await postJson(`/api/batches/${batch.id}/mutations/${createEntry.mutationId}/redirect-to-existing`, { world: WORLD });
  assert.equal(status, 400);
});

test("POST .../redirect-to-existing refuses a LINK row (400, not silently accepted)", async () => {
  const { mutations } = previewMentionScan([{ name: "Mira", type: "person" }], "kael", existingSnapshot, { makeId: () => `wf_route_test_${idCounter++}` });
  const batch = createBatch(WORLD, { mode: "mention-scan", sourceEntityId: "kael", sourceEntityName: "Kael" }, undefined, mutations, {
    makeId: () => `batch_redirect_route_test_link_${idCounter++}`
  });
  const linkEntry = batch.mutations.find((m) => m.op === "upsert_edge");
  assert.equal(linkEntry.entityContext.scanResultKind, "link");
  const { status } = await postJson(`/api/batches/${batch.id}/mutations/${linkEntry.mutationId}/redirect-to-existing`, {
    world: WORLD,
    existingEntityId: "kael"
  });
  assert.equal(status, 400);
});

console.log("redirect-mention-scan-routes.test.mjs: all node:test cases registered.");
