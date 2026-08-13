import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * QA fix-wave W1, Fix 2's sibling finding: the Session Planner's "Create new
 * place" flow (review-ui/public/plans-view.js's mountAddScenePanel, and the
 * World tab's own unanchored add) POSTs `/api/graph/nodes`, then immediately
 * uses the response's `entityId` to POST `/api/session-planner/scenes` with
 * `locationEntityId: entityId` -- the exact "create place -> create scene
 * with locationEntityId" route flow the QA finding calls out. Before this
 * fix-wave, a name+type collision at the first step returned a PHANTOM id
 * (never actually persisted -- manual-edit-ops.mjs's addNodeOp trusted its
 * own pre-assigned id rather than importGraph's real merge outcome), so a
 * scene created from it stored a locationEntityId that resolved to NOTHING
 * in the real graph -- permanent raw-id display, and the entity that
 * genuinely "used" it never showed up as such (world-view.js's
 * usedInScene set never contained the phantom id under which the survivor
 * entity is actually stored).
 *
 * This file proves the fix holds at the HTTP route boundary (not just the
 * lower-level manual-edit-ops/headless-apply unit tests) for BOTH cases the
 * QE spec calls out: (a) a fresh, non-colliding name, and (b) a colliding
 * name -- both must yield a scene whose location resolves to the REAL place
 * name via the real graph, never a dangling id.
 *
 * Matches manual-edit-routes.test.mjs's established style: real HTTP
 * requests against an in-process server.listen(0), a fixture world seeded
 * via applyHeadless directly.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-create-place-scene-flow-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "create-place-scene-flow-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

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

async function graphEntities() {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  return body.nodes ?? body.entities ?? [];
}

test("create-place -> create-scene route flow (a): a FRESH, non-colliding name yields a scene whose location resolves to the real place, by real id and name", async () => {
  const created = await postJson("/api/graph/nodes", { world: WORLD, name: "Windhollow Keep", type: "place" });
  assert.equal(created.status, 200);
  assert.equal(created.body.merged, false);

  const scene = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: created.body.entityId });
  assert.equal(scene.status, 200);
  assert.equal(scene.body.scene.locationEntityId, created.body.entityId);

  const entities = await graphEntities();
  const located = entities.find((e) => e.id === scene.body.scene.locationEntityId);
  assert.ok(located, "the scene's locationEntityId must resolve to a real entity in the graph");
  assert.equal(located.name, "Windhollow Keep");
  assert.equal(located.type, "place");
});

test("create-place -> create-scene route flow (b): a COLLIDING name (same name+type as an already-created place) still yields a scene whose location resolves to the real (survivor) place, never a dangling id", async () => {
  const first = await postJson("/api/graph/nodes", { world: WORLD, name: "The Sunken Quay", type: "place" });
  assert.equal(first.body.merged, false);

  // Second "create" with the identical name+type -- this is exactly the
  // name-collision addNodeOp/importGraph merge-folds, pre-fix returning a
  // phantom id never actually persisted.
  const second = await postJson("/api/graph/nodes", { world: WORLD, name: "The Sunken Quay", type: "place" });
  assert.equal(second.status, 200);
  assert.equal(second.body.merged, true, "the route must surface the merge outcome honestly");
  assert.equal(second.body.entityId, first.body.entityId, "must resolve to the SAME survivor entity the first create made");

  const scene = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: second.body.entityId });
  assert.equal(scene.status, 200);

  const entities = await graphEntities();
  const located = entities.find((e) => e.id === scene.body.scene.locationEntityId);
  assert.ok(located, "the scene's locationEntityId must resolve to a real entity in the graph, not a phantom");
  assert.equal(located.name, "The Sunken Quay");
  assert.equal(located.type, "place");
  // Exactly one persisted place for this name, not two.
  assert.equal(entities.filter((e) => e.name === "The Sunken Quay").length, 1);
});
