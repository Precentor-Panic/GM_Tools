/**
 * Shared review-workflow operations — the actual business logic behind
 * wf-mcp-server's wf_accept/wf_reject/wf_regenerate/wf_sync_to_foundry/
 * wf_rollback_batch/wf_review_batch tools, extracted (Phase 6) so
 * review-ui/server.mjs can call the EXACT same code path instead of
 * re-deriving it against a second, drifting copy — per gm-tools-conventions'
 * "front-ends are thin wrappers, never logic duplicators" and the same
 * reasoning time-skip/run.mjs's own doc comment already gives for
 * orchestrateBatch/attachDiffs ("reusable by any front-end (wf-mcp-server
 * today, a future review-ui/) without duplicating the orchestration logic").
 *
 * Every exported function here takes already-resolved `dir`/`w` (a plain
 * data directory path and world id — see ./resolve.mjs) rather than the raw
 * optional args a tool/route receives, and returns a plain JS object shaped
 * exactly like what wf-mcp-server's tool handlers used to build inline and
 * hand to `text()` — callers (an MCP tool handler, an HTTP route handler)
 * decide how to serialize/frame that object, not this module.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

import { loadSnapshot, mutationsPath, snapshotFilePath } from "./snapshot.mjs";

import { textureRegion } from "../../mutation-engine/texture.mjs";
import { loadBatch, saveBatch, updateMutationStatus } from "../../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline, renderRegionDiff, renderEntityDiff } from "../../mutation-engine/grain.mjs";
import { acceptMutations, rollbackBatch } from "../../mutation-engine/rollback.mjs";
import { applyLedgerOutcome } from "../../mutation-engine/pending-ledger.mjs";
import { narrateBatch } from "../../mutation-engine/narrate.mjs";
import { applyHeadless } from "../../graph-import/headless-apply.mjs";
import {
  importWriteup,
  regenerateWriteupImport,
  WriteupImportRegenerateScopeError
} from "../../graph-import/writeup-import.mjs";
import {
  markHumanReviewed,
  recordUnreviewedAccept,
  findUnreviewedEntities
} from "../../mutation-engine/human-review.mjs";

// --- small pure helpers --------------------------------------------------

/** Resolve a batch-scoped set of mutationIds for accept/reject/regenerate. */
export function resolveMutationIds(batch, scope, id) {
  if (scope === "batch") return batch.mutations.map((m) => m.mutationId);
  if (scope === "region") {
    if (!id) throw new Error("scope='region' requires id (the regionId)");
    return batch.mutations
      .filter((m) => (m.regionId ?? `solo-${m.mutationId}`) === id)
      .map((m) => m.mutationId);
  }
  if (scope === "entity") {
    if (!id) throw new Error("scope='entity' requires id (a mutationId or target entity/edge id)");
    return batch.mutations.filter((m) => m.mutationId === id || m.id === id).map((m) => m.mutationId);
  }
  throw new Error(`Unknown scope: ${scope}`);
}

/**
 * The target entity/edge ids (`m.id`) touched by a set of mutationIds
 * within a batch — the unit human-review.mjs tracks against. Falsy ids
 * (an unsynced create with no id yet) are filtered out; markHumanReviewed/
 * recordUnreviewedAccept already no-op on those too, this just avoids
 * passing them through at all.
 */
export function entityIdsForMutations(batch, mutationIds) {
  const idSet = new Set(mutationIds);
  return batch.mutations.filter((m) => idSet.has(m.mutationId)).map((m) => m.id).filter(Boolean);
}

/** The Set summarizeBatch's flaggedEntityIds opt expects, built from findUnreviewedEntities(). */
export function flaggedEntityIdSet(world) {
  return new Set(findUnreviewedEntities(world).map((f) => f.entityId));
}

