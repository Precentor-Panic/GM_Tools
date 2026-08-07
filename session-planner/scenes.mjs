/**
 * Scene state store — pure, Foundry-free, unit-testable.
 *
 * Phase 16 task 16.2. Design record §2.2: session structure is a chain (and
 * tree, via forking) of lightweight, session-scoped scenes — NOT a permanent
 * World Fabric graph entity. A scene only leaves a durable trace in the
 * graph if something created during it (a note, a new node) gets run
 * through intake and accepted (session-planner/session-notes.mjs, task
 * 16.4). This module has ZERO import of anything Foundry-facing.
 *
 * Storage: ONE JSON file PER WORLD (not per-scene) —
 * `<sessionScenesRoot>/<world>.json`, a flat array of Scene objects. Chosen
 * over a per-scene-file layout because this store's real query pattern needs
 * "list every scene for a world" as a first-class operation
 * (listScenesForWorld) — the same reasoning mutation-engine/human-review.mjs
 * already documented for its own one-file-per-world choice. Default root is
 * GM_Tools/session-scenes/ (sibling to mutation-engine/, review-state/,
 * entity-narration/); override with GM_TOOLS_SESSION_SCENES_DIR (tests use
 * this for isolation). Reuses review-state.mjs's withLock/ConcurrentWriteError
 * rather than a second file-locking implementation, per entity-narration.mjs's
 * own established precedent.
 *
 * ADDITIVE CHANGE (Phase 30 task 30.1): the Scene record gained an
 * `updatedAt` field (ISO timestamp, set = `createdAt` on create/fork,
 * stamped on every scene-record mutation -- updateScene/renameScene/
 * forkScene's own child -- plus the new touchScene() escape hatch for
 * callers that change a scene's CONTENT rather than its own record, e.g. a
 * scene-element/narration write, so the World scene-tray's "most recently
 * touched first" ordering reflects that too). This store has no
 * `SCHEMA_VERSION` constant (a plain, unversioned flat-object store, unlike
 * scene-elements.mjs) so there is nothing to bump -- the change is purely
 * additive and back-compat: a scene persisted before this change simply has
 * no `updatedAt` key, which `listScenesByRecency`'s own fallback (treat a
 * missing `updatedAt` as that scene's own `createdAt`, or the epoch if even
 * that's missing) sorts as oldest, exactly as if it had never been touched.
 *
 * ADDITIVE CHANGE (Phase 32 task 32.3): the Scene record gained a
 * `foundrySceneRef` field (string|null, default null on create/fork --
 * deliberately NOT inherited by forkScene, same reasoning as `name` just
 * below it: a fork is a different actual scene instance, so it must not
 * silently point at the parent's already-pushed Foundry Scene document).
 * Written by wf-mcp-server/lib/foundry-push-ops.mjs's pushSceneToFoundry
 * (via updateScene's new optional `foundrySceneRef` patch key) once a
 * `create_scene` ops-channel push comes back `ok:true` with a real
 * `foundryUuid` -- plans/phase-32-bridge-contract.md §3. Same no-
 * `SCHEMA_VERSION`-bump reasoning as `updatedAt` above: a scene persisted
 * before this change simply has no `foundrySceneRef` key, which every
 * reader must treat identically to an explicit `null` (never pushed yet).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { listPlansForWorld, removeSceneFromPlan } from "./plans.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "session-scenes");

export function sessionScenesRoot() {
  return process.env.GM_TOOLS_SESSION_SCENES_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(sessionScenesRoot(), `${world}.json`);
}

function readScenes(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeScenes(world, scenes) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(scenes, null, 2), "utf8");
  });
  return scenes;
}

/** Generate a scene id. Injectable (opts.makeId) for deterministic tests, same pattern as review-state.mjs's makeBatchId. */
export function makeSceneId() {
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates a new ROOT scene: parentSceneId is always null.
 *
 * @param {string} world
 * @param {{locationEntityId?:string|null, objectiveNote?:string|null}} [fields]
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created Scene
 */
export function createScene(world, { locationEntityId = null, objectiveNote = null, name = null } = {}, opts = {}) {
  const makeId = opts.makeId ?? makeSceneId;
  const now = opts.now ?? new Date().toISOString();
  const scene = {
    id: makeId(),
    world,
    parentSceneId: null,
    locationEntityId: locationEntityId ?? null,
    objectiveNote: objectiveNote ?? null,
    name: name ?? null,
    foundrySceneRef: null,
    createdAt: now,
    updatedAt: now
  };
  const scenes = readScenes(world);
  writeScenes(world, [...scenes, scene]);
  return scene;
}

/**
 * Creates a new scene forked from `parentSceneId` (design record §2.2): the
 * new scene is auto-stamped with parentSceneId, and carries forward the
 * parent's own locationEntityId/objectiveNote UNLESS an explicit override is
 * given (the "party goes off to explore that cave" case).
 *
 * @param {string} world
 * @param {string} parentSceneId
 * @param {{locationEntityId?:string|null, objectiveNote?:string|null}} [fields]
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created (forked) Scene
 */
export function forkScene(world, parentSceneId, { locationEntityId, objectiveNote, name = null } = {}, opts = {}) {
  const parent = getScene(world, parentSceneId);
  const makeId = opts.makeId ?? makeSceneId;
  const now = opts.now ?? new Date().toISOString();
  const scene = {
    id: makeId(),
    world,
    parentSceneId: parent.id,
    locationEntityId: locationEntityId !== undefined ? locationEntityId : parent.locationEntityId,
    objectiveNote: objectiveNote !== undefined ? objectiveNote : parent.objectiveNote,
    // Deliberately NOT inherited from the parent by default (unlike
    // location/objective) -- a bespoke name identifies ONE specific scene
    // instance; silently copying it onto a fork would produce two
    // identically-named scenes with no way to tell them apart in a list.
    // Pass an explicit `name` to set one anyway.
    name,
    // Deliberately NOT inherited from the parent either, same reasoning as
    // `name` immediately above -- see this module's own Phase 32 task 32.3
    // header note.
    foundrySceneRef: null,
    createdAt: now,
    updatedAt: now
  };
  const scenes = readScenes(world);
  writeScenes(world, [...scenes, scene]);
  return scene;
}

/** @returns {object}   the Scene. Throws a clear Error if not found. */
export function getScene(world, sceneId) {
  const scene = readScenes(world).find((s) => s.id === sceneId);
  if (!scene) {
    throw new Error(`No scene found: world="${world}" sceneId="${sceneId}"`);
  }
  return scene;
}

/**
 * Phase 26 task 26.2: set (or clear, with `name: null`) a scene's own
 * bespoke display name -- what makes two scenes at the same anchor
 * (e.g. two scenes both at "Grand Stadium") distinguishable in a list.
 * Throws the same clear "No scene found" error as getScene for an unknown
 * sceneId.
 *
 * Phase 30 task 30.1: also stamps `updatedAt` (this is a scene-record
 * mutation, same as updateScene below).
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {string|null} name
 * @param {object} [opts]
 * @param {string} [opts.now]   injectable ISO timestamp, for deterministic tests
 * @returns {object}   the updated Scene
 */
export function renameScene(world, sceneId, name, opts = {}) {
  const scenes = readScenes(world);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw new Error(`No scene found: world="${world}" sceneId="${sceneId}"`);
  }
  scene.name = name ?? null;
  scene.updatedAt = opts.now ?? new Date().toISOString();
  writeScenes(world, scenes);
  return scene;
}

