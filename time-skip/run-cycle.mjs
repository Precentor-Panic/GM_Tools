/**
 * Deferred-cycle orchestration — Phase 3.5 task 3.5.2.
 *
 * A NEW, separate orchestrator alongside time-skip/run.mjs's existing
 * orchestrateBatch() — that function's eager-texture-everything behavior is
 * correct and tested for time-skip's existing ambient/tag/region/
 * contained-in modes and is deliberately left unmodified. orchestrateCycle()
 * reuses the same underlying primitives (resolveScope, groupByRegion/
 * textureBatch, createBatch) rather than duplicating them, per gm-tools-
 * conventions' "front-ends are thin wrappers, never logic duplicators" —
 * this file is closer to a sibling orchestrator than a front-end, but the
 * same "reuse, don't duplicate" rule applies to it just as much.
 *
 * The idea: for a large time-skip, resolving everything eagerly is
 * expensive (Phase 3's own latency measurement). Instead, each cycle spends
 * real money on one GM-specified "headline" focus (the anchor entity's
 * close neighborhood, textured now, same mechanism Phase 3 already
 * validated) and defers everything else in the cycle's full scope to
 * mutation-engine/pending-ledger.mjs's cheap, deterministic ledger — no
 * texturing, no discarding. If a deferred entity is never asked about
 * again, zero further cost is ever spent on it (time-skip/resolve-pending.mjs
 * handles the "asked about" case).
 *
 * Growth-bound sweep: an entity whose deferred backlog keeps growing cycle
 * after cycle without ever being asked about would otherwise accumulate
 * forever. Per the architect's design (silent expiry is wrong -- a real
 * consequence shouldn't just vanish because nobody asked in time), once an
 * entity touched by THIS cycle already has more than `growthBoundThreshold`
 * pending entries, its full accumulated backlog gets folded into this
 * cycle's own resolution (one additional texture call, same chronological
 * multi-cause rendering resolve-pending.mjs uses) rather than being allowed
 * to grow further unbounded.
 */
import { textureBatch, textureRegion, renderPendingResolutionSummary } from "../mutation-engine/texture.mjs";
import { createBatch, makeBatchId } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { readAvailablePending, writePending, listPendingEntities, markProposed, sourceBatchHeadline } from "../mutation-engine/pending-ledger.mjs";
import { attachDiffs } from "./run.mjs";
import { resolveScope } from "./scope.mjs";
import { neighborhood, findEntity } from "../wf-mcp-server/lib/graph.mjs";

export const DEFAULT_GROWTH_BOUND_THRESHOLD = 5;
export const SWEEP_REGION_ID = "region-pending-sweep";

/** Entity ids a candidateDeltas-shaped delta actually touches -- mirrors texture.mjs's own private endpointsFor(), but that helper isn't exported (and this is a single edge lookup, not traversal logic worth factoring further). */
function deltaEntityIds(delta, edges) {
  if (delta.kind === "seed-propagated") return [delta.entityId];
  if (delta.kind === "ambient-decay") {
    const edge = edges.find((e) => e.id === delta.edgeId);
    return edge ? [edge.sourceId, edge.targetId] : [];
  }
  return [];
}

/**
 * Run one deferred-resolution time-skip cycle.
 *
 * @param {string} world
 * @param {object} cycleSpec
 * @param {object} cycleSpec.cycleScope              a resolveScope()-shaped scope spec -- everything this cycle
 *                                                    could plausibly touch (e.g. {mode:'ambient', elapsedSessions:1}
 *                                                    or {mode:'region', anchorId, depth} for a wider area)
 * @param {string} cycleSpec.headlineAnchorId         entity id to eagerly texture THIS cycle
 * @param {number} [cycleSpec.headlineDepth=1]        BFS depth around headlineAnchorId textured now (small --
 *                                                    the anchor plus its close neighborhood)
 * @param {string} [cycleSpec.elapsedTimeDescriptor]
 * @param {string} cycleSpec.cycleDescriptor          short label for this cycle (e.g. "month 3") -- stored on
 *                                                    every deferred ledger entry, used for chronological
 *                                                    ordering at resolve time
 * @param {object} opts
 * @param {object[]} opts.entities                    the live snapshot's entities (required)
 * @param {object[]} opts.edges                       the live snapshot's edges (required)
 * @param {number} [opts.growthBoundThreshold]         default DEFAULT_GROWTH_BOUND_THRESHOLD (5)
 * @param {string} [opts.batchId]                      explicit batch id (tests only; no resumability here)
 * @param {object} [opts.textureOpts]                  forwarded to textureRegion/textureBatch (injectable client, etc.)
 * @returns {Promise<{batchId:string, mutationCount:number, headlineTexturedCount:number, totalCycleDeltas:number,
 *                     deferredEntryCount:number, sweptEntityCount:number, headline:string}>}
 */
