import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `session-planner/scene-elements.mjs` (Phase 28
 * task 28.1). Per-scene ordered elements:
 *   {id, sceneId, world, kind:'local'|'graph', graphEntityId?, name,
 *    fields:{trigger?,gives?,looks?,means?,checks?,function?,wants?,secret?,
 *    statblockRef?}, order}
 * `checks` is an array `[{skill, dc, purpose?}]`. `kind` defaults to
 * `"local"` on create when omitted (design record: "new elements default to
 * MUNDANE/scene-local... never classify importance at creation").
 *
 * promoteElement is the one op that touches the live graph: it creates a
 * REAL graph node (`addNodeOp`) and a REAL `containment` edge from that node
 * to the scene's own anchor place (`addEdgeOp`), per
 * review-ui/test/e2e/phase28-fixture.mjs §8. demoteElement NEVER deletes the
 * underlying graph node.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
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

// Isolate every store this module transitively touches BEFORE any import --
// review-state.mjs (withLock), scene-elements.mjs's own root, scenes.mjs
// (promote's getScene call), and manual-edit-ops.mjs's own dependencies
// (manual-undo/human-review), same pattern as
// test/scene-planning/transit-entity.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-elements-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans"); // scenes.mjs's deleteScene cascade collaborator, transitively imported
process.env.WF_DATA_DIR = dataDir;

const REPO_DEFAULT_ROOT = join(new URL("../../scene-elements", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "scene-elements-test-world";

const {
  createElement,
  listElementsForScene,
  getElement,
  updateElement,
  removeElement,
  reorderElements,
  promoteElement,
  demoteElement,
  sceneElementsRoot,
  SCHEMA_VERSION
} = await import("../../session-planner/scene-elements.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { snapshotFilePath, loadSnapshot } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "place-anchor-1", name: "The Sunken Chapel", type: "place", importance: 0.6 } }
]);

const anchoredScene = createScene(WORLD, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-anchored-1" });
const floatingScene = createScene(WORLD, {}, { makeId: () => "scene-floating-1" }); // no locationEntityId

test("directory isolation: sceneElementsRoot() honors GM_TOOLS_SCENE_ELEMENTS_DIR, never the repo's real default", () => {
  assert.equal(sceneElementsRoot(), process.env.GM_TOOLS_SCENE_ELEMENTS_DIR);
  assert.notEqual(sceneElementsRoot(), REPO_DEFAULT_ROOT);
});

test("SCHEMA_VERSION is exported", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("listElementsForScene: [] for a scene with no elements yet -- not an error", () => {
  assert.deepEqual(listElementsForScene(WORLD, "scene-never-had-elements"), []);
});

test("createElement: kind defaults to 'local' when omitted", () => {
  const element = createElement(WORLD, anchoredScene.id, { name: "A dusty lever" }, { makeId: () => "elem-default-kind" });
  assert.equal(element.kind, "local");
  assert.equal(element.graphEntityId, null);
  assert.equal(element.name, "A dusty lever");
  assert.deepEqual(element.fields, {});
});

test("createElement: an explicit kind is honored", () => {
  const element = createElement(WORLD, anchoredScene.id, { name: "Explicit graph kind", kind: "graph" }, { makeId: () => "elem-explicit-kind" });
  assert.equal(element.kind, "graph");
});

test("createElement: fields round-trip verbatim, including the checks array shape", () => {
  const element = createElement(
    WORLD,
    anchoredScene.id,
    {
      name: "Locked chest",
      fields: {
        trigger: "PCs search the room",
        gives: "a small brass key",
        checks: [{ skill: "Investigation", dc: 14, purpose: "spot the false bottom" }]
      }
    },
    { makeId: () => "elem-fields-roundtrip" }
  );
  assert.equal(element.fields.trigger, "PCs search the room");
  assert.equal(element.fields.gives, "a small brass key");
  assert.deepEqual(element.fields.checks, [{ skill: "Investigation", dc: 14, purpose: "spot the false bottom" }]);

  const reread = getElement(WORLD, anchoredScene.id, "elem-fields-roundtrip");
  assert.deepEqual(reread.fields.checks, element.fields.checks);
});

test("createElement: order increments per-scene, starting at 0, independent across scenes", () => {
  const world = "scene-elements-order-world";
  const sceneA = createScene(world, {}, { makeId: () => "scene-order-a" });
  const sceneB = createScene(world, {}, { makeId: () => "scene-order-b" });

  const a1 = createElement(world, sceneA.id, { name: "A1" }, { makeId: () => "elem-order-a1" });
  const a2 = createElement(world, sceneA.id, { name: "A2" }, { makeId: () => "elem-order-a2" });
  const b1 = createElement(world, sceneB.id, { name: "B1" }, { makeId: () => "elem-order-b1" });

  assert.equal(a1.order, 0);
  assert.equal(a2.order, 1);
  assert.equal(b1.order, 0, "sceneB's own order sequence starts fresh at 0, independent of sceneA's");
});

test("listElementsForScene: returns elements in `order`, scoped to the one scene", () => {
  const elements = listElementsForScene("scene-elements-order-world", "scene-order-a");
  assert.deepEqual(elements.map((e) => e.id), ["elem-order-a1", "elem-order-a2"]);
});

test("getElement: throws a clear error for an unknown elementId", () => {
  assert.throws(() => getElement(WORLD, anchoredScene.id, "does-not-exist"), /does-not-exist/);
});

test("updateElement: name replaces outright, fields shallow-merges onto the existing fields object", () => {
  createElement(WORLD, anchoredScene.id, { name: "Original name", fields: { trigger: "original trigger", gives: "original gives" } }, { makeId: () => "elem-update-1" });

  const updated = updateElement(WORLD, anchoredScene.id, "elem-update-1", { name: "New name", fields: { trigger: "new trigger" } });
  assert.equal(updated.name, "New name");
  assert.equal(updated.fields.trigger, "new trigger", "trigger overwritten");
  assert.equal(updated.fields.gives, "original gives", "gives untouched by a merge that didn't mention it");

  const reread = getElement(WORLD, anchoredScene.id, "elem-update-1");
  assert.equal(reread.name, "New name", "must genuinely persist, not just echo the input");
});

test("updateElement: throws a clear error for an unknown elementId", () => {
  assert.throws(() => updateElement(WORLD, anchoredScene.id, "does-not-exist-update", { name: "X" }), /does-not-exist-update/);
});

test("removeElement: idempotent -- {deleted:true} once, {deleted:false} on a repeat/unknown id", () => {
  createElement(WORLD, anchoredScene.id, { name: "To remove" }, { makeId: () => "elem-remove-1" });
  assert.deepEqual(removeElement(WORLD, anchoredScene.id, "elem-remove-1"), { deleted: true });
  assert.deepEqual(removeElement(WORLD, anchoredScene.id, "elem-remove-1"), { deleted: false });
  assert.deepEqual(removeElement(WORLD, anchoredScene.id, "elem-never-existed"), { deleted: false });
  assert.throws(() => getElement(WORLD, anchoredScene.id, "elem-remove-1"), /elem-remove-1/);
});

test("reorderElements: reassigns `order` to the given array's index order, observable via listElementsForScene", () => {
  const world = "scene-elements-reorder-world";
  const scene = createScene(world, {}, { makeId: () => "scene-reorder-1" });
  createElement(world, scene.id, { name: "First" }, { makeId: () => "elem-reorder-1" });
  createElement(world, scene.id, { name: "Second" }, { makeId: () => "elem-reorder-2" });
  createElement(world, scene.id, { name: "Third" }, { makeId: () => "elem-reorder-3" });

  const reordered = reorderElements(world, scene.id, ["elem-reorder-3", "elem-reorder-1", "elem-reorder-2"]);
  assert.deepEqual(reordered.map((e) => e.id), ["elem-reorder-3", "elem-reorder-1", "elem-reorder-2"]);

  const reread = listElementsForScene(world, scene.id);
  assert.deepEqual(reread.map((e) => e.id), ["elem-reorder-3", "elem-reorder-1", "elem-reorder-2"], "persists, re-readable in the new order");
});

// ------------------------------------------------- promote / demote (async, real graph writes)

await testAsync("promoteElement: creates a REAL graph node + a REAL containment edge to the scene's anchor place, sets kind:'graph'+graphEntityId", async () => {
  const element = createElement(WORLD, anchoredScene.id, { name: "An ornate mirror" }, { makeId: () => "elem-promote-1" });
  assert.equal(element.kind, "local");

  const before = loadSnapshot(dataDir, WORLD).snapshot;
  const beforeEntityCount = before.entities.length;
  const beforeEdgeCount = before.edges.length;

  const promoted = await promoteElement(dataDir, WORLD, anchoredScene.id, "elem-promote-1");
  assert.equal(promoted.kind, "graph");
  assert.ok(promoted.graphEntityId, "must set a real graphEntityId");

  const after = loadSnapshot(dataDir, WORLD).snapshot;
  assert.equal(after.entities.length, beforeEntityCount + 1, "exactly one new entity created");
  assert.equal(after.edges.length, beforeEdgeCount + 1, "exactly one new edge created");

  const node = after.entities.find((e) => e.id === promoted.graphEntityId);
  assert.ok(node, "the promoted element's new node must be a real entity in the live graph");
  assert.equal(node.name, "An ornate mirror");

  const containmentEdge = after.edges.find(
    (e) => e.sourceId === promoted.graphEntityId && e.targetId === "place-anchor-1" && e.relationshipType === "containment"
  );
  assert.ok(containmentEdge, "a real containment edge must connect the new node to the scene's own anchor place");

  const reread = getElement(WORLD, anchoredScene.id, "elem-promote-1");
  assert.equal(reread.kind, "graph", "the store's own persisted record reflects the promotion");
  assert.equal(reread.graphEntityId, promoted.graphEntityId);
});

await testAsync("promoteElement: re-promoting an already-graph element is a no-op -- does NOT create a second node", async () => {
  const before = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
  const first = await promoteElement(dataDir, WORLD, anchoredScene.id, "elem-promote-1");
  const second = await promoteElement(dataDir, WORLD, anchoredScene.id, "elem-promote-1");
  assert.equal(second.graphEntityId, first.graphEntityId);
  const after = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
  assert.equal(after, before, "no new entity created on the redundant promote");
});

await testAsync("promoteElement: throws a clear error when the scene has no anchor place (locationEntityId null)", async () => {
  createElement(WORLD, floatingScene.id, { name: "Orphaned element" }, { makeId: () => "elem-promote-orphan" });
  await assert.rejects(() => promoteElement(dataDir, WORLD, floatingScene.id, "elem-promote-orphan"), /anchor place/);
});

await testAsync("demoteElement: sets kind:'local', clears graphEntityId -- but NEVER deletes the underlying graph node", async () => {
  createElement(WORLD, anchoredScene.id, { name: "A carved idol" }, { makeId: () => "elem-demote-1" });
  const promoted = await promoteElement(dataDir, WORLD, anchoredScene.id, "elem-demote-1");
  assert.equal(promoted.kind, "graph");
  const graphEntityId = promoted.graphEntityId;

  const beforeEntityCount = loadSnapshot(dataDir, WORLD).snapshot.entities.length;

  const demoted = demoteElement(WORLD, anchoredScene.id, "elem-demote-1");
  assert.equal(demoted.kind, "local");
  assert.equal(demoted.graphEntityId, null);

  const after = loadSnapshot(dataDir, WORLD).snapshot;
  assert.equal(after.entities.length, beforeEntityCount, "demote must not delete or create any entity");
  assert.ok(after.entities.some((e) => e.id === graphEntityId), "the graph node the element was promoted to must STILL exist after demote");

  const reread = getElement(WORLD, anchoredScene.id, "elem-demote-1");
  assert.equal(reread.kind, "local");
  assert.equal(reread.graphEntityId, null);
});

test("demoteElement: throws a clear error for an unknown elementId", () => {
  assert.throws(() => demoteElement(WORLD, anchoredScene.id, "does-not-exist-demote"), /does-not-exist-demote/);
});

test("no write in this file leaked into the repo's real default scene-elements/ directory", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