/**
 * Phase 29 task 29.1: patch-update `name` and/or `objectiveNote` on an
 * existing scene -- independent optional fields (passing only one leaves
 * the other untouched, matching `updateElement`'s own "only patch what's
 * provided" convention). NOT a rename of `renameScene` above (that stays
 * exactly as-is, name-only, still used by whatever currently calls it) --
 * this is the new backing store op for the scene page's inline objective
 * edit (and a general-purpose name patch alongside it). Throws the same
 * clear "No scene found" error as getScene/renameScene for an unknown
 * sceneId.
 *
 * Phase 30 task 30.1: also stamps `updatedAt`, unconditionally -- a patch
 * call is itself the "this scene was touched" event, even one that happens
 * to leave both fields' VALUES unchanged (matches touchScene's own
 * unconditional-bump semantics below).
 *
 * Phase 32 task 32.3: gained an independent optional `foundrySceneRef` patch
 * key (same "only patch what's provided" convention as name/objectiveNote)
 * -- the write-back point wf-mcp-server/lib/foundry-push-ops.mjs's
 * pushSceneToFoundry uses once a create_scene push comes back `ok:true`
 * with a real Foundry UUID, per this task's own instruction to write it "via
 * updateScene" rather than adding a second, parallel setter.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {{name?:string|null, objectiveNote?:string|null, foundrySceneRef?:string|null}} patch
 * @param {object} [opts]
 * @param {string} [opts.now]   injectable ISO timestamp, for deterministic tests
 * @returns {object}   the updated Scene
 */
