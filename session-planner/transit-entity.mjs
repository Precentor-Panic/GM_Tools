/**
 * Transit/path entity creation — Phase 22 task 22.2.
 *
 * Design record §3/§12: path/transit scenes ARE committed graph entities,
 * created immediately (no lazy/deferred mode) — "the area between two
 * locations" has to be findable again later. Per §12's phasing resolution,
 * this does NOT add a new entity-type enum value anywhere: a transit entity
 * commits as `type: "place"` plus a distinguishing `attributes.isTransit`
 * marker.
 *
 * ENTITY-CREATION MECHANISM: a thin wrapper over the SAME established
 * manual-entity-creation route every other manual node-add in this project
 * already uses — wf-mcp-server/lib/manual-edit-ops.mjs's addNodeOp(dir, w,
 * fields). No second entity-creation mechanism, no direct
 * world-fabric-mutations.json/snapshot write of its own. A real, expected
 * consequence of this reuse: addNodeOp also stamps the GLOBAL
 * mutation-engine/manual-undo.mjs slot and calls markHumanReviewed — task
 * 22.4's scene-scoped undo is a separate, additional mechanism layered on
 * top for the "develop this scene" flow, not a replacement for this
 * ordinary single-write's own global-undo coverage.
 *
 * THE DISTINGUISHING-FIELD DECISION: attributes.isTransit === true, NOT a
 * new top-level entity field. Both graph-service.mjs's upsertEntity() (live
 * path) and interchange.mjs's normalizeEntity() (headless path) build the
 * persisted entity from an explicit, closed allowlist of top-level fields —
 * a hypothetical top-level `isTransit` key would be silently dropped on
 * write on both paths. `attributes` is the one field on that same allowlist
 * that's already a generic pass-through bag on both paths, so it's the only
 * place a genuinely new, un-enum'd marker can survive a write without a
 * foundry_worldFabric schema change (explicitly forbidden this phase).
 * manual-edit-ops.mjs's addNodeOp was extended (task 22.2) to forward
 * `fields.attributes` through to the created entity's own `data.attributes`
 * — the only change made there; the four entity-type enum files are
 * untouched, and no new type-enum literal is defined anywhere in this
 * module's own source (see the standing source-grep regression test in
 * test/scene-planning/transit-entity.test.mjs).
 */
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";
import { findEntity } from "../wf-mcp-server/lib/graph.mjs";
import { addNodeOp } from "../wf-mcp-server/lib/manual-edit-ops.mjs";

/**
 * @param {string} dir            resolved data dir (resolveDir()'s return value)
 * @param {string} world
 * @param {{fromEntityId:string, toEntityId:string, name?:string}} fields
 * @returns {Promise<{entityId:string, name:string, type:"place", isTransit:true}>}
 */
export async function createTransitEntity(dir, world, { fromEntityId, toEntityId, name } = {}) {
  const { entities } = loadSnapshot(dir, world).snapshot;

  const fromEntity = findEntity(entities, fromEntityId);
  if (!fromEntity) throw new Error(`No entity "${fromEntityId}" found in the live graph.`);
  const toEntity = findEntity(entities, toEntityId);
  if (!toEntity) throw new Error(`No entity "${toEntityId}" found in the live graph.`);

  const resolvedName = (name && name.trim())
    ? name.trim()
    : (toEntity?.name ? `The Road to ${toEntity.name}` : "Path");

  const { entityId } = await addNodeOp(dir, world, {
    name: resolvedName,
    type: "place",
    attributes: { isTransit: true }
  });

  return { entityId, name: resolvedName, type: "place", isTransit: true };
}
