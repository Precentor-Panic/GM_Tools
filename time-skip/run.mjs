/**
 * Orchestration — pure Node, but NOT Foundry-free in the strict "no outbound
 * network call" sense (it drives texture.mjs's real Anthropic API call).
 *
 * Extracted from wf-mcp-server/index.mjs's wf_propose_mutations handler
 * (Phase 2 task 2.0): the propagate -> filter -> group -> texture ->
 * attachDiffs -> createBatch sequence, now reusable by any front-end
 * (wf-mcp-server today, a future review-ui/) without duplicating the
 * orchestration logic (see gm-tools-conventions: "front-ends are thin
 * wrappers, never logic duplicators").
 */
import { textureBatch } from "../mutation-engine/texture.mjs";
import { createBatch, makeBatchId } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { diffEntity, diffEdge } from "../mutation-engine/diff.mjs";
import { findEntity, findEdge } from "../wf-mcp-server/lib/graph.mjs";
import { resolveScope } from "./scope.mjs";

/**
 * Attach diff.mjs's field-level diff to each upsert_entity/upsert_edge
 * mutation, computed against the live snapshot's current state merged with
 * the mutation's own proposed `data` (the merge semantics diff.mjs's own
 * doc comment requires: `{...before, ...data}`, not a sparse patch). This is
 * what grain.mjs's renderEntityDiff needs to show "field: from -> to"
 * instead of falling back to a raw-JSON-dump view. A create op (no id, or
 * an id with no live match) has no "before" state -- diffEntity/diffEdge's
 * own null-before handling already produces a single "(created)" marker
 * rather than per-field noise, so no special-casing is needed here.
 *
 * Moved here verbatim from wf-mcp-server/index.mjs as part of task 2.0's
 * extraction (was previously exported from index.mjs for testing only).
 */
export function attachDiffs(mutations, entities, edges) {
  return mutations.map((m) => {
    if (m.op === "upsert_entity") {
      const current = m.id ? findEntity(entities, m.id) : null;
      const merged = { ...(current ?? {}), ...(m.data ?? {}) };
      return { ...m, diff: diffEntity(current, merged) };
    }
    if (m.op === "upsert_edge") {
      const current = m.id ? findEdge(edges, m.id) : null;
      const merged = { ...(current ?? {}), ...(m.data ?? {}) };
      return { ...m, diff: diffEdge(current, merged) };
    }
    return m;
  });
}

/**
 * Resolve a scope, texture the needs-LLM candidates into concrete
 * mutations, and persist a new review batch. Same sequence
 * wf_propose_mutations's handler ran inline pre-extraction, byte-identical.
 *
 * @param {string} world
 * @param {object} scopeSpec              same shape resolveScope() takes; also the
 *                                         object persisted as the batch's `scope` field
 *                                         (unchanged from pre-extraction: does NOT
 *                                         include opts.seeds, matching the original
 *                                         handler's exact persisted shape)
 * @param {string} [elapsedTimeDescriptor]
 * @param {object} opts
 * @param {object[]} opts.entities                the live snapshot's entities (required)
 * @param {object[]} opts.edges                   the live snapshot's edges (required)
 * @param {Array<{entityId:string,magnitude:number}>} [opts.seeds]
 *                                         multi-seed list (mode='seed' only); merged into
 *                                         a local resolution-only scope spec, NOT into the
 *                                         persisted batch.scope (preserves task 2.0's
 *                                         byte-identical-persistence requirement)
 * @param {string} [opts.batchId]         override id generation (tests / determinism)
 * @param {object} [opts.textureOpts]     forwarded to textureBatch (injectable client, etc.)
 * @returns {Promise<{batchId:string, mutationCount:number, totalCandidateDeltas:number, needsLLMCount:number, headline:string}>}
 */
export async function orchestrateBatch(world, scopeSpec, elapsedTimeDescriptor, opts = {}) {
  const { entities, edges, seeds, textureOpts = {} } = opts;
  if (!entities || !edges) {
    throw new Error("orchestrateBatch requires opts.entities and opts.edges (the live snapshot)");
  }

  const resolutionSpec = seeds !== undefined ? { ...scopeSpec, seeds } : scopeSpec;
  const { deltas } = resolveScope({ entities, edges }, resolutionSpec);

  const needsLLM = deltas.filter((d) => d.needsLLM);
  const batchId = opts.batchId ?? makeBatchId();

  const { mutations } = await textureBatch(
    needsLLM,
    { entities, edges, world, batchId, elapsedTimeDescriptor },
    textureOpts
  );
  const diffedMutations = attachDiffs(mutations, entities, edges);

  const batch = createBatch(world, scopeSpec, elapsedTimeDescriptor, diffedMutations, { makeId: () => batchId });
  const summary = summarizeBatch(batch);

  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    totalCandidateDeltas: deltas.length,
    needsLLMCount: needsLLM.length,
    headline: renderHeadline(summary)
  };
}
