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
import { listScenesForWorld } from "./scenes.mjs";
import { listElementsForScene } from "./scene-elements.mjs";

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
