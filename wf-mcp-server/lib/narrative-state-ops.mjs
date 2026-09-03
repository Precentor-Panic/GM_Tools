/**
 * Shared narrative-state operations — thin wrappers over
 * mutation-engine/narrative-state.mjs, called identically by wf-mcp-server's
 * MCP tools AND review-ui/server.mjs's HTTP routes (the prep-content-ops.mjs
 * "front-ends are thin wrappers" convention).
 *
 * WRITE DISCIPLINE (adjudicated call E of the narrative-state plan): these
 * are DIRECT writes with no review batch — sidecar class, the same standing
 * exemption prep-content-ops.mjs documents. The no-silent-auto-write
 * invariant governs writes to the World Fabric GRAPH; nothing in this module
 * touches the graph, a Mutation/StoredMutation, a review-state Batch, or any
 * Foundry sync path. Reveal transitions, truths, stances and clocks are the
 * GM's own table-state bookkeeping — the GM action IS the review.
 *
 * Ops validate the target entity against the LIVE snapshot for a clear error
 * on typos; the ONE writer that may legitimately target an entity not yet in
 * the snapshot (writeup-import truth landing at accept time, before sync)
 * calls the store directly from mutation-ops.mjs's accept hook instead of
 * going through here.
 */
import { loadSnapshot } from "./snapshot.mjs";
import { findEntity } from "./graph.mjs";
import {
  getNarrativeState,
  listNarrativeState,
  getRevealStates,
  setNarrativeTruth,
  setStance,
  setRevealState,
  setClock,
  tickClock
} from "../../mutation-engine/narrative-state.mjs";

function entityNameOrNull(dir, w, entityId) {
  try {
    const { entities } = loadSnapshot(dir, w).snapshot;
    return findEntity(entities, entityId)?.name ?? null;
  } catch {
    return null; // no snapshot yet (fresh world) — names are a nicety, not a requirement
  }
}

function requireEntity(dir, w, entityId) {
  const { entities } = loadSnapshot(dir, w).snapshot;
  const entity = findEntity(entities, entityId);
  if (!entity) {
    throw new Error(`No committed entity "${entityId}" found in world "${w}"'s live snapshot — narrative state attaches to a real, already-committed entity.`);
  }
  return entity;
}

/** wf_get_narrative_state / GET route. narrativeState:null = fully open (no record, zero gating). */
export function getNarrativeStateOp(dir, w, { entityId }) {
  return {
    entityId,
    entityName: entityNameOrNull(dir, w, entityId),
    narrativeState: getNarrativeState(dir, w, entityId)
  };
}

/**
 * wf_set_narrative_state / PUT route — the combined write: any subset of
 * {revealState, truth, stance, clock} in one call. `null` clears truth/
 * stance/clock; omitted fields are untouched. revealState applies FIRST so a
 * fresh record's from:null creation transition lands directly at the target
 * state rather than passing through the default.
 */
export function setNarrativeStateOp(dir, w, { entityId, revealState, truth, stance, clock, note, sessionNumber, source = "manual" }) {
  const entity = requireEntity(dir, w, entityId);
  if (revealState !== undefined) {
    setRevealState(dir, w, entityId, revealState, { source, note, sessionNumber: sessionNumber ?? null });
  }
  if (truth !== undefined || stance !== undefined) {
    if (truth !== undefined) {
      setNarrativeTruth(dir, w, entityId, truth, { ...(stance !== undefined ? { stance } : {}), source });
    } else {
      setStance(dir, w, entityId, stance, { source });
    }
  }
  if (clock !== undefined) {
    setClock(dir, w, entityId, clock, { source });
  }
  return { entityId, entityName: entity.name, narrativeState: getNarrativeState(dir, w, entityId) };
}

/** wf_set_reveal_state: the focused reveal-transition write (appends to the append-only history; same-state is a safe no-op). */
export function setRevealStateOp(dir, w, { entityId, to, note, sessionNumber, source = "manual" }) {
  const entity = requireEntity(dir, w, entityId);
  const narrativeState = setRevealState(dir, w, entityId, to, { source, note, sessionNumber: sessionNumber ?? null });
  return { entityId, entityName: entity.name, narrativeState };
}

/** wf_tick_clock / tick route: advance (or rewind, negative delta) the entity's clock, clamped [0,max]. */
export function tickClockOp(dir, w, { entityId, delta }) {
  const entity = requireEntity(dir, w, entityId);
  const narrativeState = tickClock(dir, w, entityId, delta ?? 1);
  return { entityId, entityName: entity.name, narrativeState };
}

/**
 * wf_list_narrative_state / GET list route. Names joined from the snapshot
 * (falling back to the raw id for an entity that has a record but is gone
 * from the graph — surfaced, not hidden, so orphans are visible).
 * `ids` (bulk mode) returns only those entities' records — the run-spread
 * tab-seeding fetch; `revealState` filters the full scan.
 */
export function listNarrativeStateOp(dir, w, { revealState, ids } = {}) {
  let records;
  if (Array.isArray(ids)) {
    records = [...getRevealStates(dir, w, ids).values()];
    if (revealState) records = records.filter((r) => r.revealState === revealState);
  } else {
    records = listNarrativeState(dir, w, { revealState });
  }
  let entities = [];
  try {
    entities = loadSnapshot(dir, w).snapshot.entities;
  } catch { /* fresh world: ids stand in for names */ }
  return {
    world: w,
    records: records.map((r) => ({
      ...r,
      entityName: findEntity(entities, r.entityId)?.name ?? r.entityId
    }))
  };
}
