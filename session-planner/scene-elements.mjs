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
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";
import { findEntity } from "../wf-mcp-server/lib/graph.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-elements");

// SCHEMA_VERSION 2 (Phase 29 task 29.1): additive -- `SceneElement` gained an
// optional `stat` StatBlock field (design record's "the reframe" stat-block
// decision, matches the prototype's `element.stat`). Old elements persisted
// under v1 simply have no `stat` key at all, which zod's `.optional()`
// accepts fine on read -- no migration needed.
//
// SCHEMA_VERSION 3 (Phase 35 task 35.1): additive -- `SceneElementFields`
// gained an optional `bestiaryEntryId` key (see its own doc comment above)
// plus `StatBlock`'s `ac`/`hp`/`cr` widened to accept string OR number. Both
// changes are read-compatible with every pre-existing element (an absent
// key/a string value both still parse fine) -- no migration needed, same
// "additive, no migration" reasoning as the v1->v2 bump above.
export const SCHEMA_VERSION = 3;

export const SceneElementKind = z.enum(["local", "graph"]);

// Phase 29 task 29.1: `element.stat` shape, verbatim from
// review-ui/test/e2e/phase29-fixture.mjs §1 / the design record's "Data
// shapes confirmed from the prototypes" -- `count` is the only numeric
// field, everything else is free text so a DM can type "13" or "13 (from
// Studded Leather)" without a schema fight. `foundryActor` is STORED ONLY --
// no route anywhere pushes it to Foundry.
//
// Phase 35 task 35.1: `ac`/`hp`/`cr` widened to `z.union([z.string(),
// z.number()])` -- the scene tray's creature-drop route (review-ui/
// server.mjs's statFromBestiaryRawFields) populates these DIRECTLY from a
// BestiaryEntry's own `rawFields.ac`/`hp`/`challengeRating`, which are
// genuinely numbers for a Foundry-pulled monster (combat-planning/
// foundry-actor-mapper.mjs's mapActorToBestiary), not the free-text strings
// a hand-typed stat block (Phase 29's own original use case) carries.
// Stringifying them would have broken review-ui/test/e2e/
// phase35-pull-and-persistence.e2e.mjs's own strict-equal assertion against
// the source rawFields value's exact type -- widening the schema, not the
// route coercing to match a narrower one, keeps both call sites' native
// value types intact. Every pre-existing string-only caller (Phase 29's own
// hand-typed "13"/"22 (4d8+4)" free text) is unaffected -- z.union still
// accepts a plain string.
export const StatBlock = z.object({
  count: z.number().optional(),
  ac: z.union([z.string(), z.number()]).optional(),
  hp: z.union([z.string(), z.number()]).optional(),
  speed: z.string().optional(),
  cr: z.union([z.string(), z.number()]).optional(),
  raw: z.string().optional(),
  foundryActor: z.string().optional()
}).strict();

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
//
// Phase 35 task 35.1: gained `bestiaryEntryId` (optional string) -- the
// scene tray's creature-drop route (review-ui/server.mjs, §7 of
// review-ui/test/e2e/phase35-fixture.mjs) needs a scene-element-local field
// to dedup "has this bestiary entry already been dropped into this scene"
// (an existing element whose `fields.bestiaryEntryId === id` is reused
// rather than creating a duplicate). NOTE: this schema is `.strict()` --
// unlike the free-form "open bag" this field was originally described as in
// planning prose, zod actually REJECTS an unrecognized key here, so this
// field had to be added to the schema explicitly, not just passed through;
// caught by this task's own real route test (a genuine 400 ZodError,
// "Unrecognized key: bestiaryEntryId", before this addition).
export const SceneElementFields = z.object({
  trigger: z.string().optional(),
  gives: z.string().optional(),
  looks: z.string().optional(),
  means: z.string().optional(),
  checks: z.array(ElementCheck).optional(),
  function: z.string().optional(),
  wants: z.string().optional(),
  secret: z.string().optional(),
  statblockRef: z.string().optional(),
  bestiaryEntryId: z.string().optional()
}).strict();

