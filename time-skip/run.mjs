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
import { groupByRegion, textureRegion } from "../mutation-engine/texture.mjs";
import { createBatch, makeBatchId } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { diffEntity, diffEdge } from "../mutation-engine/diff.mjs";
import { findEntity, findEdge } from "../wf-mcp-server/lib/graph.mjs";
import { resolveScope } from "./scope.mjs";
import { initStatus, loadStatus, saveStatus } from "./status.mjs";

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
 * wf_propose_mutations's handler ran inline pre-extraction, and byte-
 * identical in output for a fresh (non-resumed) run.
 *
 * Phase 2 task 2.2 (resumability): rather than delegating the whole
 * group->texture loop to mutation-engine/texture.mjs's textureBatch()
 * (an opaque black box from a checkpoint-writing point of view), this
 * function reuses texture.mjs's own primitives directly -- groupByRegion()
 * for clustering, textureRegion() for one call per region -- the same
 * pattern wf-mcp-server/index.mjs's wf_regenerate handler already
 * established for the same reason (needing per-region control, not just
 * per-batch). This is NOT logic duplication of textureBatch(): textureBatch
 * itself is a thin loop over these same two primitives with no checkpoint
 * concerns of its own; time-skip/run.mjs is the orchestration layer that
 * legitimately owns checkpoint/resume behavior, textureBatch does not
 * need to grow that concern for its other (simpler) callers.
 *
 * Resumability: opts.batchId doubling as a resume key. On every call, this
 * function loads (or initializes) a status file via time-skip/status.mjs
 * keyed on {world, batchId} and writes it after every phase transition AND
 * after every completed region -- not just at the end. If a status file
 * already has some regions' entityIds recorded in `processedNodeIds` (e.g.
 * because a prior process died mid-run and this is a resumed invocation
 * with the same batchId), those regions are skipped entirely: no repeat
 * textureRegion() call, no re-billing. This assumes the same entities/edges
 * are supplied across resume invocations (true in practice -- callers
 * re-load the live snapshot each time) so that resolveScope()/groupByRegion()
 * regenerate the identical region membership deterministically; region
 * completeness is checked by entity-id-set membership, not by regionId
 * string match, so it stays correct even if array ordering shifts region
 * numbering between runs.
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
 * @param {string} [opts.batchId]         explicit batch id -- required to resume a prior
 *                                         interrupted run under the same id; if omitted, a
 *                                         fresh id is generated (never a resume)
 * @param {object} [opts.textureOpts]     forwarded to textureRegion (injectable client, etc.)
 * @returns {Promise<{batchId:string, mutationCount:number, totalCandidateDeltas:number, needsLLMCount:number, headline:string}>}
 */
export async function orchestrateBatch(world, scopeSpec, elapsedTimeDescriptor, opts = {}) {
  const { entities, edges, seeds, textureOpts = {} } = opts;
  if (!entities || !edges) {
    throw new Error("orchestrateBatch requires opts.entities and opts.edges (the live snapshot)");
  }

  const batchId = opts.batchId ?? makeBatchId();
  let status = loadStatus(world, batchId) ?? initStatus(world, batchId);

  status = saveStatus({ ...status, phase: "propagating" });

  const resolutionSpec = seeds !== undefined ? { ...scopeSpec, seeds } : scopeSpec;
  const { deltas } = resolveScope({ entities, edges }, resolutionSpec);
  const needsLLM = deltas.filter((d) => d.needsLLM);
  const regions = groupByRegion(needsLLM, edges);

  status = saveStatus({ ...status, phase: "texturing", totalRegions: regions.length });

  const processedIds = new Set(status.processedNodeIds ?? []);
  const mutations = [...(status.mutations ?? [])];

  for (const region of regions) {
    const alreadyDone = region.entityIds.length > 0 && region.entityIds.every((id) => processedIds.has(id));
    if (alreadyDone) continue; // resumed run: this region was fully textured before the process died

    const sourceKind = region.deltas.some((d) => d.kind === "seed-propagated") ? "seeded-propagation" : "ambient-decay";
    const regionMutations = await textureRegion(
      region,
      { entities, edges, world, batchId, sourceKind, elapsedTimeDescriptor },
      textureOpts
    );
    mutations.push(...regionMutations);
    for (const id of region.entityIds) processedIds.add(id);

    // Incremental write after EACH region, not just at the end -- the whole
    // point of this checkpoint (a kill between two regions must not lose
    // the completed one's already-paid-for texturing).
    status = saveStatus({ ...status, processedNodeIds: [...processedIds], mutations });
  }

  const diffedMutations = attachDiffs(mutations, entities, edges);

  const batch = createBatch(world, scopeSpec, elapsedTimeDescriptor, diffedMutations, { makeId: () => batchId });
  const summary = summarizeBatch(batch);

  saveStatus({ ...status, phase: "done" });

  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    totalCandidateDeltas: deltas.length,
    needsLLMCount: needsLLM.length,
    headline: renderHeadline(summary)
  };
}
