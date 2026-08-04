/**
 * Scene element store — pure, Foundry-free (except promote's own deliberate
 * graph write), unit-testable.
 *
 * Phase 28 task 28.1. Design record's "the reframe": a scene = one place +
 * an ordered list of interactable elements. Most elements are scene-local
 * ("MUNDANE", `kind:'local'`) and never touch the World Fabric graph at all
 * — only when a GM explicitly promotes one ("KEY", `kind:'graph'`) does it
 * become a real graph node, contained in the scene's own anchor place.
 * "New elements default to MUNDANE/scene-local... never classify importance
 * at creation" (plans/phase-28-tasks.md's own settled decision) — `kind`
 * defaults to `"local"` whenever omitted on create.
 *
 * Storage: ONE JSON file PER WORLD — `<sceneElementsRoot>/<world>.json`, a
 * flat array of SceneElement objects, ordered per-scene via each element's
 * own `order` field (NOT array position — matching plans.mjs/scenes.mjs's
 * own one-file-per-world flat convention exactly, but ordering is scoped per
 * `sceneId`, not global to the file). Default root is GM_Tools/scene-elements/
 * (sibling to session-scenes/, session-plans/); override with
 * GM_TOOLS_SCENE_ELEMENTS_DIR (tests use this for isolation — the exact env
 * var name is pinned by review-ui/test/e2e/phase28-fixture.mjs's own
 * setupPhase28Env). Reuses review-state.mjs's withLock/ConcurrentWriteError
 * rather than a second file-locking implementation, per this directory's own
 * established precedent.
 *
 * PROMOTE/DEMOTE (plans/phase-28-tasks.md 28.1's own spec): promoteElement is
 * the one function in this module that touches the live graph — it is a
 * DIRECT manual graph edit (same surface/no-review-gate as the existing
 * `POST /api/graph/nodes` route, wf-mcp-server/lib/manual-edit-ops.mjs's
 * addNodeOp/addEdgeOp), not a review-gated mutation. The no-silent-auto-write
 * invariant applies to the Wrap note-intake proposal path (importWriteup/
 * review-state), never to this deliberate, GM-initiated manual promote — the
 * exact same reasoning transit-entity.mjs's own header comment already
 * documents for its own addNodeOp reuse. demoteElement NEVER deletes the
 * graph node it created — only this store's own `kind`/`graphEntityId`
 * bookkeeping changes; the node itself is left for a separate, explicit,
 * guarded delete (the "beyond this room" drawer's own delete-node flow) to
 * ever remove.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { getScene } from "./scenes.mjs";
import { addNodeOp, addEdgeOp } from "../wf-mcp-server/lib/manual-edit-ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-elements");

export const SCHEMA_VERSION = 1;

export const SceneElementKind = z.enum(["local", "graph"]);

// `checks` entries — one skill check an element might call for, verbatim
// shape from plans/phase-28-tasks.md 28.1: `[{skill, dc, purpose?}]`.
const ElementCheck = z.object({
  skill: z.string().min(1),
  dc: z.number(),
  purpose: z.string().optional()
}).strict();

// Verbatim field-name set from plans/phase-28-tasks.md 28.1 / the
// phase28-fixture.mjs contract (§4/§11): trigger/gives are the ALWAYS-CORE
// fields (rendered by the frontend even when absent); every other field is
// optional and show-only-if-filled. This module doesn't distinguish
// core-vs-optional itself (that's a frontend rendering concern) — it just
// stores whatever subset of this fixed vocabulary the caller supplies.
export const SceneElementFields = z.object({
  trigger: z.string().optional(),
  gives: z.string().optional(),
  looks: z.string().optional(),
  means: z.string().optional(),
  checks: z.array(ElementCheck).optional(),
  function: z.string().optional(),
  wants: z.string().optional(),
  secret: z.string().optional(),
  statblockRef: z.string().optional()
}).strict();

export const SceneElement = z.object({
  id: z.string(),
  sceneId: z.string(),
  world: z.string(),
  kind: SceneElementKind,
  graphEntityId: z.string().nullable().optional(),
  name: z.string(),
  fields: SceneElementFields,
  order: z.number(),
  createdAt: z.string()
}).strict();

export function sceneElementsRoot() {
  return process.env.GM_TOOLS_SCENE_ELEMENTS_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(sceneElementsRoot(), `${world}.json`);
}

function readElements(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeElements(world, elements) {
  const validated = elements.map((e) => SceneElement.parse(e));
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/** Generate a scene-element id. Injectable (opts.makeId) for deterministic tests, same pattern as scenes.mjs's makeSceneId. */
export function makeElementId() {
  return `elem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} world
 * @param {string} sceneId
 * @param {{name:string, kind?:'local'|'graph', fields?:object}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created element, appended at max(order for this scene)+1 (0 if the scene has none yet)
 */
export function createElement(world, sceneId, { name, kind, fields } = {}, opts = {}) {
  const makeId = opts.makeId ?? makeElementId;
  const now = opts.now ?? new Date().toISOString();
  const elements = readElements(world);
  const sceneElements = elements.filter((e) => e.sceneId === sceneId);
  const nextOrder = sceneElements.length ? Math.max(...sceneElements.map((e) => e.order)) + 1 : 0;

  const element = {
    id: makeId(),
    sceneId,
    world,
    kind: kind ?? "local",
    graphEntityId: null,
    name: name ?? "",
    fields: fields ?? {},
    order: nextOrder,
    createdAt: now
  };
  writeElements(world, [...elements, element]);
  return element;
}

/** @returns {object[]}   every element for this scene, in `order`. [] if none. */
export function listElementsForScene(world, sceneId) {
  return readElements(world)
    .filter((e) => e.sceneId === sceneId)
    .sort((a, b) => a.order - b.order);
}

function findElementOrThrow(elements, sceneId, elementId) {
  const element = elements.find((e) => e.sceneId === sceneId && e.id === elementId);
  if (!element) {
    throw new Error(`No scene element found: sceneId="${sceneId}" elementId="${elementId}"`);
  }
  return element;
}

/** @returns {object}   the element. Throws a clear Error if not found. */
export function getElement(world, sceneId, elementId) {
  return findElementOrThrow(readElements(world), sceneId, elementId);
}

/**
 * Patch-merge update: `name` (if provided) replaces outright; `fields` (if
 * provided) shallow-merges onto the element's existing fields object
 * (setting a key to `undefined` leaves it untouched — pass an explicit value
 * to change one, there is no "clear a field" shorthand here).
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {string} elementId
 * @param {{name?:string, fields?:object}} patch
 * @returns {object}   the updated element
 */
export function updateElement(world, sceneId, elementId, { name, fields } = {}) {
  const elements = readElements(world);
  const element = findElementOrThrow(elements, sceneId, elementId);
  if (name !== undefined) element.name = name;
  if (fields !== undefined) element.fields = { ...element.fields, ...fields };
  writeElements(world, elements);
  return element;
}

/**
 * Idempotent: removing an already-removed/unknown elementId is a safe no-op,
 * not an error. Never touches a promoted element's own graph node — same
 * "never auto-touch the graph" invariant as demote.
 *
 * @returns {{deleted:boolean}}
 */
export function removeElement(world, sceneId, elementId) {
  const elements = readElements(world);
  const next = elements.filter((e) => !(e.sceneId === sceneId && e.id === elementId));
  const deleted = next.length !== elements.length;
  if (deleted) writeElements(world, next);
  return { deleted };
}

/**
 * Reorder-by-array: `orderedElementIds` is the scene's elements in their new
 * desired order — each listed element's `order` is set to its index in this
 * array. Unlisted elements (should not normally happen) keep their existing
 * `order`. A simple ↑/↓ swap (the design record's own baseline) is just a
 * two-element instance of this same call.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {string[]} orderedElementIds
 * @returns {object[]}   the scene's elements, freshly re-sorted by `order`
 */
export function reorderElements(world, sceneId, orderedElementIds) {
  const elements = readElements(world);
  orderedElementIds.forEach((id, index) => {
    const element = elements.find((e) => e.sceneId === sceneId && e.id === id);
    if (element) element.order = index;
  });
  writeElements(world, elements);
  return listElementsForScene(world, sceneId);
}

/**
 * Promotes a scene-local element into a real World Fabric graph node,
 * contained in the scene's own anchor place. Creates the node
 * (`addNodeOp`) then a real `containment` edge from the new node to the
 * scene's `locationEntityId` (`addEdgeOp`), then sets `kind:'graph'` +
 * `graphEntityId` on the element record. Already-promoted (idempotent): a
 * second promote call on an already-`kind:'graph'` element is a no-op
 * returning the element unchanged, rather than creating a second node.
 *
 * @param {string} dir       resolved data dir (resolveDir()'s return value)
 * @param {string} world
 * @param {string} sceneId
 * @param {string} elementId
 * @param {object} [opts]
 * @param {string} [opts.type]   entity type for the new graph node (default "object" — the contract does not pin this string)
 * @returns {Promise<object>}   the updated element
 */
export async function promoteElement(dir, world, sceneId, elementId, opts = {}) {
  const elements = readElements(world);
  const element = findElementOrThrow(elements, sceneId, elementId);
  if (element.kind === "graph" && element.graphEntityId) {
    return element; // already promoted -- never create a second node for the same element
  }

  const scene = getScene(world, sceneId); // throws "No scene found" if unknown
  if (!scene.locationEntityId) {
    throw new Error(`Scene "${sceneId}" has no anchor place set -- cannot promote an element into the graph without one.`);
  }

  const type = opts.type ?? "object";
  const { entityId } = await addNodeOp(dir, world, { name: element.name, type });
  await addEdgeOp(dir, world, { sourceId: entityId, targetId: scene.locationEntityId, relationshipType: "containment" });

  element.kind = "graph";
  element.graphEntityId = entityId;
  writeElements(world, elements);
  return element;
}

/**
 * Demotes a graph-kind element back to scene-local. NEVER deletes the
 * underlying graph node — only this store's own bookkeeping changes. A
 * demote on an already-local element is a safe no-op.
 *
 * @returns {object}   the updated element
 */
export function demoteElement(world, sceneId, elementId) {
  const elements = readElements(world);
  const element = findElementOrThrow(elements, sceneId, elementId);
  element.kind = "local";
  element.graphEntityId = null;
  writeElements(world, elements);
  return element;
}

export { ConcurrentWriteError };