/** Next unused m<N> mutationId index in a batch, for appending regenerated mutations. */
export function nextMutationIndex(batch) {
  let max = -1;
  for (const m of batch.mutations) {
    const match = /^m(\d+)$/.exec(m.mutationId ?? "");
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max + 1;
}

// --- Foundry file-bridge apply (live, with headless fallback) -----------

/**
 * Write mutations to the file bridge and poll briefly for the in-Foundry
 * watcher to pick them up.
 */
export async function applyMutationsToFoundry(dir, w, mutations) {
  const path = mutationsPath(dir, w);
  writeFileSync(path, JSON.stringify(mutations, null, 2), "utf8");

  // The watcher clears the file back to "[]" once applied. Poll briefly.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!existsSync(path)) break;
    const contents = readFileSync(path, "utf8").trim();
    if (contents === "[]") {
      return { status: "applied", count: mutations.length, path };
    }
  }
  return {
    status: "queued",
    count: mutations.length,
    path,
    note: "Not confirmed applied within 7s — check that a Foundry client has this world open with World Fabric active."
  };
}

/**
 * Apply a mutations array via the live-Foundry file bridge first; if no live
 * client picks it up within the poll window, fall back to
 * graph-import/headless-apply.mjs's applyHeadless() against the standalone
 * snapshot directly. Shared by wf_sync_to_foundry/wf_rollback_batch (Phase
 * 4) and now review-ui's sync/rollback routes (Phase 6) so the
 * live-then-headless behavior isn't duplicated a third time.
 *
 * @returns {{path:'live'|'headless', liveResult:object, headlessResult?:object, snapshotPath?:string}}
 */
export async function applyMutationsWithHeadlessFallback(dir, w, mutations) {
  const liveResult = await applyMutationsToFoundry(dir, w, mutations);
  if (liveResult.status === "applied") {
    return { path: "live", liveResult };
  }
  const snapshotPath = snapshotFilePath(dir, w);
  const headlessResult = applyHeadless(snapshotPath, mutations);
  return { path: "headless", liveResult, headlessResult, snapshotPath };
}

/**
 * Write applyHeadless()'s reported `idAssignments` (keyed by position in the
 * mutations array it received) back onto the originating batch's stored
 * mutation entries, keyed instead by mutationId. Mutates `batch.mutations`
 * in place; the caller still owns saveBatch().
 *
 * @param {object} batch
 * @param {object[]} orderedSourceEntries   StoredMutation entries, same order/length as the mutations array applyHeadless() received
 * @param {Object<string,string>} idAssignments   applyHeadless()'s returned idAssignments
 * @returns {Object<string,string>} {mutationId: assignedId} for whatever this call actually wrote back
 */
export function writeBackIdAssignments(batch, orderedSourceEntries, idAssignments) {
  const written = {};
  if (!idAssignments) return written;
  for (const [indexStr, assignedId] of Object.entries(idAssignments)) {
    const sourceEntry = orderedSourceEntries[Number(indexStr)];
    if (!sourceEntry) continue; // defensive: shouldn't happen, index always came from the same-length array we built
    const entry = batch.mutations.find((m) => m.mutationId === sourceEntry.mutationId);
    if (!entry) continue;
    entry.id = assignedId;
    written[sourceEntry.mutationId] = assignedId;
  }
  return written;
}

// --- review-grain (headline/region/entity rendering + human-review marking) ---

/**
 * Render the requested detail level for a batch, marking human-review as a
 * side effect at region/entity grain (never at headline grain — see
 * grain.mjs/human-review.mjs's own doc comments for why).
 */
export function reviewGrainOp(w, { batchId, grain, regionId, entityId }) {
  const batch = loadBatch(w, batchId);
  const summary = summarizeBatch(batch, { flaggedEntityIds: flaggedEntityIdSet(w) });

  if (grain === "headline") {
    return { rendered: renderHeadline(summary), summary };
  }
  if (grain === "region") {
    if (!regionId) throw new Error("grain='region' requires regionId");
    const region = summary.regions.find((r) => r.regionId === regionId);
    if (!region) throw new Error(`No region "${regionId}" in batch "${batchId}"`);
    markHumanReviewed(w, region.entities.map((e) => e.entityId));
    return { rendered: renderRegionDiff(region), region };
  }
  if (grain === "entity") {
    if (!entityId) throw new Error("grain='entity' requires entityId");
    const entity = summary.regions
      .flatMap((r) => r.entities)
      .find((e) => e.mutationId === entityId || e.entityId === entityId);
    if (!entity) throw new Error(`No entity "${entityId}" in batch "${batchId}"`);
    markHumanReviewed(w, [entity.entityId]);
    return { rendered: renderEntityDiff(entity), entity };
  }
  throw new Error(`Unknown grain: ${grain}`);
}