export async function orchestrateCycle(world, cycleSpec, opts = {}) {
  const { entities, edges, textureOpts = {} } = opts;
  if (!entities || !edges) {
    throw new Error("orchestrateCycle requires opts.entities and opts.edges (the live snapshot)");
  }
  const growthBoundThreshold = opts.growthBoundThreshold ?? DEFAULT_GROWTH_BOUND_THRESHOLD;

  const { cycleScope, headlineAnchorId, headlineDepth = 1, elapsedTimeDescriptor, cycleDescriptor } = cycleSpec;
  if (!cycleScope) throw new Error("orchestrateCycle requires cycleSpec.cycleScope");
  if (!headlineAnchorId) throw new Error("orchestrateCycle requires cycleSpec.headlineAnchorId");
  if (!cycleDescriptor) {
    throw new Error("orchestrateCycle requires cycleSpec.cycleDescriptor (stored on every deferred ledger entry)");
  }

  const batchId = opts.batchId ?? makeBatchId();

  // 1. Full cycle-scope candidate deltas -- everything this cycle could plausibly touch.
  const { deltas: cycleDeltas } = resolveScope({ entities, edges }, cycleScope);

  // 2. Headline subset: a small region-mode neighborhood around headlineAnchorId,
  // textured NOW via the same groupByRegion/textureBatch flow orchestrateBatch
  // already uses -- this is the "spend real money on the headline, every cycle" half.
  const headlineNeighborhood = neighborhood(entities, edges, headlineAnchorId, headlineDepth);
  const headlineEntityIds = new Set(headlineNeighborhood.entities.map((e) => e.id));

  const headlineScope = {
    mode: "region",
    anchorId: headlineAnchorId,
    depth: headlineDepth,
    elapsedSessions: cycleScope.elapsedSessions,
    seeds: cycleScope.seeds
  };
  const { deltas: headlineDeltas } = resolveScope({ entities, edges }, headlineScope);
  const { mutations: headlineMutations } = await textureBatch(
    headlineDeltas,
    { entities, edges, world, batchId, elapsedTimeDescriptor },
    textureOpts
  );

  const mutations = [...headlineMutations];

  // 3. Defer everything in cycleScope NOT part of the headline subset --
  // regardless of needsLLM (the whole point: don't discard sub-threshold
  // impact, defer it). One ledger entry per affected entity per delta.
  const headlineEntity = findEntity(entities, headlineAnchorId);
  const headlineName = headlineEntity?.name ?? headlineAnchorId;
  const causeTag = `ripple from events at ${headlineName}, ${cycleDescriptor}`;

  let deferredEntryCount = 0;
  for (const delta of cycleDeltas) {
    for (const entityId of deltaEntityIds(delta, edges)) {
      if (headlineEntityIds.has(entityId)) continue; // already textured (or eligible to be) via the headline pass
      writePending(world, entityId, {
        causeTag,
        impactScore: delta.impactScore ?? Math.abs(delta.delta ?? 0),
        sourceBatchId: batchId,
        cycleDescriptor,
        status: "pending"
      });
      deferredEntryCount++;
    }
  }

  // 4. Growth-bound sweep: any entity touched by this cycle whose ledger now
  // exceeds growthBoundThreshold gets its FULL accumulated backlog folded
  // into this cycle's resolution (one more texture call) rather than being
  // left to grow further. Headline entities are excluded -- they're already
  // being fully covered this cycle via the headline pass above.
  const touchedIds = new Set(cycleDeltas.flatMap((d) => deltaEntityIds(d, edges)));
  const bloated = listPendingEntities(world)
    .filter((id) => touchedIds.has(id) && !headlineEntityIds.has(id))
    .filter((id) => readAvailablePending(world, id).length > growthBoundThreshold);

  const resolvedPendingEntries = [];
  if (bloated.length) {
    const records = [];
    const entryIdsByEntity = new Map();
    const batchHeadlineCache = new Map();
    for (const entityId of bloated) {
      const entries = readAvailablePending(world, entityId);
      entryIdsByEntity.set(entityId, entries.map((e) => e.entryId));
      const entity = findEntity(entities, entityId);
      for (const entry of entries) {
        records.push({
          entityId,
          entityName: entity?.name ?? entityId,
          cycleDescriptor: entry.cycleDescriptor,
          causeTag: entry.causeTag,
          impactScore: entry.impactScore,
          sourceBatchHeadline: sourceBatchHeadline(world, entry.sourceBatchId, batchHeadlineCache)
        });
      }
    }

    const sweepRegion = {
      regionId: SWEEP_REGION_ID,
      entityIds: bloated,
      deltas: records.map((r) => ({ impactScore: r.impactScore }))
    };
    const sweepMutations = await textureRegion(
      sweepRegion,
      {
        entities,
        edges,
        world,
        batchId,
        sourceKind: "deferred-resolution",
        elapsedTimeDescriptor,
        deltaSummaryOverride: renderPendingResolutionSummary(records)
      },
      textureOpts
    );
    mutations.push(...sweepMutations);

    for (const [entityId, entryIds] of entryIdsByEntity) {
      markProposed(world, entityId, entryIds);
      resolvedPendingEntries.push({ regionId: SWEEP_REGION_ID, entityId, entryIds });
    }
  }

  // 5. Persist the headline (+ any sweep) batch.
  const diffedMutations = attachDiffs(mutations, entities, edges);
  const batch = createBatch(world, cycleScope, elapsedTimeDescriptor, diffedMutations, {
    makeId: () => batchId,
    resolvedPendingEntries
  });
  const summary = summarizeBatch(batch);

  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    headlineTexturedCount: headlineMutations.length,
    totalCycleDeltas: cycleDeltas.length,
    deferredEntryCount,
    sweptEntityCount: bloated.length,
    headline: renderHeadline(summary)
  };
}
