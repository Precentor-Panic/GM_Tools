import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `session-planner/scene-membership.mjs` (Phase
 * 22 task 22.3). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-22-tasks.md task 22.0. Expected to fail with
 * "Cannot find module" until 22.3 lands.
 *
 * Per plans/phase-21-review.md §4: the default surfaced set stays 1-hop
 * from a scene's anchor (session-planner/corridor.mjs, unchanged). This
 * module is the "add arbitrary node" escape hatch — a scene's EXPLICIT
 * extra-membership list, layered on top of (never replacing) that 1-hop
 * default, plus the reachability-aware intervening-node OFFER.
 *
 * Storage: NEW store, `<sceneMembershipRoot>/<world>.json` — flat array of
 * `{ sceneId: string, entityIds: string[] }`, one entry per scene that has
 * EVER had an explicit add/remove call (a scene with no entry yet has an
 * implicit empty extra-membership set — {sceneId, entityIds:[]}, not an
 * error). Same one-file-per-world flat convention as
 * session-planner/scenes.mjs itself. Default root is GM_Tools/scene-
 * membership/ (sibling to session-scenes/); override with
 * GM_TOOLS_SCENE_MEMBERSHIP_DIR (tests use this for isolation). Deliberately
 * a SEPARATE store from session-planner/scenes.mjs's own Scene record (not
 * a new field bolted onto Scene) — scenes.mjs is not in this task's file
 * list and stays completely unmodified.
 *
 * ---------------------------------------------------------------------------
 * addNodeToScene(world, sceneId, entityId) -> {sceneId, entityIds}
 * ---------------------------------------------------------------------------
 * Idempotent: adding an already-present entityId is a no-op (no duplicate),
 * still returns the current membership. "Trivially easy," per the design
 * record's own framing — no reachability check, no snapshot read at all;
 * an entityId is just recorded. No side effects beyond the add: no other
 * scene's entry, and no OTHER store (session-scenes/, review-state/, the
 * live snapshot) is touched.
 *
 * ---------------------------------------------------------------------------
 * removeNodeFromScene(world, sceneId, entityId) -> {sceneId, entityIds}
 * ---------------------------------------------------------------------------
 * Idempotent: removing an absent entityId is a safe no-op, not an error.
 *
 * ---------------------------------------------------------------------------
 * getSceneMembership(world, sceneId) -> {sceneId, entityIds}
 * ---------------------------------------------------------------------------
 * Pure read. `{sceneId, entityIds: []}` for a scene with no entry yet.
 *
 * ---------------------------------------------------------------------------
 * offerInterveningNodes(entities, edges, sceneAnchorId, targetEntityId)
 * ---------------------------------------------------------------------------
 * PURE function (no store I/O at all) built on
 * session-planner/corridor.mjs's shortestPath — imported, not reimplemented.
 *   @returns {{reachable:boolean, interveningEntityIds:string[]}}
 *   - Unreachable (shortestPath returns null): {reachable:false, interveningEntityIds:[]}
 *     -- the caller's job in this case is to add the target DIRECTLY, no
 *     offer is made or needed.
 *   - Reachable: {reachable:true, interveningEntityIds: <the path's ids,
 *     EXCLUDING both sceneAnchorId and targetEntityId themselves>} -- these
 *     are OFFERED to the caller, NEVER auto-added by this function or by
 *     addNodeToScene. A directly-adjacent target (no nodes strictly
 *     between) is still {reachable:true, interveningEntityIds:[]} (nothing
 *     to offer, but not the same as "unreachable").
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-membership-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SCENE_MEMBERSHIP_DIR = join(scratchDir, "scene-membership");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");

const {
  addNodeToScene,
  removeNodeFromScene,
  getSceneMembership,
  offerInterveningNodes,
  sceneMembershipRoot
} = await import("../../session-planner/scene-membership.mjs");
// Phase 31 task 31.2: addNodeToScene now bumps the target Scene's recency via
// scenes.mjs's touchScene (best-effort, decoupled). These are used to prove
// that recency bump on a scene that genuinely exists in the scenes store.
const { createScene, getScene, touchScene } = await import("../../session-planner/scenes.mjs");

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

const WORLD = "scene-membership-test-world";

test("directory isolation: sceneMembershipRoot() honors GM_TOOLS_SCENE_MEMBERSHIP_DIR", () => {
  assert.equal(sceneMembershipRoot(), process.env.GM_TOOLS_SCENE_MEMBERSHIP_DIR);
});

test("getSceneMembership for a never-touched scene returns an empty list, not an error", () => {
  assert.deepEqual(getSceneMembership(WORLD, "never-touched-scene"), { sceneId: "never-touched-scene", entityIds: [] });
});

test("addNodeToScene: adds an entity id, round-trips via getSceneMembership", () => {
  const result = addNodeToScene(WORLD, "scene-1", "far-away-entity");
  assert.deepEqual(result, { sceneId: "scene-1", entityIds: ["far-away-entity"] });
  assert.deepEqual(getSceneMembership(WORLD, "scene-1"), { sceneId: "scene-1", entityIds: ["far-away-entity"] });
});

test("addNodeToScene: adding the same id twice is idempotent, no duplicate", () => {
  addNodeToScene(WORLD, "scene-dedup", "x");
  const result = addNodeToScene(WORLD, "scene-dedup", "x");
  assert.deepEqual(result.entityIds, ["x"]);
});

test("addNodeToScene: no CROSS-scene leak -- adding to one scene's membership never leaks into a different scene's entry", () => {
  addNodeToScene(WORLD, "scene-other-1", "e1");
  addNodeToScene(WORLD, "scene-other-2", "e2");
  assert.deepEqual(getSceneMembership(WORLD, "scene-other-1").entityIds, ["e1"], "adding to scene-other-2 must not leak into scene-other-1");
});

