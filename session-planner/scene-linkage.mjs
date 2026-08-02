/**
 * Scene-to-scene linkage — pure, Foundry-free, unit-testable.
 *
 * Phase 22 task 22.1. Resolves plans/phase-21-review.md §12's "scene-to-scene
 * linkage" open question exactly as adjudicated: DERIVED on demand from World
 * Fabric graph adjacency, never stored on the scene record. No new persisted
 * field anywhere — session-planner/scenes.mjs (createScene/forkScene/
 * getScene/listScenesForWorld) is used completely unmodified, imported
 * read-only.
 *
 * This is the query Phase 24's Scenes tab will call directly — the return
 * shape is kept simple and UI-ready (scene id, anchor entity id/name,
 * hop-distance) rather than raw graph internals.
 *
 * Purity (the single highest-value property of this task): linkage
 * derivation never persists anything, and is side-effect-free / idempotent
 * against unchanged state. No new graph-traversal algorithm lives in this
 * module — it composes session-planner/corridor.mjs's already-exported,
 * already-hop-distance-tagged corridorNodes() over a single-node path
 * ([scene.locationEntityId]).
 */
import { getScene, listScenesForWorld } from "./scenes.mjs";
import { corridorNodes } from "./corridor.mjs";

/**
 * Default hop-distance ceiling for "nearby enough to surface as linked" — a
 * discovery/browse query (Phase 24's Scenes tab), deliberately looser than
 * corridor.mjs's own 1-hop scene-MEMBERSHIP default.
 */
export const DEFAULT_LINKAGE_MAX_HOPS = 4;

/**
 * @param {string} world
 * @param {string} sceneId              an existing scene id (session-planner/scenes.mjs)
 * @param {{entities:object[], edges:object[]}} snapshot   caller-loaded live World Fabric snapshot
 * @param {object} [opts]
 * @param {number} [opts.maxHops]       default DEFAULT_LINKAGE_MAX_HOPS
 * @returns {Array<{sceneId:string, anchorEntityId:string, anchorEntityName:string, hopDistance:number}>}
 */
export function linkedScenesForScene(world, sceneId, snapshot, opts = {}) {
  const scene = getScene(world, sceneId); // throws "No scene found" if unknown, uncaught/unreinterpreted

  if (scene.locationEntityId === null) return [];

  const maxHops = opts.maxHops ?? DEFAULT_LINKAGE_MAX_HOPS;
  const { entities, edges } = snapshot;
  const { entities: corridorEntities } = corridorNodes(entities, edges, [scene.locationEntityId], maxHops);
  const byId = new Map(corridorEntities.map((e) => [e.id, e]));

  const linked = [];
  for (const other of listScenesForWorld(world)) {
    if (other.id === sceneId) continue;
    if (other.locationEntityId === null) continue;
    const found = byId.get(other.locationEntityId);
    if (!found) continue; // beyond maxHops, or otherwise unreachable
    linked.push({
      sceneId: other.id,
      anchorEntityId: other.locationEntityId,
      anchorEntityName: found.entity?.name ?? null,
      hopDistance: found.distance
    });
  }

  linked.sort((a, b) => a.hopDistance - b.hopDistance);
  return linked;
}
