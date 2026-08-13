import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Phase 12 tasks 12.3/12.4/12.6 -- HTTP-layer route tests for manual node/
 * edge create/edit/delete, "Undo Last Manual Edit", and narration reset.
 * Matches routes.test.mjs/graph-routes.test.mjs's established style: real
 * HTTP requests against an in-process server.listen(0), a fixture world
 * seeded via applyHeadless directly.
 *
 * PHASE 13 TASK 13.1: every write below now goes straight to the headless
 * snapshot immediately (manual-edit-ops.mjs's applyManualMutations) --
 * unlike this file's pre-Phase-13 version, no fake mutation-watcher loop is
 * needed at all, since these writes never touch world-fabric-mutations.json
 * in the first place. The deferred-sync/live-bridge mechanism itself is
 * covered separately by wf-mcp-server/test/manual-edit-sync.test.mjs.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-manual-edit-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "manual-edit-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "farkas", name: "Farkas", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "the-forge", name: "The Forge", type: "place", importance: 0.6 } },
  { op: "upsert_edge", data: { id: "farkas-forge-edge", sourceId: "farkas", targetId: "the-forge", relationshipType: "presence" } }
]);

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
async function deleteJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function fetchEntities() {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  return body.nodes;
}
async function fetchEdges() {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  return body.edges;
}

test("POST /api/graph/nodes creates a real node immediately", async () => {
  const { status, body } = await postJson("/api/graph/nodes", { world: WORLD, name: "Aela", type: "person", description: "A huntress." });
  assert.equal(status, 200);
  assert.equal(body.name, "Aela");
  const nodes = await fetchEntities();
  assert.ok(nodes.some((n) => n.id === body.entityId && n.name === "Aela"));
});

test("POST /api/graph/nodes with an empty name is a clean 400", async () => {
  const { status } = await postJson("/api/graph/nodes", { world: WORLD, name: "  ", type: "person" });
  assert.equal(status, 400);
});

// QA W2 fix (Group B #12): a 5M-char name used to round-trip straight into
// the graph -- no length cap at all.
test("POST /api/graph/nodes with a 5M-char name is a clean 400, creates no entity", async () => {
  const before = await fetchEntities();
  const { status, body } = await postJson("/api/graph/nodes", { world: WORLD, name: "x".repeat(5_000_000), type: "person" });
  assert.equal(status, 400);
  assert.ok(/200 characters/.test(body.error), `expected a clear length-cap message, got: ${body.error}`);
  const after = await fetchEntities();
  assert.equal(after.length, before.length, "a rejected create must not persist a partial entity");
});

test("POST /api/manual-undo undoes the most recent manual edit (add node)", async () => {
  const before = await fetchEntities();
  const { body: createBody } = await postJson("/api/graph/nodes", { world: WORLD, name: "Undo-Me", type: "concept" });
  const mid = await fetchEntities();
  assert.equal(mid.length, before.length + 1);

  const { status, body } = await postJson("/api/manual-undo", { world: WORLD, dataDir: dataDir });
  assert.equal(status, 200);
  assert.equal(body.status, "undone");
  assert.equal(body.kind, "add_node");
  const after = await fetchEntities();
  assert.equal(after.length, before.length);
  assert.ok(!after.some((n) => n.id === createBody.entityId));
});

test("GET /api/manual-undo reflects availability without consuming the slot", async () => {
  await postJson("/api/graph/nodes", { world: WORLD, name: "Status Check", type: "concept" });
  const first = await getJson(`/api/manual-undo?world=${WORLD}`);
  assert.equal(first.body.available, true);
  const second = await getJson(`/api/manual-undo?world=${WORLD}`);
  assert.equal(second.body.available, true, "a GET must never consume the slot");
  await postJson("/api/manual-undo", { world: WORLD, dataDir: dataDir }); // clean up
});

test("POST /api/graph/edges creates a real edge between two existing entities", async () => {
  const { status, body } = await postJson("/api/graph/edges", { world: WORLD, dataDir, sourceId: "farkas", targetId: "the-forge", relationshipType: "ownership" });
  assert.equal(status, 200);
  const edges = await fetchEdges();
  assert.ok(edges.some((e) => e.id === body.edgeId && e.relationshipType === "ownership"));
  await postJson("/api/manual-undo", { world: WORLD, dataDir }); // clean up
});

test("POST /api/graph/edges refuses a self-loop with a clean 400", async () => {
  const { status } = await postJson("/api/graph/edges", { world: WORLD, dataDir, sourceId: "farkas", targetId: "farkas" });
  assert.equal(status, 400);
});

test("POST /api/graph/nodes/:entityId edits an existing node immediately", async () => {
  const { status, body } = await postJson(`/api/graph/nodes/farkas`, { world: WORLD, dataDir, data: { importance: 0.95 } });
  assert.equal(status, 200);
  assert.equal(body.updated.importance, 0.95);
  const nodes = await fetchEntities();
  assert.equal(nodes.find((n) => n.id === "farkas").importance, 0.95);
  await postJson("/api/manual-undo", { world: WORLD, dataDir }); // restore importance for later tests
});

