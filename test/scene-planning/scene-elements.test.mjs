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
  attachExistingNodeAsElement,
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
  { op: "upsert_entity", data: { id: "place-anchor-1", name: "The Sunken Chapel", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "npc-fromgraph-1", name: "Ashen Warden Cael", type: "person", importance: 0.5 } }
]);

const anchoredScene = createScene(WORLD, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-anchored-1" });
const floatingScene = createScene(WORLD, {}, { makeId: () => "scene-floating-1" }); // no locationEntityId

test("directory isolation: sceneElementsRoot() honors GM_TOOLS_SCENE_ELEMENTS_DIR, never the repo's real default", () => {
  assert.equal(sceneElementsRoot(), process.env.GM_TOOLS_SCENE_ELEMENTS_DIR);
  assert.notEqual(sceneElementsRoot(), REPO_DEFAULT_ROOT);
});

test("SCHEMA_VERSION is exported -- bumped to 2 by Phase 29 task 29.1's additive `stat` field", () => {
  assert.equal(SCHEMA_VERSION, 2);
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

// ------------------------------------------------- stat (Phase 29 task 29.1)

test("createElement: stat defaults to null when omitted, round-trips when provided", () => {
  const noStat = createElement(WORLD, anchoredScene.id, { name: "No stat" }, { makeId: () => "elem-stat-omit" });
  assert.equal(noStat.stat, null);

  const withStat = createElement(
    WORLD,
    anchoredScene.id,
    { name: "A gaunt sexton", stat: { count: 1, ac: "13", hp: "22 (4d8+4)", speed: "30 ft.", cr: "1/2 (100 XP)", raw: "", foundryActor: "" } },
    { makeId: () => "elem-stat-create" }
  );
  assert.deepEqual(withStat.stat, { count: 1, ac: "13", hp: "22 (4d8+4)", speed: "30 ft.", cr: "1/2 (100 XP)", raw: "", foundryActor: "" });

  const reread = getElement(WORLD, anchoredScene.id, "elem-stat-create");
  assert.equal(reread.stat.ac, "13", "must genuinely persist, not just echo the input");
});

test("updateElement: stat shallow-merges onto the existing stat object, creating one from {} if the element had none", () => {
  createElement(WORLD, anchoredScene.id, { name: "Fresh element, no stat yet" }, { makeId: () => "elem-stat-merge-1" });

  const first = updateElement(WORLD, anchoredScene.id, "elem-stat-merge-1", {
    stat: { count: 1, ac: "13", hp: "22 (4d8+4)", speed: "30 ft.", cr: "1/2 (100 XP)", raw: "", foundryActor: "" }
  });
  assert.equal(first.stat.ac, "13");
  assert.equal(first.stat.hp, "22 (4d8+4)");

  // Partial patch touching only `ac` must leave every OTHER stat sub-field untouched.
  const second = updateElement(WORLD, anchoredScene.id, "elem-stat-merge-1", { stat: { ac: "15" } });
  assert.equal(second.stat.ac, "15", "the targeted sub-field is updated");
  assert.equal(second.stat.hp, "22 (4d8+4)", "an UNMENTIONED stat sub-field must survive a partial patch");
  assert.equal(second.stat.speed, "30 ft.", "another unmentioned sub-field must also survive");

  const reread = getElement(WORLD, anchoredScene.id, "elem-stat-merge-1");
  assert.equal(reread.stat.ac, "15", "must genuinely persist the merge, not just echo it");
  assert.equal(reread.stat.hp, "22 (4d8+4)");
});

test("updateElement: a `name`-only patch never touches an element's existing stat", () => {
  createElement(WORLD, anchoredScene.id, { name: "Has a stat", stat: { ac: "10" } }, { makeId: () => "elem-stat-untouched" });
  const updated = updateElement(WORLD, anchoredScene.id, "elem-stat-untouched", { name: "Renamed" });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.stat.ac, "10", "stat must survive a patch that never mentions it");
});

// ------------------------------------------------- attachExistingNodeAsElement (Phase 29 task 29.1, "from-graph")

await testAsync("attachExistingNodeAsElement: creates a kind:'graph' element referencing an EXISTING node id -- creates NO new graph node", async () => {
  const before = loadSnapshot(dataDir, WORLD).snapshot.entities.length;

  const element = attachExistingNodeAsElement(dataDir, WORLD, anchoredScene.id, "npc-fromgraph-1", {}, { makeId: () => "elem-fromgraph-1" });
  assert.equal(element.kind, "graph");
  assert.equal(element.graphEntityId, "npc-fromgraph-1", "must reference the EXISTING node's own id, never a freshly-created one");
  assert.equal(element.name, "Ashen Warden Cael", "name defaults to the entity's own real name from the live snapshot when omitted");
  assert.equal(element.stat, null);

  const after = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
  assert.equal(after, before, "must never duplicate/create a new graph node");

  const reread = getElement(WORLD, anchoredScene.id, "elem-fromgraph-1");
  assert.equal(reread.graphEntityId, "npc-fromgraph-1", "must genuinely persist, not just echo the input");
});

test("attachExistingNodeAsElement: an explicit `name` wins over the entity's own real name", () => {
  // A DIFFERENT scene than the "creates a kind:'graph' element" test above --
  // that test already attached "npc-fromgraph-1" to anchoredScene, and Phase
  // 33 task 33.1's dedupe (same scene + same graphEntityId returns the
  // EXISTING element verbatim) would otherwise make this assertion moot.
  const world = "scene-elements-fromgraph-name-override-world";
  const scene = createScene(world, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-fromgraph-name-override" });
  const element = attachExistingNodeAsElement(
    dataDir,
    world,
    scene.id,
    "npc-fromgraph-1",
    { name: "The Warden (disguised)" },
    { makeId: () => "elem-fromgraph-2" }
  );
  assert.equal(element.name, "The Warden (disguised)");
});

test("attachExistingNodeAsElement: dedupe -- attaching the SAME node to the SAME scene twice returns the SAME element, no duplicate (Phase 33 task 33.1)", () => {
  const world = "scene-elements-fromgraph-dedupe-world";
  const scene = createScene(world, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-fromgraph-dedupe" });

  const first = attachExistingNodeAsElement(
    dataDir,
    world,
    scene.id,
    "npc-fromgraph-1",
    { name: "Ashen Warden Cael" },
    { makeId: () => "elem-fromgraph-dedupe-1" }
  );
  assert.equal(first.id, "elem-fromgraph-dedupe-1");

  const second = attachExistingNodeAsElement(
    dataDir,
    world,
    scene.id,
    "npc-fromgraph-1",
    { name: "Ashen Warden Cael" },
    { makeId: () => "elem-fromgraph-dedupe-2" } // would be used if a NEW element were (wrongly) created
  );
  assert.deepEqual(second, first, "must return the SAME existing element verbatim, not a new one");

  const elements = listElementsForScene(world, scene.id);
  const graphEls = elements.filter((e) => e.kind === "graph" && e.graphEntityId === "npc-fromgraph-1");
  assert.equal(graphEls.length, 1, "exactly one kind:'graph' element for this node, no duplicate");
});

test("attachExistingNodeAsElement: dedupe is scoped PER SCENE -- attaching the same node to a DIFFERENT scene still creates its own element", () => {
  const world = "scene-elements-fromgraph-dedupe-cross-world";
  const sceneA = createScene(world, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-fromgraph-dedupe-a" });
  const sceneB = createScene(world, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-fromgraph-dedupe-b" });

  attachExistingNodeAsElement(dataDir, world, sceneA.id, "npc-fromgraph-1", { name: "X" }, { makeId: () => "elem-dedupe-cross-a" });
  const b = attachExistingNodeAsElement(dataDir, world, sceneB.id, "npc-fromgraph-1", { name: "X" }, { makeId: () => "elem-dedupe-cross-b" });
  assert.equal(b.id, "elem-dedupe-cross-b", "a different scene must NOT be deduped against sceneA's element");
});

test("attachExistingNodeAsElement: appended at max(order)+1, same ordering convention as createElement", () => {
  // Explicit `name` deliberately avoids the live-snapshot name lookup here --
  // this test is about ordering, not the name-default behaviour (already
  // covered above), and this world has no bootstrapped snapshot.
  const world = "scene-elements-fromgraph-order-world";
  const scene = createScene(world, { locationEntityId: "place-anchor-1" }, { makeId: () => "scene-fromgraph-order" });
  createElement(world, scene.id, { name: "First" }, { makeId: () => "elem-fromgraph-order-1" });
  const attached = attachExistingNodeAsElement(
    dataDir,
    world,
    scene.id,
    "npc-fromgraph-1",
    { name: "Explicit name" },
    { makeId: () => "elem-fromgraph-order-2" }
  );
  assert.equal(attached.order, 1);
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