// Phase 31 task 31.2 (§3.1): the membership store is still authoritative for
// membership, but addNodeToScene now ALSO bumps the target Scene's recency via
// scenes.mjs's touchScene (a fresh drop reads "just now" and sorts to the top
// in the World scene-tray). NOTE this supersedes the pre-Phase-31 invariant
// that this module "never writes into session-scenes/" -- it now does, but only
// the target Scene's own updatedAt, and only when that Scene genuinely exists.
test("addNodeToScene: bumps the target Scene's recency (touchScene) when the scene exists in the scenes store", () => {
  const scene = createScene(WORLD, { name: "Gladiator Pit" });
  // Age the scene so a bump is unambiguous.
  touchScene(WORLD, scene.id, { now: "2000-01-01T00:00:00.000Z" });
  assert.equal(getScene(WORLD, scene.id).updatedAt, "2000-01-01T00:00:00.000Z");

  addNodeToScene(WORLD, scene.id, "alvor");

  const after = getScene(WORLD, scene.id).updatedAt;
  assert.notEqual(after, "2000-01-01T00:00:00.000Z", "addNodeToScene must bump the Scene's updatedAt off its aged value");
  assert.ok(Date.now() - Date.parse(after) < 60000, "the bumped updatedAt must be a fresh (recent) timestamp");
  // Membership itself still persisted correctly.
  assert.deepEqual(getSceneMembership(WORLD, scene.id).entityIds, ["alvor"]);
});

test("addNodeToScene: a scene with NO record in the scenes store still adds the member (recency bump is best-effort, never throws)", () => {
  // "phantom-scene" was never createScene'd -- touchScene would throw, but the
  // membership add must still succeed (the swallow keeps the stores decoupled).
  assert.doesNotThrow(() => addNodeToScene(WORLD, "phantom-scene", "ghost"));
  assert.deepEqual(getSceneMembership(WORLD, "phantom-scene").entityIds, ["ghost"]);
});

test("removeNodeFromScene: removes a present id", () => {
  addNodeToScene(WORLD, "scene-remove", "a");
  addNodeToScene(WORLD, "scene-remove", "b");
  const result = removeNodeFromScene(WORLD, "scene-remove", "a");
  assert.deepEqual(result.entityIds, ["b"]);
});

test("removeNodeFromScene: removing an absent id is a safe no-op, not an error", () => {
  addNodeToScene(WORLD, "scene-remove-noop", "a");
  const result = removeNodeFromScene(WORLD, "scene-remove-noop", "never-was-there");
  assert.deepEqual(result.entityIds, ["a"]);
});

// -------------------------------------------------------- offerInterveningNodes

function pathFixture() {
  // anchor -- mid1 -- mid2 -- target      (a separate branch node hangs off anchor)
  const entities = ["anchor", "mid1", "mid2", "target", "isolated", "adjacent"].map((id) => ({ id, name: id, type: "place" }));
  const edges = [
    { id: "e1", sourceId: "anchor", targetId: "mid1", relationshipType: "unspecified" },
    { id: "e2", sourceId: "mid1", targetId: "mid2", relationshipType: "unspecified" },
    { id: "e3", sourceId: "mid2", targetId: "target", relationshipType: "unspecified" },
    { id: "e4", sourceId: "anchor", targetId: "adjacent", relationshipType: "unspecified" }
  ];
  return { entities, edges };
}

test("offerInterveningNodes: REACHABLE branch -- returns the real intervening ids (via shortestPath), never auto-added", () => {
  const { entities, edges } = pathFixture();
  const offer = offerInterveningNodes(entities, edges, "anchor", "target");
  assert.equal(offer.reachable, true);
  assert.deepEqual(offer.interveningEntityIds, ["mid1", "mid2"]);
});

test("offerInterveningNodes: REACHABLE but directly adjacent -- reachable:true with an empty offer (not confused with unreachable)", () => {
  const { entities, edges } = pathFixture();
  const offer = offerInterveningNodes(entities, edges, "anchor", "adjacent");
  assert.equal(offer.reachable, true);
  assert.deepEqual(offer.interveningEntityIds, []);
});

test("offerInterveningNodes: UNREACHABLE branch -- reachable:false, empty offer, no side effects (pure function, no store touched)", () => {
  const { entities, edges } = pathFixture();
  const offer = offerInterveningNodes(entities, edges, "anchor", "isolated");
  assert.equal(offer.reachable, false);
  assert.deepEqual(offer.interveningEntityIds, []);
});

test("offerInterveningNodes never itself calls addNodeToScene -- confirmed by source read (no import of its own sibling add function)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../session-planner/scene-membership.mjs", import.meta.url), "utf8");
  // offerInterveningNodes must be a pure computation -- it must never call
  // addNodeToScene/removeNodeFromScene itself from within its own body.
  // A simple, conservative structural check: the function body for
  // offerInterveningNodes (isolated by its own declaration) contains no
  // call to addNodeToScene.
  const fnStart = src.indexOf("function offerInterveningNodes");
  assert.ok(fnStart >= 0, "offerInterveningNodes must be declared as a plain function");
  const fnBody = src.slice(fnStart, fnStart + 2000);
  assert.ok(!/addNodeToScene\s*\(/.test(fnBody), "offerInterveningNodes must never auto-add -- it only offers");
});

function require_fs_existsSync(path) {
  // Tiny local helper -- readdirSync throws on a non-existent dir; the
  // store may not have been created yet at the very first call in this file.
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
