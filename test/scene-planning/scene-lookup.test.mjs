import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 30 task 30.1 — session-planner/scene-lookup.mjs's scenesForEntity:
 * the World inspector's "appears in" reverse lookup. A scene "appears" for
 * an entityId if ANY of: it's the scene's own anchor (locationEntityId),
 * it's in the scene's explicit membership list (scene-membership.mjs), or a
 * kind:'graph' element of the scene references it (graphEntityId). A single
 * scene can carry more than one role at once. Isolates every store this
 * module transitively touches, same pattern as
 * test/scene-planning/scene-elements.test.mjs (its own promote/from-graph
 * calls pull in manual-edit-ops.mjs's dependencies too).
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
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-lookup-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_MEMBERSHIP_DIR = join(scratchDir, "scene-membership");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "scene-lookup-test-world";

const { scenesForEntity } = await import("../../session-planner/scene-lookup.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { addNodeToScene } = await import("../../session-planner/scene-membership.mjs");
const { attachExistingNodeAsElement, createElement } = await import("../../session-planner/scene-elements.mjs");
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "place-anchor-a", name: "Anchor Place A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "place-anchor-b", name: "Anchor Place B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "npc-member", name: "Member NPC", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "npc-element", name: "Element NPC", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "npc-untouched", name: "Untouched NPC", type: "person", importance: 0.4 } }
]);

test("scenesForEntity: [] for an entity that appears in no scene at all", () => {
  assert.deepEqual(scenesForEntity(WORLD, "npc-untouched"), []);
});

test("scenesForEntity: [] for a world with no scenes at all", () => {
  assert.deepEqual(scenesForEntity("scene-lookup-empty-world", "anything"), []);
});

test("scenesForEntity: role 'anchor' -- a scene whose locationEntityId is the entity", () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-a" }, { makeId: () => "lookup-anchor-scene" });
  const appearances = scenesForEntity(WORLD, "place-anchor-a");
  assert.equal(appearances.length, 1);
  assert.equal(appearances[0].scene.id, scene.id);
  assert.deepEqual(appearances[0].roles, ["anchor"]);
});

test("scenesForEntity: role 'member' -- explicit scene membership (scene-membership.mjs), independent of anchor", () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-b" }, { makeId: () => "lookup-member-scene" });
  addNodeToScene(WORLD, scene.id, "npc-member");
  const appearances = scenesForEntity(WORLD, "npc-member");
  assert.equal(appearances.length, 1);
  assert.equal(appearances[0].scene.id, scene.id);
  assert.deepEqual(appearances[0].roles, ["member"]);
});

test("scenesForEntity: role 'element' -- a kind:'graph' element referencing the entity via graphEntityId", () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-a" }, { makeId: () => "lookup-element-scene" });
  attachExistingNodeAsElement(dataDir, WORLD, scene.id, "npc-element", { name: "Element NPC" });
  const appearances = scenesForEntity(WORLD, "npc-element");
  assert.equal(appearances.length, 1);
  assert.equal(appearances[0].scene.id, scene.id);
  assert.deepEqual(appearances[0].roles, ["element"]);
});

test("scenesForEntity: a kind:'local' element does NOT count as an 'element' role (graphEntityId is null)", () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-a" }, { makeId: () => "lookup-local-only-scene" });
  // A local element with the same NAME as a real entity must not accidentally match -- only graphEntityId counts.
  createElement(WORLD, scene.id, { name: "npc-untouched", kind: "local" });
  assert.deepEqual(scenesForEntity(WORLD, "npc-untouched"), []);
});

test("MULTI-ROLE: a single scene can carry more than one role for the same entity at once", () => {
  const world = "scene-lookup-multirole-world";
  const scene = createScene(world, { locationEntityId: "place-anchor-a" }, { makeId: () => "lookup-multirole-scene" });
  // "place-anchor-a" is already this scene's own anchor (role: anchor).
  // Also explicitly add it as membership (an unusual but legal combination).
  addNodeToScene(world, scene.id, "place-anchor-a");
  const appearances = scenesForEntity(world, "place-anchor-a");
  assert.equal(appearances.length, 1, "still ONE appearance entry for this scene, not two");
  assert.deepEqual(appearances[0].roles.sort(), ["anchor", "member"]);
});

test("scenesForEntity: an entity appearing in MULTIPLE scenes returns one entry per scene, in listScenesForWorld's stable append order", () => {
  const world = "scene-lookup-multiscene-world";
  const sceneA = createScene(world, { locationEntityId: "place-anchor-a" }, { makeId: () => "lookup-multiscene-a" });
  const sceneB = createScene(world, {}, { makeId: () => "lookup-multiscene-b" });
  addNodeToScene(world, sceneB.id, "place-anchor-a");
  const appearances = scenesForEntity(world, "place-anchor-a");
  assert.deepEqual(appearances.map((a) => a.scene.id), [sceneA.id, sceneB.id]);
  assert.deepEqual(appearances[0].roles, ["anchor"]);
  assert.deepEqual(appearances[1].roles, ["member"]);
});

test("scenesForEntity: a scene with NO relationship to the entity is simply absent from the result, not included with an empty roles array", () => {
  const world = "scene-lookup-unrelated-world";
  createScene(world, { locationEntityId: "place-anchor-b" }, { makeId: () => "lookup-unrelated-scene" });
  assert.deepEqual(scenesForEntity(world, "place-anchor-a"), []);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