// --- accept / reject -----------------------------------------------------

/**
 * Accept an arbitrary set of mutationIds within a batch, with EXPLICIT
 * control (via `reviewedMutationIds`) over which of them count as a genuine
 * human review (`markHumanReviewed`) vs. an unreviewed accept-all
 * (`recordUnreviewedAccept`) — Phase 4 task 4.2's distinction, generalized
 * (Phase 6) from "batch scope = never reviewed, region/entity scope = always
 * reviewed" to a per-mutation split, because review-ui's checkbox
 * multi-select accept can genuinely mix the two in one call (some checked
 * rows were individually expanded/read first, some were only swept in via
 * "Select All Boring"). Defaults `reviewedMutationIds` to `mutationIds`
 * (everything counts as reviewed) when omitted, matching every EXISTING
 * caller's behavior (acceptOp below always passes it explicitly either way).
 *
 * @param {string} w
 * @param {string} batchId
 * @param {string[]} mutationIds
 * @param {object} opts
 * @param {object[]} opts.entities             live snapshot, for pre-state capture
 * @param {object[]} opts.edges
 * @param {string[]} [opts.reviewedMutationIds] subset of mutationIds that count as genuinely reviewed
 */
export function acceptMutationIds(w, batchId, mutationIds, opts = {}) {
  const { entities, edges, reviewedMutationIds } = opts;
  const batch = loadBatch(w, batchId);
  const updated = acceptMutations(w, batchId, mutationIds, entities ?? [], edges ?? []);
  // Phase 3.5 task 3.5.4: if this batch resolves any pending-ledger entries,
  // accepting clears them — they're now real, reviewed graph mutations.
  const ledgerResolved = applyLedgerOutcome(updated, mutationIds, "accepted");

  const reviewedSet = new Set(reviewedMutationIds ?? mutationIds);
  const reviewedIds = mutationIds.filter((id) => reviewedSet.has(id));
  const unreviewedIds = mutationIds.filter((id) => !reviewedSet.has(id));
  // Phase 4 task 4.2: a genuinely-reviewed mutation updates lastHumanReviewedAt;
  // one accepted without review accumulates the unreviewed count instead —
  // never both for the same mutation.
  if (reviewedIds.length) markHumanReviewed(w, entityIdsForMutations(batch, reviewedIds));
  if (unreviewedIds.length) recordUnreviewedAccept(w, entityIdsForMutations(batch, unreviewedIds));

  return {
    batchId,
    accepted: mutationIds,
    batchStatus: updated.status,
    ...(ledgerResolved.length ? { ledgerResolved } : {})
  };
}

/** MCP-tool-shaped wrapper: resolves scope -> mutationIds, preserves wf_accept's exact original behavior (scope='batch' never reviewed, 'region'/'entity' always reviewed). */
export async function acceptOp(dir, w, { batchId, scope, id }) {
  const batch = loadBatch(w, batchId);
  const mutationIds = resolveMutationIds(batch, scope, id);
  if (!mutationIds.length) throw new Error(`No mutations matched scope="${scope}" id="${id ?? ""}"`);
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  return acceptMutationIds(w, batchId, mutationIds, {
    entities,
    edges,
    reviewedMutationIds: scope === "batch" ? [] : mutationIds
  });
}

/** Same generalization as acceptMutationIds, for reject (see its own doc comment). Reject never accumulates an unreviewed-accept count (nothing was applied to the graph), so there's no unreviewedMutationIds branch to handle beyond simply not marking those reviewed. */
export function rejectMutationIds(w, batchId, mutationIds, opts = {}) {
  const { reviewedMutationIds } = opts;
  const batch = loadBatch(w, batchId);
  let updated;
  for (const mutationId of mutationIds) updated = updateMutationStatus(w, batchId, mutationId, "rejected");
  // Phase 3.5 task 3.5.4: reject reverts any resolved ledger entries back to
  // 'pending' — the underlying debt is real and must not silently vanish
  // just because this particular resolution attempt was rejected.
  const ledgerReverted = applyLedgerOutcome(updated, mutationIds, "rejected");

  const reviewedSet = new Set(reviewedMutationIds ?? mutationIds);
  const reviewedIds = mutationIds.filter((id) => reviewedSet.has(id));
  if (reviewedIds.length) markHumanReviewed(w, entityIdsForMutations(batch, reviewedIds));

  return {
    batchId,
    rejected: mutationIds,
    batchStatus: updated.status,
    ...(ledgerReverted.length ? { ledgerReverted } : {})
  };
}