export function updateScene(world, sceneId, { name, objectiveNote, foundrySceneRef } = {}, opts = {}) {
  const scenes = readScenes(world);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw new Error(`No scene found: world="${world}" sceneId="${sceneId}"`);
  }
  if (name !== undefined) scene.name = name;
  if (objectiveNote !== undefined) scene.objectiveNote = objectiveNote;
  if (foundrySceneRef !== undefined) scene.foundrySceneRef = foundrySceneRef;
  scene.updatedAt = opts.now ?? new Date().toISOString();
  writeScenes(world, scenes);
  return scene;
}

/**
 * Phase 30 task 30.1: bumps ONLY `updatedAt`, for callers that change a
 * scene's CONTENT (an element, its narration) rather than the Scene record's
 * own fields -- the "most recently touched" signal the World scene-tray
 * needs. Throws the same clear "No scene found" error as getScene for an
 * unknown sceneId.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {object} [opts]
 * @param {string} [opts.now]   injectable ISO timestamp, for deterministic tests
 * @returns {object}   the updated Scene
 */
export function touchScene(world, sceneId, opts = {}) {
  const scenes = readScenes(world);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw new Error(`No scene found: world="${world}" sceneId="${sceneId}"`);
  }
  scene.updatedAt = opts.now ?? new Date().toISOString();
  writeScenes(world, scenes);
  return scene;
}

/** @returns {object[]}   every scene for `world`, in creation (append) order. [] if none. */
export function listScenesForWorld(world) {
  return readScenes(world);
}

/**
 * Phase 30 task 30.1: every scene for `world`, sorted by `updatedAt` DESC
 * (most-recently-touched first) -- the World scene-tray's own required
 * ordering. A scene with no `updatedAt` at all (persisted before this field
 * existed) falls back to its own `createdAt`, and only if even THAT is
 * somehow missing falls back to the epoch -- so a never-touched legacy scene
 * always sorts as the oldest, never crashes, and never ties every legacy
 * scene together at the same instant when they in fact have distinct
 * creation times.
 *
 * @param {string} world
 * @returns {object[]}
 */
export function listScenesByRecency(world) {
  const key = (scene) => scene.updatedAt ?? scene.createdAt ?? "1970-01-01T00:00:00.000Z";
  return [...readScenes(world)].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return 0;
    return ka < kb ? 1 : -1; // descending -- most recent first
  });
}

/**
 * Phase 27 task 27.1, F1: a TRUE delete (Scenes tab), distinct from
 * `removeSceneFromPlan` (a plan-scoped unlink). Removes the scene record
 * itself, then cascades:
 *   - every Plan membership (`listPlansForWorld` x `removeSceneFromPlan`,
 *     session-planner/plans.mjs -- each plan that lists this sceneId gets it
 *     stripped; plans that never had it are untouched, and other plans'
 *     memberships of OTHER scenes are untouched).
 * Phase 28 task 28.1: the scene-link cascade (session-planner/scene-links.mjs)
 * was removed along with that module -- scene-to-scene linking is scrapped
 * in favor of the Plan-scoped "shared by reference" model (design record).
 * Deliberately does NOT touch the place (World Fabric) entity or any graph
 * edge (Decision 2, design record) -- this module has zero Foundry-facing
 * import (see this file's own header comment / scenes.test.mjs's assertion),
 * and plans.mjs doesn't touch the graph either, so the place entity is
 * untouched by construction, not by a special-cased skip.
 *
 * Idempotent: deleting an already-absent/unknown sceneId is a safe no-op on
 * the scene record itself (matches this directory's removeSavedEncounter
 * convention) -- the cascade runs regardless but is itself an idempotent
 * no-op when there's nothing to strip, so a repeat call (or a call for a
 * sceneId that was never a real scene) is harmless.
 *
 * @param {string} world
 * @param {string} sceneId
 * @returns {{deleted:boolean}}   `deleted` is true only if a scene record
 *   with this id actually existed and was removed.
 */
export function deleteScene(world, sceneId) {
  const scenes = readScenes(world);
  const next = scenes.filter((s) => s.id !== sceneId);
  const deleted = next.length !== scenes.length;
  if (deleted) writeScenes(world, next);

  for (const plan of listPlansForWorld(world)) {
    if (plan.sceneIds.includes(sceneId)) {
      removeSceneFromPlan(world, plan.id, sceneId);
    }
  }

  return { deleted };
}

export { ConcurrentWriteError };
