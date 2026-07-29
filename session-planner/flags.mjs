/**
 * Two independent flags — deliberately never merged into one signal.
 *
 * Phase 16 task 16.3. Design record §5: "a fully-written node can still be
 * structurally fragile; a fully-connected node can still be unwritten.
 * These are different DM responses (write more vs. add another edge) and
 * must stay two separate flags." Both accept a corridor-distance value
 * (session-planner/corridor.mjs's output) purely to pass through onto the
 * returned object — the loud-in-corridor/quiet-beyond severity SCOPING is
 * session-planner/brief.mjs's (16.5) job, not either of these functions'.
 */
import { getCurrentEntityNarration } from "../mutation-engine/entity-narration.mjs";
import { readAvailablePending } from "../mutation-engine/pending-ledger.mjs";
import { edgesFor } from "../wf-mcp-server/lib/graph.mjs";

/** The structural under-connection flag's default edge-count threshold. */
export const DEFAULT_MIN_EDGES = 2;

/**
 * "Edge of the world" / content-readiness flag. STORE I/O: reads
 * mutation-engine/entity-narration.mjs's getCurrentEntityNarration and
 * mutation-engine/pending-ledger.mjs's readAvailablePending — no new
 * schema, purely a read-composition of two existing stores.
 *
 * @param {string} world
 * @param {string} entityId
 * @param {number|null} [distance]   passed straight through, never inspected internally
 * @returns {{entityId:string, distance:number|null, flagged:boolean, reasons:Array<'no-narration'|'pending-debt'>}}
 */
export function contentReadinessFlag(world, entityId, distance = null) {
  const reasons = [];
  if (!getCurrentEntityNarration(world, entityId)) reasons.push("no-narration");
  if (readAvailablePending(world, entityId).length > 0) reasons.push("pending-debt");
  return {
    entityId,
    distance,
    flagged: reasons.length > 0,
    reasons
  };
}

/**
 * PURE graph function, zero store I/O (matches propagate.mjs's convention).
 * Reuses wf-mcp-server/lib/graph.mjs's edgesFor() for the count.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {string} entityId
 * @param {number|null} [distance]   same pass-through convention as contentReadinessFlag
 * @param {object} [opts]
 * @param {number} [opts.minEdges]   default DEFAULT_MIN_EDGES
 * @returns {{entityId:string, distance:number|null, flagged:boolean, edgeCount:number, minEdges:number}}
 */
export function structuralUnderConnectionFlag(entities, edges, entityId, distance = null, opts = {}) {
  const minEdges = opts.minEdges ?? DEFAULT_MIN_EDGES;
  const edgeCount = edgesFor(edges, entityId).length;
  return {
    entityId,
    distance,
    flagged: edgeCount < minEdges,
    edgeCount,
    minEdges
  };
}
