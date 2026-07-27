/**
 * On-demand resolve orchestration — Phase 3.5 task 3.5.3.
 *
 * The explicit, opt-in counterpart to time-skip/run-cycle.mjs's deferral:
 * given an entity a GM has just asked about, gather everything it (and a
 * bounded neighborhood around it) accumulated in mutation-engine/
 * pending-ledger.mjs since it was last resolved, render it chronologically,
 * and make ONE textureRegion call to synthesize it into concrete mutations
 * -- costing real money only now, only because a GM actually asked.
 *
 * THE FAN-OUT CAP (this task's single most important piece of logic): a
 * requested entity's neighborhood can be arbitrarily large, and every
 * neighbor with its own pending backlog is a candidate to fold into this
 * same resolve call. Left uncapped, a high-degree anchor could balloon into
 * an enormous, expensive single call -- exactly the cost blowup this whole
 * phase exists to prevent. The cap is flat, by impact score (top
 * maxNeighbors, default 8), NOT sub-clustering: per the architect's
 * reasoning, sub-clustering a single-anchor neighborhood degenerates badly
 * (it either collapses back to one giant cluster, or one-call-per-node --
 * the exact blowup being prevented). Neighbors beyond the cap are left
 * untouched (still 'pending', still available for a future resolve).
 *
 * This is the SAME reusable primitive noted in phase-3.5-tasks.md as the fix
 * for Phase 3's live-diff latency if that's ever revisited -- built generic
 * enough to be reused there later, but NOT retrofitted into that path as
 * part of this phase (explicitly out of scope; see Definition of Done).
 */
import { textureRegion, renderPendingResolutionSummary } from "../mutation-engine/texture.mjs";
import { createBatch, makeBatchId } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { readAvailablePending, listPendingEntities, markProposed, sourceBatchHeadline } from "../mutation-engine/pending-ledger.mjs";
import { attachDiffs } from "./run.mjs";
import { neighborhood, findEntity } from "../wf-mcp-server/lib/graph.mjs";

export const DEFAULT_RESOLVE_DEPTH = 1;
export const DEFAULT_MAX_NEIGHBORS = 8;
export const RESOLVE_REGION_ID = "region-resolve-pending";

/**
 * Resolve a requested entity's accumulated pending-ledger backlog (plus a
 * capped set of its most-impactful pending-bearing neighbors) into one
 * review batch.
 *
 * @param {string} world
 * @param {string} requestedEntityId
 * @param {object} [resolveOpts]
 * @param {number} [resolveOpts.depth=1]           neighbor BFS depth (reuses wf-mcp-server/lib/graph.mjs's neighborhood())
 * @param {number} [resolveOpts.maxNeighbors=8]     the fan-out cap: max neighboring pending-bearing entities folded in
 * @param {object} opts
 * @param {object[]} opts.entities                  the live snapshot's entities (required)
 * @param {object[]} opts.edges                      the live snapshot's edges (required)
 * @param {string} [opts.elapsedTimeDescriptor]
 * @param {string} [opts.batchId]                    explicit batch id (tests only)
 * @param {object} [opts.textureOpts]                forwarded to textureRegion (injectable client, etc.)
 * @returns {Promise<{batchId:string, mutationCount:number, resolvedEntityIds:string[],
 *                     cappedNeighborCount:number, excludedNeighborCount:number, headline:string}>}
 */