export const SceneElement = z.object({
  id: z.string(),
  sceneId: z.string(),
  world: z.string(),
  kind: SceneElementKind,
  graphEntityId: z.string().nullable().optional(),
  name: z.string(),
  fields: SceneElementFields,
  stat: StatBlock.nullable().optional(),
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
 * @param {{name:string, kind?:'local'|'graph', fields?:object, stat?:object|null}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created element, appended at max(order for this scene)+1 (0 if the scene has none yet)
 */
export function createElement(world, sceneId, { name, kind, fields, stat } = {}, opts = {}) {
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
    stat: stat ?? null,
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
 * to change one, there is no "clear a field" shorthand here). `stat` (Phase
 * 29 task 29.1) shallow-merges the SAME way onto the element's existing
 * `stat` object, creating one from `{}` if the element had none yet — a
 * partial `{stat:{ac:"15"}}` patch on an element with `stat:{hp:"10"}`
 * yields `{hp:"10", ac:"15"}`, never a full-object replace.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {string} elementId
 * @param {{name?:string, fields?:object, stat?:object}} patch
 * @returns {object}   the updated element
 */
export function updateElement(world, sceneId, elementId, { name, fields, stat } = {}) {
  const elements = readElements(world);
  const element = findElementOrThrow(elements, sceneId, elementId);
  if (name !== undefined) element.name = name;
  if (fields !== undefined) element.fields = { ...element.fields, ...fields };
  if (stat !== undefined) element.stat = { ...(element.stat || {}), ...stat };
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
 * Attaches an EXISTING World Fabric graph node as a `kind:'graph'` element
 * of this scene (Phase 29 task 29.1, "From-graph picker" — the "attach"
 * counterpart to `promoteElement`'s "create"). Deliberately creates NO new
 * graph node/edge — `graphEntityId` references the caller-supplied,
 * already-existing `entityId` verbatim. Appended at max(order for this
 * scene)+1, same ordering convention as `createElement`.
 *
 * Phase 37.6b addition: an optional `stat` field, additive-only and
 * backward-compatible (every EXISTING caller -- the `POST .../elements/
 * from-graph` route/the scene page's own "◇ From graph" picker -- omits it
 * and gets the exact same `stat: null` this function has always written).
 * Unlocks phase35-fixture.mjs §7's own forward-compatible pin: a graph-
 * linked bestiary entry's tray-drop attaches THROUGH THIS function instead
 * of createElement's local+stat path, and "the stat still populates" per
 * that unlock's own instruction requires somewhere to put it.
 *
 * @param {string} dir       resolved data dir (resolveDir()'s return value) — used only to look up the entity's real name from the live snapshot when `name` is omitted
 * @param {string} world
 * @param {string} sceneId
 * @param {string} entityId  an EXISTING World Fabric entity id
 * @param {{name?:string, stat?:object}} [fields]   `name` defaults to the entity's own real name (from the live snapshot) when omitted; `stat` defaults to `null` (Phase 37.6b addition, see above)
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created element, OR the scene's already-existing
 *   `kind:'graph'` element for this `entityId` verbatim, unchanged, if one
 *   already exists (Phase 33 task 33.1 dedupe — see below; note this means a
 *   `stat` passed on a call that hits the dedupe branch is NOT retroactively
 *   applied to the existing element, matching this same function's own
 *   pre-existing "return the existing one, don't duplicate" precedent)
 */
export function attachExistingNodeAsElement(dir, world, sceneId, entityId, { name, stat = null } = {}, opts = {}) {
  const makeId = opts.makeId ?? makeElementId;
  const now = opts.now ?? new Date().toISOString();
  const elements = readElements(world);
  const sceneElements = elements.filter((e) => e.sceneId === sceneId);

  // Phase 33 task 33.1 dedupe: a scene may only ever hold ONE kind:'graph'
  // element per graph node. This makes BOTH callers of this function --
  // the World surface's scene-tray drop (world-view.js addToScene) and the
  // scene page's own "◇ From graph" picker -- idempotent: attaching the
  // same node twice returns the SAME element rather than creating a
  // duplicate row. Return verbatim, no write.
  const existing = sceneElements.find((e) => e.kind === "graph" && e.graphEntityId === entityId);
  if (existing) return existing;

  const nextOrder = sceneElements.length ? Math.max(...sceneElements.map((e) => e.order)) + 1 : 0;

  let resolvedName = name;
  if (resolvedName === undefined || resolvedName === null) {
    const { entities } = loadSnapshot(dir, world).snapshot;
    resolvedName = findEntity(entities, entityId)?.name ?? "";
  }

  const element = {
    id: makeId(),
    sceneId,
    world,
    kind: "graph",
    graphEntityId: entityId,
    name: resolvedName,
    fields: {},
    stat,
    order: nextOrder,
    createdAt: now
  };
  writeElements(world, [...elements, element]);
  return element;
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
 * @param {string} [opts.type]   entity type for the new graph node — when omitted, INFERRED from the element (see below) rather than a fixed default
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

  // QA W2 fix (Group A #5): promoting used to hard-code type "object" no
  // matter what the element actually was, so an NPC/creature scene element
  // promoted to the graph as an "object". Inference rule: `element.stat`
  // (a non-null StatBlock) is the SAME signal the scene page's own row
  // already keys off (`data-has-stat`, session-planner-view.js) to tell an
  // NPC/creature element (attached via the "+ STAT BLOCK" chip or a
  // bestiary/creature-drop) apart from a plain prop -- only elements
  // carrying a stat block promote as "person"; everything else (props with
  // no stat) keeps the prior "object" default. An explicit `opts.type`
  // always wins over the inference, unchanged from before.
  const type = opts.type ?? (element.stat ? "person" : "object");
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
