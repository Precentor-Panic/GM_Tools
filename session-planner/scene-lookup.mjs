/**
 * Node → scenes reverse lookup — pure, Foundry-free, unit-testable.
 *
 * Phase 30 task 30.1. The World inspector's "appears in" panel needs the
 * inverse of what every other session-planner store answers (a scene's own
 * anchor/membership/elements) -- given a graph node, which scenes reference
 * it at all, and how. Deliberately a SEPARATE module from scenes.mjs itself
 * (not a new export bolted onto that file) to avoid a circular import:
 * scene-elements.mjs already imports `getScene` FROM scenes.mjs, so a
 * scenes.mjs -> scene-elements.mjs edge in the other direction would create
 * a cycle. This module sits one layer above all three stores instead,
 * mirroring session-planner/plans.mjs's own `plansContainingScene` -- the
 * established pattern for "which X reference this Y" reverse lookups in
 * this directory -- one level up (entity, not scene).
 *
 * A scene "appears" for `entityId` if ANY of:
 *   - `scene.locationEntityId === entityId`                         role "anchor"
 *   - a `kind:'graph'` element of the scene has
 *     `graphEntityId === entityId`                                  role "element"
 * A single scene can carry more than one role at once (e.g. a node that's
 * both the scene's own anchor place AND separately attached as a graph
 * element -- an unusual but not impossible combination) -- `roles` is always
 * an array, never collapsed to a single value.
 *
 * Phase 33 task 33.1: the former THIRD role, "member" (backed by the
 * now-retired session-planner/scene-membership.mjs), is gone -- scene
 * contents are unified as scene-elements, so anything that used to be a bare
 * membership entry is now, post-redirect, a real "element" role instead.
 */
import { listScenesForWorld, updateScene } from "./scenes.mjs";
import { listElementsForScene, removeElement } from "./scene-elements.mjs";

/**
 * @param {string} world
 * @param {string} entityId
 * @returns {{scene:object, roles:string[]}[]}   every scene that references
 *   `entityId` in at least one way, in `listScenesForWorld`'s own stable
 *   append order (matching plansContainingScene's own ordering convention).
 *   `[]` for a node that appears in no scene -- never throws, never a 404
 *   shape (there is no "not found" state here, only "no appearances").
 */
export function scenesForEntity(world, entityId) {
  const appearances = [];
  for (const scene of listScenesForWorld(world)) {
    const roles = [];
    if (scene.locationEntityId === entityId) roles.push("anchor");
    const hasGraphElement = listElementsForScene(world, scene.id).some(
      (el) => el.kind === "graph" && el.graphEntityId === entityId
    );
    if (hasGraphElement) roles.push("element");

    if (roles.length) appearances.push({ scene, roles });
  }
  return appearances;
}

/**
 * Phase 33 task 33.2 -- the opt-in cleanup behind the World inspector's
 * "Remove from graph" action's "also remove it from all N scenes" checkbox.
 * For every scene that references `entityId` (via scenesForEntity above):
 *   - role "element": `removeElement` every `kind:'graph'` element whose
 *     `graphEntityId === entityId` (the dangling KEY-element rows a bare
 *     `deleteNodeOp` would otherwise leave silently demoted to dressing).
 *   - role "anchor": clear the scene's `locationEntityId` to null via
 *     `updateScene` (-> the scene renders "Unplaced", which the scene page
 *     already tolerates -- session-planner-view.js:2761).
 *
 * Deliberately a pure store op with NO graph write of its own -- the caller
 * (the confirm handler) fires this BEFORE `deleteNodeOp`; the node deletion
 * and its atomic undo are entirely separate. Idempotent and safe when the
 * entity is referenced by no scene (returns a zeroed summary, writes nothing).
 * This cleanup is NOT covered by deleteNodeOp's single-slot undo -- surfaced
 * honestly in the toast text.
 *
 * @param {string} world
 * @param {string} entityId
 * @returns {{removedElements:number, unanchoredScenes:number}}
 */
export function removeEntityFromAllScenes(world, entityId) {
  let removedElements = 0;
  let unanchoredScenes = 0;
  for (const { scene, roles } of scenesForEntity(world, entityId)) {
    if (roles.includes("element")) {
      const graphElements = listElementsForScene(world, scene.id).filter(
        (el) => el.kind === "graph" && el.graphEntityId === entityId
      );
      for (const el of graphElements) {
        if (removeElement(world, scene.id, el.id).deleted) removedElements += 1;
      }
    }
    if (roles.includes("anchor")) {
      updateScene(world, scene.id, { locationEntityId: null });
      unanchoredScenes += 1;
    }
  }
  return { removedElements, unanchoredScenes };
}
