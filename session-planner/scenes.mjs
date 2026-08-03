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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

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
    createdAt: now
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
    createdAt: now
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
 * @param {string} world
 * @param {string} sceneId
 * @param {string|null} name
 * @returns {object}   the updated Scene
 */
export function renameScene(world, sceneId, name) {
  const scenes = readScenes(world);
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw new Error(`No scene found: world="${world}" sceneId="${sceneId}"`);
  }
  scene.name = name ?? null;
  writeScenes(world, scenes);
  return scene;
}

/** @returns {object[]}   every scene for `world`, in creation (append) order. [] if none. */
export function listScenesForWorld(world) {
  return readScenes(world);
}

export { ConcurrentWriteError };