/** MCP-tool-shaped wrapper: resolves scope -> mutationIds, preserves wf_reject's exact original behavior. */
export function rejectOp(w, { batchId, scope, id }) {
  const batch = loadBatch(w, batchId);
  const mutationIds = resolveMutationIds(batch, scope, id);
  if (!mutationIds.length) throw new Error(`No mutations matched scope="${scope}" id="${id ?? ""}"`);
  return rejectMutationIds(w, batchId, mutationIds, { reviewedMutationIds: scope === "batch" ? [] : mutationIds });
}

// --- regenerate ------------------------------------------------------------

export async function regenerateOp(dir, w, { batchId, scope, id, note }) {
  const batch = loadBatch(w, batchId);
  const mutationIds = resolveMutationIds(batch, scope, id);
  if (!mutationIds.length) throw new Error(`No mutations matched scope="${scope}" id="${id ?? ""}"`);
  const targeted = batch.mutations.filter((m) => mutationIds.includes(m.mutationId));

  const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;

  // Phase 5 dispatch: a writeup-import batch's mutations aren't
  // texture.mjs candidateDeltas -- regenerating them means re-running the
  // whole extraction pass, not per-region texturing.
  const writeupImportCount = targeted.filter((m) => m.sourceKind === "writeup-import").length;
  if (writeupImportCount > 0) {
    if (writeupImportCount !== targeted.length) {
      throw new Error(
        `Regenerate scope="${scope}" id="${id ?? ""}" targets a mix of writeup-import and non-writeup-import ` +
        `mutations in batch "${batchId}" -- this should be impossible (a batch is only ever produced by one ` +
        `producer) and isn't handled. Investigate the batch file rather than proceeding.`
      );
    }
    if (scope === "entity") {
      throw new WriteupImportRegenerateScopeError(
        "regenerate scope='entity' is not supported for a writeup-import batch: writeup extraction is a single " +
        "holistic pass over the whole source text, not a per-entity delta, so there's no principled way to " +
        "regenerate just one extracted item without re-running (and replacing) the whole batch. Use scope='batch' " +
        "(or 'region' -- a writeup-import batch always has exactly one region) instead, or reject the specific " +
        "mutation and keep the rest."
      );
    }

    const { mutations: regenerated, summary: importSummary, suggestions } = await regenerateWriteupImport(
      batch,
      note,
      { entities, edges, entityTypes },
      {}
    );

    let nextIdx = nextMutationIndex(batch);
    const newMutations = regenerated.map((m) => ({ ...m, mutationId: `m${nextIdx++}`, status: "pending" }));

    batch.mutations = batch.mutations.filter((m) => !mutationIds.includes(m.mutationId));
    batch.mutations.push(...newMutations);
    const saved = saveBatch(w, batch);

    if (scope !== "batch") {
      const touchedEntityIds = [...new Set(targeted.map((m) => m.id).filter(Boolean))];
      markHumanReviewed(w, touchedEntityIds);
    }

    return {
      batchId,
      replaced: mutationIds,
      regenerated: newMutations.map((m) => m.mutationId),
      batchStatus: saved.status,
      importSummary,
      suggestions
    };
  }

  // Group by original regionId so regeneration still costs one API call per
  // region, not one per mutation (same cost-control behavior as the
  // original propose pass).
  const byRegion = new Map();
  for (const m of targeted) {
    const key = m.regionId ?? `solo-${m.mutationId}`;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(m);
  }

  const newMutations = [];
  let nextIdx = nextMutationIndex(batch);
  for (const [regionId, entries] of byRegion) {
    const entityIds = [...new Set(entries.map((m) => m.id).filter(Boolean))];
    const deltas = entries.map((m) => ({
      kind: m.sourceKind === "ambient-decay" ? "ambient-decay" : "seed-propagated",
      entityId: m.id,
      edgeId: m.op.includes("edge") ? m.id : undefined,
      impactScore: m.impactScore ?? 0.5,
      needsLLM: true
    }));
    const sourceKind = entries[0].sourceKind ?? "manual";
    const regionMutations = await textureRegion(
      { regionId, entityIds, deltas },
      { entities, edges, world: w, batchId, sourceKind, elapsedTimeDescriptor: batch.elapsedTimeDescriptor, note },
      {}
    );
    for (const rm of regionMutations) {
      newMutations.push({ ...rm, mutationId: `m${nextIdx++}`, status: "pending" });
    }
  }

  batch.mutations = batch.mutations.filter((m) => !mutationIds.includes(m.mutationId));
  batch.mutations.push(...newMutations);
  const saved = saveBatch(w, batch);

  if (scope !== "batch") {
    const touchedEntityIds = [...new Set(targeted.map((m) => m.id).filter(Boolean))];
    markHumanReviewed(w, touchedEntityIds);
  }

  return {
    batchId,
    replaced: mutationIds,
    regenerated: newMutations.map((m) => m.mutationId),
    batchStatus: saved.status
  };
}