test("DELETE /api/graph/nodes/:entityId deletes the node AND cascades its edges, undo restores both atomically", async () => {
  const edgesBefore = (await fetchEdges()).filter((e) => e.sourceId === "farkas" || e.targetId === "farkas");
  assert.ok(edgesBefore.length >= 1, "expected farkas to have at least one edge before delete");

  const { status, body } = await deleteJson(`/api/graph/nodes/farkas`, { world: WORLD, dataDir });
  assert.equal(status, 200);
  assert.equal(body.cascadeEdgeCount, edgesBefore.length);

  const nodesAfterDelete = await fetchEntities();
  assert.ok(!nodesAfterDelete.some((n) => n.id === "farkas"), "farkas must be genuinely gone");
  const edgesAfterDelete = (await fetchEdges()).filter((e) => e.sourceId === "farkas" || e.targetId === "farkas");
  assert.equal(edgesAfterDelete.length, 0, "every edge touching farkas must be gone too");

  const undo = await postJson("/api/manual-undo", { world: WORLD, dataDir });
  assert.equal(undo.body.status, "undone");
  assert.equal(undo.body.kind, "delete_node");
  const nodesAfterUndo = await fetchEntities();
  assert.ok(nodesAfterUndo.some((n) => n.id === "farkas"), "farkas must be back after undo");
  const edgesAfterUndo = (await fetchEdges()).filter((e) => e.sourceId === "farkas" || e.targetId === "farkas");
  assert.equal(edgesAfterUndo.length, edgesBefore.length, "ALL cascaded edges must come back, not just the node itself");
});

test("POST /api/entities/:entityId/narration/reset appends an empty version and is covered by undo", async () => {
  const { saveEntityNarration, getCurrentEntityNarration, getEntityNarrationHistory } =
    await import("../../mutation-engine/entity-narration.mjs");
  saveEntityNarration(WORLD, "the-forge", { prose: "A roaring forge, always warm." });

  const { status, body } = await postJson("/api/entities/the-forge/narration/reset", { world: WORLD });
  assert.equal(status, 200);
  assert.equal(getCurrentEntityNarration(WORLD, "the-forge").prose, "");
  assert.ok(getEntityNarrationHistory(WORLD, "the-forge").some((h) => h.prose === "A roaring forge, always warm." && h.status === "superseded"));

  const undo = await postJson("/api/manual-undo", { world: WORLD, dataDir });
  assert.equal(undo.body.status, "undone");
  assert.equal(undo.body.kind, "narration_reset");
  assert.equal(getCurrentEntityNarration(WORLD, "the-forge").prose, "A roaring forge, always warm.");
});

test("POST /api/entities/:entityId/scan-mentions with empty text is a clean 400, no API call", async () => {
  const { status } = await postJson("/api/entities/farkas/scan-mentions", { world: WORLD, dataDir, text: "" });
  assert.equal(status, 400);
});

// ---------------------------------------------------------------------------
// Phase 13 task 13.1 -- deferred sync's "N manual edits not yet synced"
// route, and the existing (unmodified) /sync route reused against it.
// ---------------------------------------------------------------------------

test("GET /api/manual-edit-sync-status reports 0/null when nothing is unsynced", async () => {
  // Uses a fresh world so this test is independent of whatever the manual-
  // edit batch above this point in the file has accumulated.
  const freshWorld = "manual-edit-routes-sync-status-world";
  const freshSnap = snapshotFilePath(dataDir, freshWorld);
  bootstrapSnapshot(freshSnap, { worldId: freshWorld });

  const { status, body } = await getJson(`/api/manual-edit-sync-status?world=${freshWorld}`);
  assert.equal(status, 200);
  assert.equal(body.batchId, null);
  assert.equal(body.unsyncedCount, 0);
});

test("GET /api/manual-edit-sync-status counts accumulated manual edits, and POST .../sync (the EXISTING route) clears it", async () => {
  const freshWorld = "manual-edit-routes-sync-status-world-2";
  const freshSnap = snapshotFilePath(dataDir, freshWorld);
  bootstrapSnapshot(freshSnap, { worldId: freshWorld });

  await postJson("/api/graph/nodes", { world: freshWorld, name: "Sync Status Node A", type: "concept" });
  await postJson("/api/graph/nodes", { world: freshWorld, name: "Sync Status Node B", type: "concept" });

  const before = await getJson(`/api/manual-edit-sync-status?world=${freshWorld}`);
  assert.equal(before.body.unsyncedCount, 2);
  assert.ok(before.body.batchId);

  const sync = await postJson(`/api/batches/${before.body.batchId}/sync`, { world: freshWorld, dataDir });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.syncedCount, 2);

  const after = await getJson(`/api/manual-edit-sync-status?world=${freshWorld}`);
  assert.equal(after.body.unsyncedCount, 0, "the sync-bar's own affordance must clear once synced");
  assert.equal(after.body.batchId, null);
});

console.log("manual-edit-routes.test.mjs: all node:test cases registered.");
