import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
 * Runs a background fake mutation-watcher (same convention
 * wf-mcp-server/test/manual-edit-ops.test.mjs already established, one
 * level down at the HTTP boundary here) so every write below takes the fast
 * live-simulated path instead of the full 7s poll-then-headless window.
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

const { snapshotFilePath, mutationsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
const mutPath = mutationsPath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "farkas", name: "Farkas", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "the-forge", name: "The Forge", type: "place", importance: 0.6 } },
  { op: "upsert_edge", data: { id: "farkas-forge-edge", sourceId: "farkas", targetId: "the-forge", relationshipType: "presence" } }
]);

let watcherStopped = false;
const watcherLoop = (async () => {
  while (!watcherStopped) {
    if (existsSync(mutPath)) {
      const contents = readFileSync(mutPath, "utf8").trim();
      if (contents !== "[]" && contents !== "") {
        const mutations = JSON.parse(contents);
        if (Array.isArray(mutations) && mutations.length) applyHeadless(snapPath, mutations);
        writeFileSync(mutPath, "[]", "utf8");
      }
    }
    await new Promise((r) => setTimeout(r, 30));
  }
})();

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  watcherStopped = true;
  await watcherLoop;
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

console.log("manual-edit-routes.test.mjs: all node:test cases registered.");