// --- narrate ---------------------------------------------------------------

export async function narrateOp(w, { batchId, note, currentLocation, reachableAreas }) {
  const batch = loadBatch(w, batchId);
  return narrateBatch(batch, { world: w, note, currentLocation, reachableAreas }, {});
}

// --- sync / rollback --------------------------------------------------------

export async function syncOp(dir, w, { batchId }) {
  const batch = loadBatch(w, batchId);
  const accepted = batch.mutations.filter((m) => m.status === "accepted");
  if (!accepted.length) {
    return { status: "no-op", batchId, note: "No mutations in this batch have status 'accepted'." };
  }
  const mutations = accepted.map((m) => ({ op: m.op, id: m.id, data: m.data }));

  const { path, liveResult, headlessResult, snapshotPath } = await applyMutationsWithHeadlessFallback(dir, w, mutations);

  if (path === "live") {
    batch.status = "synced";
    saveBatch(w, batch);
    const { path: mutationsFilePath, ...rest } = liveResult;
    return { path: "live", ...rest, mutationsFilePath, batchId, syncedCount: accepted.length };
  }

  const idAssignments = writeBackIdAssignments(batch, accepted, headlessResult.idAssignments);
  batch.status = "synced";
  saveBatch(w, batch);
  return {
    path: "headless",
    status: "applied",
    batchId,
    syncedCount: accepted.length,
    snapshotPath,
    liveAttempt: liveResult,
    summary: headlessResult.summary,
    deletedEntityCount: headlessResult.deletedEntityCount,
    deletedEdgeCount: headlessResult.deletedEdgeCount,
    skipped: headlessResult.skipped,
    ...(Object.keys(idAssignments).length ? { idAssignments } : {}),
    note:
      "No live Foundry client picked up the mutation within the poll window; applied directly to the standalone " +
      "snapshot instead. If a live Foundry client for this world reopens later, its own export will overwrite " +
      "this file from game.settings -- no reconciliation path exists yet for a mixed live/headless world."
  };
}

export async function rollbackOp(dir, w, { batchId }) {
  const { restoreMutations, skipped } = rollbackBatch(w, batchId);
  if (!restoreMutations.length) {
    return { batchId, status: "no-op", skipped, note: "No restorable accepted mutations found." };
  }
  const { path, liveResult, headlessResult, snapshotPath } = await applyMutationsWithHeadlessFallback(dir, w, restoreMutations);

  if (path === "live") {
    const { path: mutationsFilePath, ...rest } = liveResult;
    return { path: "live", ...rest, mutationsFilePath, batchId, restoredCount: restoreMutations.length, skipped };
  }

  return {
    path: "headless",
    status: "applied",
    batchId,
    restoredCount: restoreMutations.length,
    snapshotPath,
    liveAttempt: liveResult,
    summary: headlessResult.summary,
    deletedEntityCount: headlessResult.deletedEntityCount,
    deletedEdgeCount: headlessResult.deletedEdgeCount,
    skipped,
    note:
      "No live Foundry client picked up the rollback within the poll window; applied directly to the standalone " +
      "snapshot instead. If a live Foundry client for this world reopens later, its own export will overwrite " +
      "this file from game.settings -- no reconciliation path exists yet for a mixed live/headless world."
  };
}

export { WriteupImportRegenerateScopeError };