export async function resolvePending(world, requestedEntityId, resolveOpts = {}, opts = {}) {
  const { depth = DEFAULT_RESOLVE_DEPTH, maxNeighbors = DEFAULT_MAX_NEIGHBORS } = resolveOpts;
  const { entities, edges, elapsedTimeDescriptor, textureOpts = {} } = opts;
  if (!entities || !edges) {
    throw new Error("resolvePending requires opts.entities and opts.edges (the live snapshot)");
  }

  // 1. The requested entity's own pending ledger -- never subject to the cap.
  const ownEntries = readAvailablePending(world, requestedEntityId);

  // 2. Its neighborhood (reuses graph.mjs's neighborhood(), not a third BFS).
  const { entities: neighborEntities } = neighborhood(entities, edges, requestedEntityId, depth);
  const neighborIds = neighborEntities.map((e) => e.id).filter((id) => id !== requestedEntityId);

  // 3. Filter to neighbors with a non-empty pending ledger, sort by each
  // entity's highest single pending impactScore descending, take the top
  // maxNeighbors -- THE FAN-OUT CAP.
  const pendingEntitySet = new Set(listPendingEntities(world));
  const candidateNeighborIds = neighborIds.filter((id) => pendingEntitySet.has(id));
  const neighborScored = candidateNeighborIds
    .map((id) => {
      const entries = readAvailablePending(world, id);
      const maxImpact = entries.reduce((m, e) => Math.max(m, e.impactScore), 0);
      return { id, maxImpact };
    })
    .sort((a, b) => b.maxImpact - a.maxImpact);
  const cappedNeighborIds = neighborScored.slice(0, maxNeighbors).map((n) => n.id);
  const excludedNeighborCount = candidateNeighborIds.length - cappedNeighborIds.length;

  if (!ownEntries.length && !cappedNeighborIds.length) {
    throw new Error(
      `No pending ledger entries found for "${requestedEntityId}" or its depth=${depth} neighborhood -- nothing to resolve.`
    );
  }

  // 4. Hydrate full context (via loadBatch on each entry's sourceBatchId)
  // and render everything sorted chronologically by cycleDescriptor, each
  // line labeled with its cycle -- never an undated flat dump.
  const resolvedEntityIds = [requestedEntityId, ...cappedNeighborIds];
  const batchHeadlineCache = new Map();
  const records = [];
  const entryIdsByEntity = new Map();

  for (const entityId of resolvedEntityIds) {
    const entries = readAvailablePending(world, entityId);
    if (!entries.length) continue;
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

  const resolvedIdsWithEntries = [...entryIdsByEntity.keys()];

  // 5. One textureBatch-shaped call (reuses texture.mjs's textureRegion
  // directly, doesn't fork it) producing mutations for the resolved entities.
  const batchId = opts.batchId ?? makeBatchId();
  const region = {
    regionId: RESOLVE_REGION_ID,
    entityIds: resolvedIdsWithEntries,
    deltas: records.map((r) => ({ impactScore: r.impactScore }))
  };
  const mutations = await textureRegion(
    region,
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

  // 6. Create the review batch, recording which ledger entries it resolves.
  const diffedMutations = attachDiffs(mutations, entities, edges);
  //
  // Task 14.3 (QA-pass finding, deferred-debt neighbor leak): resolvedIdsWithEntries
  // is every entity that had ledger entries GOING IN as context -- the
  // requested entity plus every capped neighbor. It is NOT the same set as
  // "entities the LLM actually produced a mutation for": textureRegion's one
  // call is free to address only some of the folded-in backlog, especially
  // for a lower-impact neighbor that was mostly just useful context. Every
  // mutation in this batch shares the SAME regionId (RESOLVE_REGION_ID), and
  // applyLedgerOutcome (pending-ledger.mjs) resolves a record purely by
  // regionId match on ANY accepted mutation in that region -- so recording a
  // resolvedPendingEntries entry for an entity that got zero mutations meant
  // its real, still-unaddressed backlog silently vanished the moment ANY
  // mutation in the batch (e.g. just the requested entity's own) was
  // accepted. Fix: only record a resolvedPendingEntries entry for an entity
  // this batch's mutations genuinely target -- via `m.id` for entity ops, or
  // via the edge's real endpoints (resolved against the live snapshot, same
  // as review-ui/server.mjs's graphPayloadForBatch already does) for edge
  // ops. An entity that was folded in as context but received no mutation
  // keeps its ledger entries untouched, unchanged by this batch's outcome.
  const edgeMap = new Map(edges.map((e) => [e.id, e]));
  const touchedEntityIds = new Set();
  for (const m of diffedMutations) {
    if (m.op === "upsert_entity" || m.op === "delete_entity") {
      if (m.id) touchedEntityIds.add(m.id);
    } else if (m.op === "upsert_edge" || m.op === "delete_edge") {
      const existingEdge = m.id ? edgeMap.get(m.id) : undefined;
      const sourceId = m.data?.sourceId ?? existingEdge?.sourceId;
      const targetId = m.data?.targetId ?? existingEdge?.targetId;
      if (sourceId) touchedEntityIds.add(sourceId);
      if (targetId) touchedEntityIds.add(targetId);
    }
  }
  const resolvedPendingEntries = resolvedIdsWithEntries
    .filter((entityId) => touchedEntityIds.has(entityId))
    .map((entityId) => ({
      regionId: RESOLVE_REGION_ID,
      entityId,
      entryIds: entryIdsByEntity.get(entityId)
    }));
  const batch = createBatch(
    world,
    { mode: "resolve-pending", requestedEntityId, depth, maxNeighbors },
    elapsedTimeDescriptor,
    diffedMutations,
    { makeId: () => batchId, resolvedPendingEntries }
  );

  // 7. Lock the resolved entries out of a second concurrent resolve while
  // this batch is pending review. Task 14.3: iterate resolvedPendingEntries
  // (the filtered, genuinely-touched set), not entryIdsByEntity (every
  // entity folded in as context) -- an entity that received zero mutations
  // was never actually proposed against, so it must stay fully 'pending'
  // and available for a future resolve, not locked into 'proposed' with no
  // accept/reject outcome that will ever unlock it again (applyLedgerOutcome
  // only ever visits entities present in resolvedPendingEntries).
  for (const record of resolvedPendingEntries) {
    markProposed(world, record.entityId, record.entryIds);
  }

  const summary = summarizeBatch(batch);
  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    resolvedEntityIds: resolvedIdsWithEntries,
    cappedNeighborCount: cappedNeighborIds.length,
    excludedNeighborCount,
    headline: renderHeadline(summary)
  };
}
