import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/scenes.mjs (Phase 16 task 16.2).
 * This module does not exist yet; this file is the interface spec for it,
 * per plans/phase-16-tasks.md task 16.0. It is expected to fail with
 * "Cannot find module" until 16.2 lands.
 *
 * Storage: one JSON file PER WORLD (not per-scene) — `<sessionScenesRoot>/
 * <world>.json`, a flat array of Scene objects. Chosen over a per-scene-file
 * layout (entity-narration.mjs's convention) because this store's real query
 * pattern needs "list every scene for a world" as a first-class operation
 * (listScenesForWorld), the same reasoning mutation-engine/human-review.mjs
 * already documented for its own one-file-per-world choice. Default root is
 * GM_Tools/session-scenes/ (sibling to mutation-engine/, review-state/,
 * entity-narration/); override with GM_TOOLS_SESSION_SCENES_DIR (tests use
 * this for isolation). Reuses review-state.mjs's withLock/ConcurrentWriteError
 * rather than a second file-locking implementation, per
 * entity-narration.mjs's own established precedent -- so GM_TOOLS_REVIEW_STATE_DIR
 * must ALSO be isolated by any test that imports this module (review-state.mjs
 * is imported transitively for withLock even though this store never creates
 * a review-state Batch itself).
 *
 * Explicitly NOT a World Fabric graph entity (design record §2.2): "Scenes
 * are not permanent World Fabric graph entities... a scene only leaves a
 * durable trace in the graph if something created during it ... gets run
 * through intake and accepted." This module must have ZERO import of
 * anything Foundry-facing (no interchange.mjs, no graph-service.mjs, no
 * live-bridge file writes) -- confirmed by this test file's own
 * no-Foundry-import assertion below.
 *
 * Scene shape:
 *   {
 *     id: string,
 *     world: string,
 *     parentSceneId: string|null,     // null for a root (session-opening) scene
 *     locationEntityId: string|null,  // a World Fabric entity id, or null if untethered
 *     objectiveNote: string|null,     // freeform text, informational only -- never
 *                                     // consumed by the traversal engine (design §2.1)
 *     createdAt: string               // ISO timestamp
 *   }
 *
 * ---------------------------------------------------------------------------
 * createScene(world, { locationEntityId, objectiveNote })
 * ---------------------------------------------------------------------------
 * Creates a new ROOT scene: parentSceneId is always null. Both
 * locationEntityId and objectiveNote are optional (default null).
 *   @param {object} [opts]
 *   @param {() => string} [opts.makeId]   scene id generator, injectable for tests
 *   @param {string} [opts.now]            injectable ISO timestamp, for deterministic tests
 *   @returns {object}   the created Scene
 * Signature: createScene(world, { locationEntityId, objectiveNote }, opts = {})
 *
 * ---------------------------------------------------------------------------
 * forkScene(world, parentSceneId, { locationEntityId, objectiveNote })
 * ---------------------------------------------------------------------------
 * Creates a new scene with parentSceneId = the given parent's id (design
 * record §2.2: "the new scene is auto-stamped with metadata about where it
 * came from: parent scene, the location/entity context active at fork time,
 * and any freeform objective note that was active"). Concretely:
 *   - parentSceneId := parentSceneId (must reference an existing scene;
 *     throws a clear error if not found)
 *   - locationEntityId := opts.locationEntityId if explicitly provided
 *     (even if it's a different location than the parent -- the "party goes
 *     off to explore that cave" case), ELSE the PARENT scene's own
 *     locationEntityId (carried forward automatically)
 *   - objectiveNote := opts.objectiveNote if explicitly provided, ELSE the
 *     PARENT scene's own objectiveNote (carried forward automatically)
 *   @param {object} [opts]
 *   @param {() => string} [opts.makeId]
 *   @param {string} [opts.now]
 *   @returns {object}   the created (forked) Scene
 * Signature: forkScene(world, parentSceneId, { locationEntityId, objectiveNote } = {}, opts = {})
 *
 * ---------------------------------------------------------------------------
 * getScene(world, sceneId)
 * ---------------------------------------------------------------------------
 * @returns {object}   the Scene. Throws a clear Error if not found (matches
 *                      review-state.mjs's loadBatch() "throws if not found"
 *                      convention).
 *
 * ---------------------------------------------------------------------------
 * listScenesForWorld(world)
 * ---------------------------------------------------------------------------
 * @returns {object[]}   every scene for `world`, in creation order
 *                        (append order). [] if the world has no scenes yet
 *                        -- not an error.
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

// Isolate BOTH review-state.mjs (scenes.mjs reuses its withLock, per this
// file's own contract comment above) and scenes.mjs's own root BEFORE
// importing either -- same isolation pattern as test/pending-ledger.test.mjs
// and test/entity-narration.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-scenes-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
// Phase 27 task 27.1: deleteScene cascades into plans.mjs -- isolate its own
// store root too, same scratchDir, BEFORE any import. (Phase 28 task 28.1
// removed the scene-links.mjs cascade along with that module.)
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");

// Snapshot the REPO's real default directory BEFORE importing/running
// anything -- not a "must not exist" assertion (the corrected pattern from
// review-ui/test/user-settings.test.mjs / test/user-settings.test.mjs's own
// history: the repo's real default directory legitimately gains content once
// the tool is actually used, so the meaningful guarantee is "this test run
// didn't ADD anything to it," not "it's empty/absent").
const REPO_DEFAULT_ROOT = join(new URL("../../session-scenes", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "session-planner-scenes-test-world";

(async () => {
  const {
    createScene, forkScene, getScene, listScenesForWorld, listScenesByRecency,
    renameScene, updateScene, touchScene, deleteScene, sessionScenesRoot, markScenePushed
  } = await import("../../session-planner/scenes.mjs");
  const { createPlan, getPlan, addSceneToPlan } = await import("../../session-planner/plans.mjs");

  test("directory isolation: sessionScenesRoot() honors GM_TOOLS_SESSION_SCENES_DIR, never the repo's real default", () => {
    assert.equal(sessionScenesRoot(), process.env.GM_TOOLS_SESSION_SCENES_DIR);
    assert.notEqual(sessionScenesRoot(), REPO_DEFAULT_ROOT);
  });

  test("listScenesForWorld: [] for a world with no scenes yet -- not an error", () => {
    assert.deepEqual(listScenesForWorld("a-totally-new-world"), []);
  });

  test("createScene: creates a root scene with parentSceneId null", () => {
    const scene = createScene(WORLD, { locationEntityId: "tavern-1", objectiveNote: "Investigate the missing shipment." }, {
      makeId: () => "scene-root-1",
      now: "2026-07-22T18:00:00.000Z"
    });
    assert.equal(scene.id, "scene-root-1");
    assert.equal(scene.world, WORLD);
    assert.equal(scene.parentSceneId, null);
    assert.equal(scene.locationEntityId, "tavern-1");
    assert.equal(scene.objectiveNote, "Investigate the missing shipment.");
    assert.equal(scene.createdAt, "2026-07-22T18:00:00.000Z");
  });

  test("createScene: locationEntityId/objectiveNote both default to null when omitted", () => {
    const scene = createScene(WORLD, {}, { makeId: () => "scene-root-2", now: "2026-07-22T18:05:00.000Z" });
    assert.equal(scene.locationEntityId, null);
    assert.equal(scene.objectiveNote, null);
  });

  test("getScene: round-trips a created scene by id", () => {
    createScene(WORLD, { locationEntityId: "square-1" }, { makeId: () => "scene-getcheck", now: "2026-07-22T18:10:00.000Z" });
    const reread = getScene(WORLD, "scene-getcheck");
    assert.equal(reread.id, "scene-getcheck");
    assert.equal(reread.locationEntityId, "square-1");
  });

  test("getScene: throws a clear error for an unknown sceneId", () => {
    assert.throws(() => getScene(WORLD, "does-not-exist"), /does-not-exist/);
  });

  test("THE FORK TEST: forkScene carries forward parent-scene/location/objective-note metadata onto the new scene (design record §2.2)", () => {
    const parent = createScene(
      WORLD,
      { locationEntityId: "riverside-camp", objectiveNote: "Find out who's been raiding the caravans." },
      { makeId: () => "scene-parent-fork", now: "2026-07-22T19:00:00.000Z" }
    );

    // The party goes fully off-plan (design record §2.2's motivating example:
    // "go explore that cave") -- fork with NO explicit location/objective
    // override, so both must be carried forward automatically from the parent.
    const child = forkScene(WORLD, parent.id, {}, { makeId: () => "scene-child-fork", now: "2026-07-22T19:30:00.000Z" });

    assert.equal(child.parentSceneId, parent.id, "must record which scene it forked from");
    assert.equal(child.locationEntityId, parent.locationEntityId, "location context carried forward when not overridden");
    assert.equal(child.objectiveNote, parent.objectiveNote, "objective note carried forward when not overridden");
    assert.equal(child.createdAt, "2026-07-22T19:30:00.000Z", "the fork gets its OWN fork-time timestamp, not the parent's");
  });

  test("forkScene: an explicit locationEntityId override wins over the parent's (the 'explore that cave' case), objectiveNote still carries forward", () => {
    const parent = createScene(
      WORLD,
      { locationEntityId: "riverside-camp", objectiveNote: "Find out who's been raiding the caravans." },
      { makeId: () => "scene-parent-override", now: "2026-07-22T20:00:00.000Z" }
    );
    const child = forkScene(WORLD, parent.id, { locationEntityId: "hidden-cave" }, {
      makeId: () => "scene-child-override",
      now: "2026-07-22T20:15:00.000Z"
    });
    assert.equal(child.locationEntityId, "hidden-cave", "explicit override wins");
    assert.equal(child.objectiveNote, parent.objectiveNote, "objectiveNote still carries forward since it was not overridden");
    assert.equal(child.parentSceneId, parent.id);
  });

  test("forkScene: throws a clear error when parentSceneId does not reference an existing scene", () => {
    assert.throws(() => forkScene(WORLD, "no-such-parent", {}), /no-such-parent/);
  });

  test("listScenesForWorld: lists every scene for the world in creation order, root and forked alike", () => {
    const w = "session-planner-scenes-list-test-world";
    const root = createScene(w, { locationEntityId: "start" }, { makeId: () => "list-scene-1", now: "2026-07-22T21:00:00.000Z" });
    const child = forkScene(w, root.id, {}, { makeId: () => "list-scene-2", now: "2026-07-22T21:10:00.000Z" });
    const scenes = listScenesForWorld(w);
    assert.deepEqual(scenes.map((s) => s.id), ["list-scene-1", "list-scene-2"]);
    assert.equal(scenes[1].parentSceneId, root.id);
    void child;
  });

  test("Phase 26 task 26.2: createScene accepts an optional bespoke `name`, defaulting to null when omitted", () => {
    const named = createScene(WORLD, { locationEntityId: "stadium-1", name: "Championship Night" }, {
      makeId: () => "scene-named-1",
      now: "2026-07-22T22:00:00.000Z"
    });
    assert.equal(named.name, "Championship Night");
    const unnamed = createScene(WORLD, { locationEntityId: "stadium-1" }, { makeId: () => "scene-unnamed-1", now: "2026-07-22T22:05:00.000Z" });
    assert.equal(unnamed.name, null);
  });

  test("Phase 26 task 26.2: renameScene persists a new name, and clears it when passed null", () => {
    const scene = createScene(WORLD, { locationEntityId: "stadium-1" }, { makeId: () => "scene-rename-1", now: "2026-07-22T22:10:00.000Z" });
    assert.equal(scene.name, null);

    const renamed = renameScene(WORLD, "scene-rename-1", "The Final Match");
    assert.equal(renamed.name, "The Final Match");
    const reread = getScene(WORLD, "scene-rename-1");
    assert.equal(reread.name, "The Final Match", "must genuinely persist, not just echo the input");

    const cleared = renameScene(WORLD, "scene-rename-1", null);
    assert.equal(cleared.name, null);
  });

  test("Phase 26 task 26.2: renameScene throws a clear error for an unknown sceneId", () => {
    assert.throws(() => renameScene(WORLD, "does-not-exist-rename", "X"), /does-not-exist-rename/);
  });

  // QA W2 fix (Group B #12): a name-length cap, matching manual-edit-ops.mjs's
  // MAX_NAME_LENGTH, applies to every scene name-accepting write.
  test("createScene rejects a name over 200 characters with a clear error, never persists it", () => {
    const tooLong = "x".repeat(201);
    assert.throws(() => createScene(WORLD, { name: tooLong }, { makeId: () => "scene-toolong-1" }), /200 characters/);
    assert.throws(() => getScene(WORLD, "scene-toolong-1"), /No scene found/, "the rejected create must not have persisted a scene");
  });

  test("createScene accepts a name of exactly 200 characters (boundary)", () => {
    const exact = "x".repeat(200);
    const scene = createScene(WORLD, { name: exact }, { makeId: () => "scene-exactly-200" });
    assert.equal(scene.name.length, 200);
  });

  test("renameScene rejects a name over 200 characters, leaving the prior name untouched", () => {
    createScene(WORLD, { locationEntityId: "stadium-1", name: "Original" }, { makeId: () => "scene-rename-toolong" });
    assert.throws(() => renameScene(WORLD, "scene-rename-toolong", "y".repeat(201)), /200 characters/);
    assert.equal(getScene(WORLD, "scene-rename-toolong").name, "Original", "rejected rename must not have persisted");
  });

  test("updateScene rejects a name over 200 characters via its `name` patch key", () => {
    createScene(WORLD, {}, { makeId: () => "scene-update-toolong" });
    assert.throws(() => updateScene(WORLD, "scene-update-toolong", { name: "z".repeat(500) }), /200 characters/);
  });

  test("Phase 26 task 26.2: forkScene does NOT inherit the parent's bespoke name by default (would produce two identically-named scenes)", () => {
    const parent = createScene(WORLD, { locationEntityId: "stadium-1", name: "Opening Ceremony" }, {
      makeId: () => "scene-name-fork-parent",
      now: "2026-07-22T22:20:00.000Z"
    });
    const child = forkScene(WORLD, parent.id, {}, { makeId: () => "scene-name-fork-child", now: "2026-07-22T22:25:00.000Z" });
    assert.equal(child.name, null, "a fork must not silently inherit the parent's bespoke name");
  });

  // ------------------------------------------------- Phase 29 task 29.1

  test("updateScene: patches objectiveNote, leaves name untouched", () => {
    const scene = createScene(WORLD, { locationEntityId: "chapel-1", objectiveNote: "Find the sexton", name: "Opening scene" }, {
      makeId: () => "scene-update-1"
    });
    const updated = updateScene(WORLD, "scene-update-1", { objectiveNote: "Recover the drowned ledger" });
    assert.equal(updated.objectiveNote, "Recover the drowned ledger");
    assert.equal(updated.name, "Opening scene", "name must survive a patch that never mentions it");

    const reread = getScene(WORLD, "scene-update-1");
    assert.equal(reread.objectiveNote, "Recover the drowned ledger", "must genuinely persist, not just echo the input");
  });

  test("updateScene: patches name, leaves objectiveNote untouched (independent, patch-style fields)", () => {
    const scene = createScene(WORLD, { locationEntityId: "chapel-1", objectiveNote: "Find the sexton" }, { makeId: () => "scene-update-2" });
    const updated = updateScene(WORLD, "scene-update-2", { name: "Chapel confrontation" });
    assert.equal(updated.name, "Chapel confrontation");
    assert.equal(updated.objectiveNote, "Find the sexton", "objectiveNote must survive a patch that never mentions it");
    void scene;
  });

  test("updateScene: both fields together update independently in one call", () => {
    createScene(WORLD, { locationEntityId: "chapel-1" }, { makeId: () => "scene-update-3" });
    const updated = updateScene(WORLD, "scene-update-3", { name: "New name", objectiveNote: "New objective" });
    assert.equal(updated.name, "New name");
    assert.equal(updated.objectiveNote, "New objective");
  });

  test("updateScene: throws a clear error for an unknown sceneId", () => {
    assert.throws(() => updateScene(WORLD, "does-not-exist-update-scene", { name: "X" }), /does-not-exist-update-scene/);
  });

  // ------------------------------------------------- Phase 27 task 27.1 (F1)

  test("deleteScene: removes the scene record itself (a true delete, distinct from removeSceneFromPlan)", () => {
    const scene = createScene(WORLD, { locationEntityId: "place-delete-1" }, { makeId: () => "scene-delete-1" });
    assert.ok(getScene(WORLD, "scene-delete-1"), "sanity: scene exists before delete");

    const result = deleteScene(WORLD, "scene-delete-1");
    assert.deepEqual(result, { deleted: true });
    assert.throws(() => getScene(WORLD, "scene-delete-1"), /No scene found/);
    assert.ok(!listScenesForWorld(WORLD).some((s) => s.id === "scene-delete-1"));
  });

  test("deleteScene: cascades -- strips every Plan membership of the deleted scene, leaves other plans'/scenes' memberships untouched", () => {
    const world = "scenes-delete-cascade-plans-world";
    const scene = createScene(world, { locationEntityId: "place-cascade-plan" }, { makeId: () => "scene-cascade-plan-1" });
    const otherScene = createScene(world, { locationEntityId: "place-cascade-plan-2" }, { makeId: () => "scene-cascade-plan-2" });
    const planA = createPlan(world, { name: "Plan A" }, { makeId: () => "plan-cascade-a" });
    const planB = createPlan(world, { name: "Plan B" }, { makeId: () => "plan-cascade-b" });
    addSceneToPlan(world, planA.id, scene.id);
    addSceneToPlan(world, planA.id, otherScene.id);
    addSceneToPlan(world, planB.id, scene.id);

    deleteScene(world, scene.id);

    assert.deepEqual(getPlan(world, planA.id).sceneIds, [otherScene.id], "planA keeps the OTHER scene, loses only the deleted one");
    assert.deepEqual(getPlan(world, planB.id).sceneIds, [], "planB's only membership (the deleted scene) is gone");
  });

  test("deleteScene: idempotent -- deleting an unknown/already-deleted sceneId is a safe no-op, returns {deleted:false}, cascades run harmlessly", () => {
    const result = deleteScene(WORLD, "scene-never-existed-delete");
    assert.deepEqual(result, { deleted: false });

    const scene = createScene(WORLD, {}, { makeId: () => "scene-double-delete" });
    assert.deepEqual(deleteScene(WORLD, scene.id), { deleted: true });
    assert.deepEqual(deleteScene(WORLD, scene.id), { deleted: false }, "a second delete of the same id must not throw");
  });

  // "deleteScene does NOT touch the place entity or any graph edge" (Decision
  // 2) has no separate runtime test here: it's guaranteed structurally, not
  // behaviorally -- this module (and its only cascade collaborator,
  // plans.mjs) import nothing graph/Foundry-facing at all (see the very next
  // test), so there is no code path through which deleteScene COULD reach a
  // place entity or graph edge. Confirmed by reading
  // combat-planning/saved-encounter.mjs's sibling convention of the same
  // reasoning, and re-verified directly against this file's imports.

  // ------------------------------------------------- Phase 30 task 30.1: updatedAt / recency

  test("createScene: stamps updatedAt === createdAt at creation time", () => {
    const scene = createScene(WORLD, { locationEntityId: "place-touch-1" }, { makeId: () => "scene-touch-create-1", now: "2026-08-01T10:00:00.000Z" });
    assert.equal(scene.updatedAt, "2026-08-01T10:00:00.000Z");
    assert.equal(scene.updatedAt, scene.createdAt);
  });

  test("forkScene: the child's updatedAt is its OWN fork-time timestamp (not the parent's)", () => {
    const parent = createScene(WORLD, { locationEntityId: "place-touch-2" }, { makeId: () => "scene-touch-fork-parent", now: "2026-08-01T10:05:00.000Z" });
    const child = forkScene(WORLD, parent.id, {}, { makeId: () => "scene-touch-fork-child", now: "2026-08-01T10:10:00.000Z" });
    assert.equal(child.updatedAt, "2026-08-01T10:10:00.000Z");
    assert.notEqual(child.updatedAt, parent.updatedAt);
  });

  test("updateScene: bumps updatedAt on every patch call, even one that only touches one field", () => {
    const scene = createScene(WORLD, { locationEntityId: "place-touch-3" }, { makeId: () => "scene-touch-update-1", now: "2026-08-01T10:15:00.000Z" });
    assert.equal(scene.updatedAt, "2026-08-01T10:15:00.000Z");
    const updated = updateScene(WORLD, "scene-touch-update-1", { objectiveNote: "New objective" }, { now: "2026-08-01T11:00:00.000Z" });
    assert.equal(updated.updatedAt, "2026-08-01T11:00:00.000Z");
    const reread = getScene(WORLD, "scene-touch-update-1");
    assert.equal(reread.updatedAt, "2026-08-01T11:00:00.000Z", "must genuinely persist");
  });

  test("renameScene: also bumps updatedAt (a scene-record mutation, same as updateScene)", () => {
    const scene = createScene(WORLD, { locationEntityId: "place-touch-4" }, { makeId: () => "scene-touch-rename-1", now: "2026-08-01T10:20:00.000Z" });
    assert.equal(scene.updatedAt, "2026-08-01T10:20:00.000Z");
    const renamed = renameScene(WORLD, "scene-touch-rename-1", "New Name", { now: "2026-08-01T11:30:00.000Z" });
    assert.equal(renamed.updatedAt, "2026-08-01T11:30:00.000Z");
  });

  test("touchScene: bumps ONLY updatedAt, leaves every other field untouched", () => {
    const scene = createScene(WORLD, { locationEntityId: "place-touch-5", objectiveNote: "Original note", name: "Original name" }, {
      makeId: () => "scene-touch-direct-1",
      now: "2026-08-01T10:25:00.000Z"
    });
    const touched = touchScene(WORLD, "scene-touch-direct-1", { now: "2026-08-01T12:00:00.000Z" });
    assert.equal(touched.updatedAt, "2026-08-01T12:00:00.000Z");
    assert.equal(touched.objectiveNote, "Original note");
    assert.equal(touched.name, "Original name");
    assert.equal(touched.locationEntityId, "place-touch-5");
  });

  test("touchScene: throws a clear error for an unknown sceneId (same convention as getScene/updateScene)", () => {
    assert.throws(() => touchScene(WORLD, "does-not-exist-touch"), /does-not-exist-touch/);
  });

  test("listScenesByRecency: orders scenes most-recently-touched first", () => {
    const w = "scenes-recency-test-world";
    createScene(w, { locationEntityId: "r1" }, { makeId: () => "recency-a", now: "2026-08-01T09:00:00.000Z" });
    createScene(w, { locationEntityId: "r2" }, { makeId: () => "recency-b", now: "2026-08-01T09:10:00.000Z" });
    createScene(w, { locationEntityId: "r3" }, { makeId: () => "recency-c", now: "2026-08-01T09:20:00.000Z" });
    // Touch "a" LAST -- it must now sort FIRST, even though it was created first.
    touchScene(w, "recency-a", { now: "2026-08-01T12:00:00.000Z" });

    const byRecency = listScenesByRecency(w);
    assert.deepEqual(byRecency.map((s) => s.id), ["recency-a", "recency-c", "recency-b"]);
    // listScenesForWorld itself stays in creation-append order, unaffected.
    assert.deepEqual(listScenesForWorld(w).map((s) => s.id), ["recency-a", "recency-b", "recency-c"]);
  });

  test("listScenesByRecency: back-compat -- a scene with no updatedAt at all (legacy record) falls back to createdAt and sorts as oldest relative to any touched scene", () => {
    const w = "scenes-recency-legacy-world";
    const legacy = createScene(w, { locationEntityId: "legacy-1" }, { makeId: () => "recency-legacy", now: "2026-01-01T00:00:00.000Z" });
    delete legacy.updatedAt; // simulate a pre-existing scene persisted before this field existed
    // Write the mutated (no-updatedAt) record straight to disk via a fresh create+overwrite is awkward from
    // outside the module -- instead, directly rewrite the world's file to strip updatedAt, matching a real
    // legacy on-disk record exactly (no store API exposes a raw write, so this reaches into the file directly,
    // scoped to the isolated GM_TOOLS_SESSION_SCENES_DIR test root only).
    const filePath = join(process.env.GM_TOOLS_SESSION_SCENES_DIR, `${w}.json`);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    for (const s of raw) delete s.updatedAt;
    writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf8");

    const fresh = createScene(w, { locationEntityId: "fresh-1" }, { makeId: () => "recency-fresh", now: "2026-08-01T00:00:00.000Z" });
    void fresh;
    const byRecency = listScenesByRecency(w);
    assert.deepEqual(byRecency.map((s) => s.id), ["recency-fresh", "recency-legacy"], "the legacy no-updatedAt scene must sort as oldest");
  });

  // ------------------------------------------------- Phase 36 task 36.2, §1/§5

  test("createScene: stagedForFoundry defaults false, lastPushedAt defaults null", () => {
    const scene = createScene(WORLD, { objectiveNote: "Ferry landing" }, { makeId: () => "scene-stage-create-1" });
    assert.equal(scene.stagedForFoundry, false);
    assert.equal(scene.lastPushedAt, null);
  });

  test("forkScene: does NOT inherit the parent's stagedForFoundry/lastPushedAt -- a fork always starts unstaged/never-pushed", () => {
    const parent = createScene(WORLD, {}, { makeId: () => "scene-stage-fork-parent" });
    updateScene(WORLD, "scene-stage-fork-parent", { stagedForFoundry: true });
    markScenePushed(WORLD, "scene-stage-fork-parent", { foundrySceneRef: "Scene.parent123", lastPushedAt: "2026-08-01T00:00:00.000Z" });

    const child = forkScene(WORLD, parent.id, {}, { makeId: () => "scene-stage-fork-child" });
    assert.equal(child.stagedForFoundry, false, "a fork must not silently inherit the parent's live-in-Foundry status");
    assert.equal(child.lastPushedAt, null);
    assert.equal(child.foundrySceneRef, null, "sanity: foundrySceneRef also not inherited (Phase 32's own precedent)");
  });

  test("updateScene: stagedForFoundry joins the patch vocabulary, independent of name/objectiveNote, and still bumps updatedAt (toggling staged-ness IS a touch event)", () => {
    createScene(WORLD, { objectiveNote: "Original" }, { makeId: () => "scene-stage-update-1", now: "2026-08-05T10:00:00.000Z" });
    const staged = updateScene(WORLD, "scene-stage-update-1", { stagedForFoundry: true }, { now: "2026-08-05T11:00:00.000Z" });
    assert.equal(staged.stagedForFoundry, true);
    assert.equal(staged.objectiveNote, "Original", "objectiveNote untouched by a patch that never mentions it");
    assert.equal(staged.updatedAt, "2026-08-05T11:00:00.000Z");

    const unstaged = updateScene(WORLD, "scene-stage-update-1", { stagedForFoundry: false }, { now: "2026-08-05T12:00:00.000Z" });
    assert.equal(unstaged.stagedForFoundry, false);
    assert.equal(unstaged.updatedAt, "2026-08-05T12:00:00.000Z");
  });

  test("markScenePushed: writes ONLY foundrySceneRef/lastPushedAt, leaves updatedAt COMPLETELY untouched (the pinned race-avoidance rule, §5)", () => {
    const scene = createScene(WORLD, { objectiveNote: "Race test" }, { makeId: () => "scene-mark-pushed-1", now: "2026-08-06T09:00:00.000Z" });
    updateScene(WORLD, "scene-mark-pushed-1", { stagedForFoundry: true }, { now: "2026-08-06T09:05:00.000Z" });
    assert.equal(getScene(WORLD, "scene-mark-pushed-1").updatedAt, "2026-08-06T09:05:00.000Z");

    const pushed = markScenePushed(WORLD, "scene-mark-pushed-1", { foundrySceneRef: "Scene.abc123", lastPushedAt: "2026-08-06T09:05:00.000Z" });
    assert.equal(pushed.foundrySceneRef, "Scene.abc123");
    assert.equal(pushed.lastPushedAt, "2026-08-06T09:05:00.000Z");
    assert.equal(pushed.updatedAt, "2026-08-06T09:05:00.000Z", "updatedAt must be EXACTLY what it was before -- markScenePushed never re-stamps it (unlike every other mutator in this module)");

    const reread = getScene(WORLD, "scene-mark-pushed-1");
    assert.equal(reread.foundrySceneRef, "Scene.abc123", "must genuinely persist");
    assert.equal(reread.lastPushedAt, "2026-08-06T09:05:00.000Z");
  });

  test("markScenePushed: THE RACE TEST -- a concurrent edit that lands AFTER compose-time but BEFORE the write-back correctly stays dirty (updatedAt > lastPushedAt), never silently dropped", () => {
    createScene(WORLD, { objectiveNote: "v1" }, { makeId: () => "scene-mark-pushed-race", now: "2026-08-06T10:00:00.000Z" });
    updateScene(WORLD, "scene-mark-pushed-race", { stagedForFoundry: true }, { now: "2026-08-06T10:01:00.000Z" });
    // Flush composes ops for the scene AS OF updatedAt=10:01:00 (the "compose-time snapshot").
    const composeTimeSnapshot = getScene(WORLD, "scene-mark-pushed-race").updatedAt;

    // ...but a genuine edit lands WHILE that push is still in flight (e.g. polling the ops channel).
    updateScene(WORLD, "scene-mark-pushed-race", { objectiveNote: "v2 -- edited mid-flight" }, { now: "2026-08-06T10:01:30.000Z" });

    // The push's result finally comes back -- write-back stamps the COMPOSE-TIME snapshot, not wall-clock now.
    const pushed = markScenePushed(WORLD, "scene-mark-pushed-race", { foundrySceneRef: "Scene.race1", lastPushedAt: composeTimeSnapshot });
    assert.equal(pushed.lastPushedAt, "2026-08-06T10:01:00.000Z");
    assert.equal(pushed.updatedAt, "2026-08-06T10:01:30.000Z", "the mid-flight edit's updatedAt must survive markScenePushed untouched");

    // dirty(scene) = staged && (lastPushedAt===null || updatedAt > lastPushedAt) -- must be TRUE here, or v2 is silently lost forever.
    assert.ok(pushed.updatedAt > pushed.lastPushedAt, "updatedAt must be strictly greater than the stale lastPushedAt -- the scene stays dirty, v2 gets picked up next flush");
  });

  test("markScenePushed: foundrySceneRef is independently optional -- a call with only lastPushedAt leaves an already-set ref untouched", () => {
    createScene(WORLD, {}, { makeId: () => "scene-mark-pushed-refonly" });
    markScenePushed(WORLD, "scene-mark-pushed-refonly", { foundrySceneRef: "Scene.first", lastPushedAt: "2026-08-06T00:00:00.000Z" });
    const second = markScenePushed(WORLD, "scene-mark-pushed-refonly", { lastPushedAt: "2026-08-06T01:00:00.000Z" });
    assert.equal(second.foundrySceneRef, "Scene.first", "an update-path push (no NEW foundryUuid) must not clobber the existing ref");
    assert.equal(second.lastPushedAt, "2026-08-06T01:00:00.000Z");
  });

  test("markScenePushed: throws a clear error for an unknown sceneId, same convention as every other mutator", () => {
    assert.throws(() => markScenePushed(WORLD, "does-not-exist-mark-pushed", { lastPushedAt: null }), /does-not-exist-mark-pushed/);
  });

  test("no Foundry-facing import anywhere in scenes.mjs -- a scene is explicitly NOT a World Fabric graph entity (design record §2.2)", async () => {
    const src = (await import("node:fs")).readFileSync(
      new URL("../../session-planner/scenes.mjs", import.meta.url),
      "utf8"
    );
    assert.ok(!/foundry_worldFabric/.test(src), "must never import anything from the foundry_worldFabric module");
    assert.ok(!/graph-service/i.test(src), "must never import GraphService");
  });

  // -------------------------------------------------------------------------
  // Friction Wave 1 W3b -- `mapAssetId` (the scene<->map link).
  // -------------------------------------------------------------------------

  test("W3b mapAssetId: defaults null on create; an explicit value round-trips; updateScene sets and clears it", () => {
    const bare = createScene(WORLD, {}, { makeId: () => "scene-w3b-1" });
    assert.equal(bare.mapAssetId, null);

    const withMap = createScene(WORLD, { mapAssetId: "sc-map-1" }, { makeId: () => "scene-w3b-2" });
    assert.equal(withMap.mapAssetId, "sc-map-1");

    const linked = updateScene(WORLD, "scene-w3b-1", { mapAssetId: "sc-map-2" });
    assert.equal(linked.mapAssetId, "sc-map-2");
    assert.equal(getScene(WORLD, "scene-w3b-1").mapAssetId, "sc-map-2", "persisted");

    // A patch that DOESN'T mention mapAssetId leaves it untouched...
    const untouched = updateScene(WORLD, "scene-w3b-1", { objectiveNote: "unrelated edit" });
    assert.equal(untouched.mapAssetId, "sc-map-2");
    // ...and an explicit null clears it.
    const cleared = updateScene(WORLD, "scene-w3b-1", { mapAssetId: null });
    assert.equal(cleared.mapAssetId, null);
  });

  test("W3b forkScene: INHERITS mapAssetId like locationEntityId (same place, same map) unless overridden -- unlike foundrySceneRef/stagedForFoundry", () => {
    const parent = createScene(WORLD, { locationEntityId: "bridge-1", mapAssetId: "sc-map-bridge" }, { makeId: () => "scene-w3b-parent" });
    markScenePushed(WORLD, parent.id, { foundrySceneRef: "Scene.pushed", lastPushedAt: "2026-08-14T00:00:00.000Z" });

    const fork = forkScene(WORLD, parent.id, {}, { makeId: () => "scene-w3b-fork" });
    assert.equal(fork.mapAssetId, "sc-map-bridge", "inherited");
    assert.equal(fork.foundrySceneRef, null, "push-instance state still NOT inherited");

    const overridden = forkScene(WORLD, parent.id, { mapAssetId: null }, { makeId: () => "scene-w3b-fork2" });
    assert.equal(overridden.mapAssetId, null, "an explicit override (even null) wins");
  });

  test("W3b back-compat: a pre-W3b record on disk (no mapAssetId key -- every kilmarn scene's shape) loads, reads as no-map, and patches cleanly", () => {
    const scene = createScene(WORLD, { objectiveNote: "MAP: worlds/kilmarn/maps/old-workaround.webp" }, { makeId: () => "scene-w3b-legacy" });
    const filePath = join(sessionScenesRoot(), `${WORLD}.json`);
    const rows = JSON.parse(readFileSync(filePath, "utf8"));
    for (const r of rows) if (r.id === scene.id) delete r.mapAssetId;
    writeFileSync(filePath, JSON.stringify(rows, null, 2), "utf8");

    const reread = getScene(WORLD, scene.id);
    assert.equal(reread.mapAssetId ?? null, null);
    assert.equal(reread.objectiveNote, "MAP: worlds/kilmarn/maps/old-workaround.webp", "the old workaround line is untouched");

    const patched = updateScene(WORLD, scene.id, { mapAssetId: "sc-map-9" });
    assert.equal(patched.mapAssetId, "sc-map-9");

    // And a fork OF a legacy parent normalizes the missing key to null.
    const fork = forkScene(WORLD, "scene-w3b-legacy", { mapAssetId: null }, { makeId: () => "scene-w3b-legacy-fork" });
    assert.equal(fork.mapAssetId, null);
  });

  test("no write in this file leaked into the repo's real default session-scenes/ directory (the established before/after-diff isolation pattern)", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
