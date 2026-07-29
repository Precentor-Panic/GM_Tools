/**
 * Session Brief assembler — Phase 16 task 16.5.
 *
 * Pure orchestration over the modules built in 16.1-16.4. Design record §7's
 * framing correction is a data-shape decision, not just a UI one: this
 * module's output MUST NOT contain any ordinal/chapter-numbering field
 * anywhere in its shape (no `order`, `chapter`, `sequence`, `step`, etc.) --
 * `locations` is an unordered/distance-tagged collection, not a numbered
 * sequence, so a later UI phase can't accidentally reintroduce linear-module
 * framing just because the data implies an order.
 */
import { corridorNodes } from "./corridor.mjs";
import { buildAmbientDigestEntry } from "./digest.mjs";
import { contentReadinessFlag, structuralUnderConnectionFlag } from "./flags.mjs";
import { listPendingNotes } from "./session-notes.mjs";
import { getCurrentEntityNarration } from "../mutation-engine/entity-narration.mjs";

/** Default corridor width (hops) when the caller doesn't specify one. */
export const DEFAULT_CORRIDOR_TOLERANCE = 2;

function findConnectingEdge(edges, entityId) {
  return edges.find((e) => e.sourceId === entityId || e.targetId === entityId) ?? null;
}

/**
 * @param {string} world
 * @param {{entities:object[], edges:object[]}} snapshot   the FULL live snapshot, not pre-filtered
 * @param {object} scene   a session-planner/scenes.mjs Scene record (at minimum {id, locationEntityId})
 * @param {object} [opts]
 * @param {number} [opts.corridorTolerance]
 * @returns {object}   see this module's own top-of-file contract / test/session-planner/brief.test.mjs's header comment
 */
export function buildSessionBrief(world, snapshot, scene, opts = {}) {
  const entities = snapshot.entities ?? [];
  const edges = snapshot.edges ?? [];
  const corridorTolerance = opts.corridorTolerance ?? DEFAULT_CORRIDOR_TOLERANCE;

  const path = scene.locationEntityId ? [scene.locationEntityId] : [];
  const corridor = path.length ? corridorNodes(entities, edges, path, corridorTolerance) : { entities: [], edges: [] };
  const corridorIdSet = new Set(corridor.entities.map((n) => n.id));

  const allNotes = listPendingNotes(world);

  const locations = corridor.entities.map(({ id: entityId, distance, entity }) => {
    const connectingEdge = findConnectingEdge(corridor.edges, entityId);
    const narration = getCurrentEntityNarration(world, entityId);
    const digest = buildAmbientDigestEntry(entity, connectingEdge, narration);
    const contentFlag = contentReadinessFlag(world, entityId, distance);
    const structuralFlag = structuralUnderConnectionFlag(entities, edges, entityId, distance, {});
    const notes = allNotes.filter((n) => n.anchorEntityId === entityId);
    return { entityId, distance, digest, contentFlag, structuralFlag, notes };
  });

  let contentReadinessCount = 0;
  let structuralUnderConnectionCount = 0;
  for (const entity of entities) {
    if (corridorIdSet.has(entity.id)) continue;
    if (contentReadinessFlag(world, entity.id, null).flagged) contentReadinessCount++;
    if (structuralUnderConnectionFlag(entities, edges, entity.id, null, {}).flagged) structuralUnderConnectionCount++;
  }

  return {
    sceneId: scene.id,
    path,
    locations,
    beyondCorridor: { contentReadinessCount, structuralUnderConnectionCount }
  };
}

/**
 * Proactive staleness detection (design record §7): compares the scene's
 * anchor location against wherever the party actually currently is, IF
 * that's been recorded. Pure comparison, no store I/O of its own.
 *
 * @param {string} world
 * @param {object} scene                     {locationEntityId, ...}
 * @param {string|null|undefined} currentLocationEntityId
 * @returns {{stale:boolean, sceneLocationEntityId:string|null, currentLocationEntityId:string|null, reason?:'no-current-position-recorded'}}
 */
export function checkStaleness(world, scene, currentLocationEntityId) {
  const sceneLocationEntityId = scene.locationEntityId ?? null;
  if (currentLocationEntityId === null || currentLocationEntityId === undefined) {
    return {
      stale: false,
      sceneLocationEntityId,
      currentLocationEntityId: null,
      reason: "no-current-position-recorded"
    };
  }
  return {
    stale: sceneLocationEntityId !== currentLocationEntityId,
    sceneLocationEntityId,
    currentLocationEntityId
  };
}
