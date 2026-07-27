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
import { loadBatch, saveBatch, updateMutationStatus, listBatches } from "../../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline, renderRegionDiff, renderEntityDiff } from "../../mutation-engine/grain.mjs";
import { acceptMutations, rollbackBatch } from "../../mutation-engine/rollback.mjs";
import { applyLedgerOutcome } from "../../mutation-engine/pending-ledger.mjs";
import { narrateBatch, narrateEntity } from "../../mutation-engine/narrate.mjs";
import { supersedeEntityNarration, getCurrentEntityNarration, getEntityNarrationHistory } from "../../mutation-engine/entity-narration.mjs";
// Phase 11 task 11.4: staleness-on-remutation reuses this SAME accept choke
// point (acceptMutationIds below) that Phase 10 task 10.3 already used for
// narration invalidation -- a clean fit, no second hook point added.
import { markPrepContentStale } from "../../mutation-engine/prep-content.mjs";
import { applyHeadless } from "../../graph-import/headless-apply.mjs";
import {
  importWriteup,
  regenerateWriteupImport,
  proposeFramingsFromWriteup,
  composeFramingNote,
  recordFramingRound,
  resolveRejectLoop,
  QUICK_PICK_REASONS,
  MAX_FRAMING_ROUNDS,
  WriteupImportRegenerateScopeError,
  FramingRoundLimitError
} from "../../graph-import/writeup-import.mjs";
import {
  markHumanReviewed,
  recordUnreviewedAccept,
  findUnreviewedEntities
} from "../../mutation-engine/human-review.mjs";
import { getUserSettings } from "../../mutation-engine/user-settings.mjs";
// Phase 12 task 12.5 -- scan for mentioned entities. Phase 13 task 13.3
// reuses DEFAULT_MENTION_RELATIONSHIP for the SAME default a fresh link
// mutation would have carried, rather than inventing a second default.
import { scanForMentionedEntities, DEFAULT_MENTION_RELATIONSHIP } from "../../graph-import/scan-mentions.mjs";

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

  // Phase 10 task 10.3: an entity just accepted again is, by definition,
  // being mutated again -- any narration that was 'current' for it now
  // describes a stale prior state, not what's actually true anymore. Mark
  // it superseded (never deleted -- still recallable from history) so
  // review-ui never shows a stale narration as if it were current. A safe
  // no-op for an entity that was never narrated. Runs regardless of
  // reviewedMutationIds/unreviewedMutationIds split below -- the entity was
  // mutated either way; whether a HUMAN reviewed it is an orthogonal
  // concern (human-review.mjs's own tracking), not a reason to keep an
  // otherwise-stale narration presenting as current.
  for (const entityId of entityIdsForMutations(batch, mutationIds)) {
    supersedeEntityNarration(w, entityId);
  }

  // Phase 11 task 11.4: the same reasoning as the narration supersede just
  // above, applied to prep content instead -- an entity just accepted again
  // has its CORE fields mutated, so any existing PrepContent may no longer
  // reflect its current state. markPrepContentStale flips status only
  // (never touches `fields`) and is a safe no-op for an entity with no prep
  // content at all -- fires regardless of accept scope, same as the
  // narration hook, since the entity was mutated either way.
  for (const entityId of entityIdsForMutations(batch, mutationIds)) {
    markPrepContentStale(w, entityId);
  }

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

// --- Phase 8: rubber-duck mode ----------------------------------------------

/**
 * wf_propose_from_writeup's actual dispatch logic (Phase 8 task 8.4) --
 * shared verbatim by the MCP tool and review-ui's route, per this module's
 * own "front-ends are thin wrappers" convention.
 *
 * THE READ-ONCE INVARIANT: getUserSettings() is called EXACTLY ONCE here, at
 * the moment of writeup submission -- never again anywhere else in this
 * phase's code for this batch's lifetime. When rubber-duck mode is off, this
 * is a straight pass-through to importWriteup() with no wrapping and no
 * extra fields -- byte-identical to Phase 5's existing single-shot
 * behavior. When it's on, phase A returns only the 3 framings (no batch
 * created yet) plus the read settings snapshot, carried forward by the
 * caller to selectFramingForNewBatch below rather than re-read there.
 *
 * @param {string} dir
 * @param {string} w
 * @param {{text:string, mode?:"merge"|"replace"}} args
 * @returns {Promise<object>} either importWriteup()'s own result shape (rubber-duck off) or
 *   {phase:'framing', framings, writeupText, mode, rubberDuck} (rubber-duck on)
 */
export async function proposeFromWriteupOp(dir, w, { text: writeupText, mode }) {
  const settings = getUserSettings(); // READ ONCE -- see this function's own doc comment
  if (!settings.rubberDuckMode.enabled) {
    const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;
    return importWriteup(w, writeupText, { entities, edges, entityTypes }, { mode });
  }
  const { framings } = await proposeFramingsFromWriteup(writeupText, {});
  return {
    phase: "framing",
    framings,
    writeupText,
    mode: mode ?? "merge",
    rubberDuck: { enabled: true, updatedAt: settings.rubberDuckMode.updatedAt }
  };
}

/**
 * wf_select_framing's "no batchId" branch: the reviewer's very first
 * framing pick, right after proposeFromWriteupOp's phase A. Composes the
 * note (composeFramingNote), runs the EXISTING importWriteup() unchanged
 * except for that composed note, and records the completed framing round
 * (framingHistory entry #1) on the freshly-created batch.
 *
 * `rubberDuck` must be the EXACT snapshot object echoed back by phase A --
 * this function does NOT call getUserSettings() itself (the read-once
 * invariant: a mid-review toggle flip between phase A and this call must
 * not retroactively change what gets stamped on the new batch).
 *
 * @param {string} dir
 * @param {string} w
 * @param {{writeupText:string, mode?:string, framings:Array, selection:object, rubberDuck:{enabled:boolean, updatedAt:string|null}}} args
 */
export async function selectFramingForNewBatch(dir, w, { writeupText, mode, framings, selection, rubberDuck }) {
  if (!rubberDuck || typeof rubberDuck.enabled !== "boolean") {
    throw new Error(
      "selectFramingForNewBatch requires `rubberDuck` -- the settings snapshot echoed back by " +
      "wf_propose_from_writeup's phase-A response, carried forward unchanged rather than re-read here."
    );
  }
  const note = composeFramingNote(selection);
  const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;
  const result = await importWriteup(w, writeupText, { entities, edges, entityTypes }, {
    mode,
    llmOpts: { note },
    extraScope: { rubberDuck }
  });
  const batch = loadBatch(w, result.batchId);
  recordFramingRound(batch, { framings, selection, note });
  const saved = saveBatch(w, batch);
  return { ...result, framingRound: saved.scope.framingHistory.length };
}

/**
 * wf_select_framing's "batchId given" branch: the reviewer's pick after a
 * plain-reject-triggered re-framing round (see rejectWithLoopOp below).
 * Reuses the EXISTING regenerateOp (its writeup-import scope='batch'
 * dispatch) unchanged, then records the completed re-framing round
 * (framingHistory entry #2) -- this is what actually enforces the "bounded
 * to one round" property end-to-end: MAX_FRAMING_ROUNDS is checked against
 * framingHistory.length, which only grows here and in
 * selectFramingForNewBatch above, never anywhere else.
 *
 * DEFENSE IN DEPTH (self-review remediation): requestReframing (in
 * writeup-import.mjs) is the primary bound check -- it refuses to spend an
 * LLM call minting a NEW round of framings once the budget is spent. But
 * that alone leaves a gap: nothing stopped a caller from invoking THIS
 * function directly, more than once, with an old/reused `framings` array
 * that never went through requestReframing at all (e.g. replaying an old
 * MCP tool call), which would silently push framingHistory.length past
 * MAX_FRAMING_ROUNDS purely by committing rounds, never by requesting new
 * ones. Guarded here too so the bound holds regardless of entry path, not
 * just against a well-behaved caller that always calls wf_reject first.
 *
 * @param {string} dir
 * @param {string} w
 * @param {{batchId:string, framings:Array, selection:object}} args
 */
export async function selectFramingForExistingBatch(dir, w, { batchId, framings, selection }) {
  const preBatch = loadBatch(w, batchId);
  if (!preBatch.scope?.rubberDuck?.enabled) {
    throw new Error(
      `Batch "${batchId}" was not created with rubber-duck mode on (batch.scope.rubberDuck.enabled is not true) ` +
      `-- re-framing an existing batch only applies to a rubber-duck-mode writeup-import batch.`
    );
  }
  const priorRounds = preBatch.scope?.framingHistory?.length ?? 0;
  if (priorRounds >= MAX_FRAMING_ROUNDS) {
    throw new FramingRoundLimitError(
      `Batch "${batchId}" has already used its one bounded re-framing round (framingHistory has ${priorRounds} ` +
      `entries, max ${MAX_FRAMING_ROUNDS}) -- cannot commit another framing round onto it.`
    );
  }
  const note = composeFramingNote(selection);
  const regenResult = await regenerateOp(dir, w, { batchId, scope: "batch", note });
  const batch = loadBatch(w, batchId);
  recordFramingRound(batch, { framings, selection, note });
  const saved = saveBatch(w, batch);
  return { ...regenResult, framingRound: saved.scope.framingHistory.length };
}

/**
 * The reject-loop's actual wiring (Phase 8 task 8.4): wf_reject / review-ui's
 * reject route both call THIS instead of the plain rejectOp, so the
 * dispatch is identical for both front-ends. Always marks the targeted
 * mutation(s) rejected first (via the EXISTING, unchanged rejectOp) --
 * rejecting is always real, regardless of what happens next.
 *
 * Three distinct outcomes, matching writeup-import.mjs's resolveRejectLoop
 * exactly (see that function's own doc comment for the full state machine):
 *   - not a rubber-duck writeup-import batch, OR scope='entity': the
 *     reject-loop never applies -- returns rejectOp's result completely
 *     unwrapped (no extra field), so normal mode's silent reject-and-wait,
 *     and an individual-mutation reject even in rubber-duck mode, are BOTH
 *     byte-identical to the pre-Phase-8 behavior.
 *   - rubber-duck batch, scope='batch'/'region', explicit note: rejectOp's
 *     result plus `rubberDuckLoop: {kind:'regenerate', ...}` -- the batch's
 *     mutations get replaced immediately via the existing regenerateOp,
 *     never touching the framing path.
 *   - rubber-duck batch, scope='batch'/'region', quickPickReason, budget
 *     available: rejectOp's result plus `rubberDuckLoop: {kind:'reframe',
 *     framings}` -- no batch mutation replace yet; the caller still needs to
 *     call selectFramingForExistingBatch once the reviewer picks one.
 *   - same, but the bounded round budget is already spent: throws
 *     FramingRoundLimitError (propagates to the caller's own error mapping;
 *     review-ui maps this to a 409, see server.mjs's statusForError).
 *
 * @param {string} dir
 * @param {string} w
 * @param {{batchId:string, scope:'batch'|'region'|'entity', id?:string, note?:string, quickPickReason?:string}} args
 */
export async function rejectWithLoopOp(dir, w, { batchId, scope, id, note, quickPickReason }) {
  const batch = loadBatch(w, batchId);
  const isRubberDuckWriteupBatch =
    !!batch.scope?.rubberDuck?.enabled &&
    batch.mutations.length > 0 &&
    batch.mutations.every((m) => m.sourceKind === "writeup-import");
  // Deliberately batch/region only, mirroring regenerateWriteupImport's own
  // whole-batch-only design (a writeup-import batch always has exactly one
  // region -- see writeup-import.mjs's own top-of-file note) -- rejecting a
  // SINGLE entity out of an extraction isn't "I don't like this whole first
  // pass," it's discarding one item, and stays a normal, unlooped reject
  // even in rubber-duck mode.
  const loopEligibleScope = scope === "batch" || scope === "region";

  if (!isRubberDuckWriteupBatch || !loopEligibleScope) {
    return rejectOp(w, { batchId, scope, id });
  }

  if (!note && !quickPickReason) {
    throw new Error(
      `Batch "${batchId}" is a rubber-duck-mode writeup-import batch. A scope='${scope}' reject requires either ` +
      `\`note\` (an explicit reason -- skips straight to regenerate) or \`quickPickReason\` (one of: ` +
      `${Object.keys(QUICK_PICK_REASONS).join(", ")} -- triggers a new bounded framing round).`
    );
  }

  const baseResult = rejectOp(w, { batchId, scope, id });
  const decision = await resolveRejectLoop(batch, { note, quickPickReason }, {});

  if (decision.kind === "regenerate") {
    const regenResult = await regenerateOp(dir, w, { batchId, scope: "batch", note: decision.note });
    return {
      ...baseResult,
      rubberDuckLoop: {
        kind: "regenerate",
        note: decision.note,
        regenerated: regenResult.regenerated,
        batchStatus: regenResult.batchStatus
      }
    };
  }

  return { ...baseResult, rubberDuckLoop: { kind: "reframe", framings: decision.framings } };
}

// --- Phase 12 task 12.5: scan for mentioned entities -----------------------

/**
 * review-ui's "Scan for mentioned entities" trigger (the entity content-
 * generation panel's own button, and the node popover's "Scan this node's
 * content" shortcut — same underlying action per the design doc, two entry
 * points). Loads the live snapshot itself (same layering as
 * proposeFromWriteupOp above) so scan-mentions.mjs stays Foundry/file-bridge
 * agnostic, matching every other library module's own convention.
 *
 * @param {string} dir
 * @param {string} w
 * @param {{entityId:string, text:string}} args
 */
export async function scanMentionsOp(dir, w, { entityId, text }) {
  const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;
  return scanForMentionedEntities(w, entityId, text, { entities, edges, entityTypes });
}

/**
 * Edit a still-PENDING mutation's own `data` fields before accept -- task
 * 12.5's "editable relationship-type dropdown" requirement for a
 * scan-for-mentioned-entities LINK row, generalized as a small reusable
 * primitive rather than a scan-mentions-specific one-off (the same
 * capability is reasonable for any pending mutation's data, not just this
 * one field on this one batch kind). Refuses to touch anything but a
 * pending mutation -- an accepted/rejected/rolled-back mutation is already
 * settled, editing it after the fact would be silently rewriting history.
 *
 * @param {string} w
 * @param {{batchId:string, mutationId:string, data:object}} args  `data` is merged onto the mutation's existing data (partial patch)
 * @returns {object} the updated batch
 */
export function patchPendingMutationData(w, { batchId, mutationId, data }) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("patchPendingMutationData requires a `data` object.");
  }
  const batch = loadBatch(w, batchId);
  const entry = batch.mutations.find((m) => m.mutationId === mutationId);
  if (!entry) throw new Error(`No mutation with mutationId="${mutationId}" in batch "${batchId}" (world "${w}")`);
  if (entry.status !== "pending") {
    throw new Error(`Mutation "${mutationId}" is not pending (status: "${entry.status}") -- cannot edit its data.`);
  }
  entry.data = { ...(entry.data ?? {}), ...data };
  return saveBatch(w, batch);
}

/**
 * Phase 13 task 13.3: "Link to existing instead" -- a still-PENDING mention-
 * scan PROPOSE-NEW row (an `upsert_entity` create, `entityContext.
 * scanResultKind === 'new'`) is a real correction target when the scan
 * missed an existing-entity match; this converts it into a genuine LINK,
 * matching the same shape scan-mentions.mjs's own LINK branch would have
 * produced had it matched in the first place. Reuses regenerateOp's
 * established "swap one mutation for another within a batch" shape (see
 * that function's own doc comment) one level further specialized: instead
 * of an LLM call producing the replacement, the reviewer's own entity pick
 * does.
 *
 * The create mutation's OWN entry is converted IN PLACE (same mutationId,
 * so any client-side open/scroll state keyed by mutationId keeps working)
 * from `upsert_entity` into `upsert_edge` targeting the chosen existing
 * entity; the sibling edge mutation this same scan produced (the
 * `data.targetId === <this create's own id>` edge-to-the-would-be-new-
 * entity) is REMOVED entirely, since it referenced an entity that will now
 * never be created -- leaving exactly ONE mutation for this mention, a real
 * `upsert_edge` targeting the chosen existing id, not a modified create.
 *
 * Validates `existingEntityId` against the real live snapshot (matching
 * this project's own established defensive convention -- e.g.
 * manual-edit-ops.mjs's addEdgeOp validates sourceId/targetId the same
 * way) rather than trusting the caller: the frontend's own picker only ever
 * offers real fetched entities, but a direct/buggy caller shouldn't be able
 * to silently point a mutation at a nonexistent id.
 *
 * @param {string} dir
 * @param {string} w
 * @param {{batchId:string, mutationId:string, existingEntityId:string, existingEntityName?:string}} args
 * @returns {{batchId:string, mutationId:string, redirectedTo:string}}
 */
export function redirectMentionScanRowToExistingOp(dir, w, { batchId, mutationId, existingEntityId, existingEntityName }) {
  if (!existingEntityId) throw new Error("redirectMentionScanRowToExistingOp requires existingEntityId.");
  const { entities } = loadSnapshot(dir, w).snapshot;
  const existingEntity = entities.find((e) => e.id === existingEntityId);
  if (!existingEntity) {
    throw new Error(`No entity "${existingEntityId}" found in the live graph -- cannot redirect to a nonexistent entity.`);
  }
  const batch = loadBatch(w, batchId);
  if (batch.scope?.mode !== "mention-scan") {
    throw new Error(`Batch "${batchId}" is not a mention-scan batch -- "link to existing instead" only applies there.`);
  }
  const createEntry = batch.mutations.find((m) => m.mutationId === mutationId);
  if (!createEntry) throw new Error(`No mutation "${mutationId}" in batch "${batchId}".`);
  if (createEntry.op !== "upsert_entity" || createEntry.entityContext?.scanResultKind !== "new") {
    throw new Error(`Mutation "${mutationId}" is not a "propose new" entity row -- "link to existing instead" only applies to one of those.`);
  }
  if (createEntry.status !== "pending") {
    throw new Error(`Mutation "${mutationId}" is not pending (status: "${createEntry.status}") -- cannot redirect it.`);
  }

  const createdId = createEntry.id; // the not-yet-persisted id this create would have used
  const siblingEdge = batch.mutations.find(
    (m) => m.mutationId !== mutationId && m.op === "upsert_edge" && m.entityContext?.scanResultKind === "new" && m.data?.targetId === createdId
  );
  if (!siblingEdge) {
    throw new Error(`Could not find the paired edge mutation for "${mutationId}" in batch "${batchId}" -- the batch may be malformed.`);
  }
  const sourceEntityId = siblingEdge.data.sourceId;

  batch.mutations = batch.mutations.filter((m) => m.mutationId !== siblingEdge.mutationId);

  createEntry.op = "upsert_edge";
  createEntry.id = undefined;
  createEntry.data = {
    sourceId: sourceEntityId,
    targetId: existingEntityId,
    relationshipType: siblingEdge.data.relationshipType ?? DEFAULT_MENTION_RELATIONSHIP
  };
  createEntry.rationale = `Redirected: linked to the existing entity "${existingEntityName ?? existingEntity.name ?? existingEntityId}" instead of proposing a duplicate.`;
  createEntry.entityContext = {
    scanResultKind: "link",
    // Self-review remediation: the TARGET entity's own real name/type (same
    // convention scan-mentions.mjs's own LINK branch already uses), not the
    // stale mention's -- a GM redirecting to a genuinely different-typed
    // entity than what the LLM originally guessed must see that entity's
    // OWN real type reflected here, not a leftover label.
    name: existingEntity.name ?? existingEntityName ?? existingEntityId,
    type: existingEntity.type
  };
  createEntry.diff = undefined; // still pending (checked above), so no preState to worry about clearing either

  saveBatch(w, batch);
  return { batchId, mutationId, redirectedTo: existingEntityId };
}

// --- narrate ---------------------------------------------------------------

export async function narrateOp(w, { batchId, note, currentLocation, reachableAreas }) {
  const batch = loadBatch(w, batchId);
  return narrateBatch(batch, { world: w, note, currentLocation, reachableAreas }, {});
}

// --- Phase 10: per-entity narration -----------------------------------------

/**
 * wf_narrate_entity / review-ui's per-row "Narrate This" action (task 10.4):
 * the per-entity replacement review-ui now uses instead of narrateOp above.
 * Loads the live snapshot's entities/edges itself (mutation-engine/narrate.mjs
 * stays Foundry/file-bridge-agnostic, same layering as every other library
 * module) so narrateEntity() can ground the prompt in the target entity's
 * real immediate graph neighbors instead of an empty location/area pair.
 * Persistence (entity-narration.mjs's saveEntityNarration) happens INSIDE
 * narrateEntity() on success -- this wrapper adds no persistence logic of
 * its own, matching "front-ends are thin wrappers" even though this module
 * itself is shared library code, not a front-end.
 */
export async function narrateEntityOp(dir, w, { batchId, mutationId, note }) {
  const batch = loadBatch(w, batchId);
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  return narrateEntity(batch, mutationId, { world: w, entities, edges, note }, {});
}

// --- Task 14.7: "Narrate This" from the standalone entity page --------------

/**
 * Thrown by narrateEntityStandaloneOp when no batch has ever recorded an
 * accepted mutation for the requested entity -- mapped to a clean 404 by
 * review-ui/server.mjs's statusForError, matching every other typed-error
 * convention in this file (NarrationGateError, FramingRoundLimitError, ...).
 * The whole point of this class existing is task 14.7's hard requirement:
 * never silently do nothing when there's nothing narratable -- the caller
 * gets a real, catchable signal to show a clear message with, not a generic
 * 500 or an empty success response.
 */
export class NoNarratableBatchError extends Error {
  constructor(message, { entityId } = {}) {
    super(message);
    this.name = "NoNarratableBatchError";
    this.entityId = entityId;
  }
}

/**
 * The most recent (newest-first, per listBatches' own established order)
 * batch carrying an ACCEPTED mutation that genuinely targets this entity --
 * an upsert_entity/delete_entity op whose own `id` matches. Deliberately
 * excludes edge mutations that merely reference this entity as an endpoint:
 * task 14.7 is "narrate what changed about THIS entity," and an edge
 * mutation's own rationale is naturally framed around the relationship, not
 * this entity's own state -- narrateEntity's summary is built from exactly
 * the one targeted mutation, so picking an edge mutation here would produce
 * a narration that reads like it's about the wrong thing.
 */
function findMostRecentAcceptedMutationForEntity(w, entityId) {
  for (const summary of listBatches(w)) {
    const batch = loadBatch(w, summary.id);
    const entry = batch.mutations.find(
      (m) => m.id === entityId && (m.op === "upsert_entity" || m.op === "delete_entity") && m.status === "accepted"
    );
    if (entry) return { batch, mutationId: entry.mutationId };
  }
  return null;
}

/**
 * review-ui's standalone entity-detail page has no batch context of its own
 * to call narrateEntityOp with directly (unlike Batch Review's per-row
 * "Narrate This", which always knows its own batchId/mutationId) -- this is
 * the entity-page equivalent: look up the most recent batch/mutation that
 * genuinely addressed this entity and reuse narrateEntity() exactly as the
 * batch-scoped path already does (approach (a) from the task's own design
 * reasoning -- reuses existing infrastructure rather than inventing a
 * second, simpler-but-different kind of narration). No MCP tool wraps this
 * -- review-ui/server.mjs's standalone entity route is the only caller.
 */
export async function narrateEntityStandaloneOp(dir, w, { entityId, note }) {
  const found = findMostRecentAcceptedMutationForEntity(w, entityId);
  if (!found) {
    throw new NoNarratableBatchError(
      `No accepted mutation for entity "${entityId}" exists in any batch yet -- there's nothing to narrate. ` +
      `"Narrate This" describes what recently changed about an entity, so it needs at least one accepted ` +
      `mutation touching it first (via Batch Review, a manual edit, or an import that mentions it).`,
      { entityId }
    );
  }
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  return narrateEntity(found.batch, found.mutationId, { world: w, entities, edges, note }, {});
}

/** wf_get_entity_narration / review-ui's per-row narration fetch: the one entry with status:'current', or null if never narrated (or superseded with nothing to replace it yet). */
export function getEntityNarrationOp(w, { entityId }) {
  return { entityId, narration: getCurrentEntityNarration(w, entityId) };
}

/** wf_get_entity_narration_history / review-ui's "view history" affordance: the entity's FULL history, oldest-first as stored -- nothing is ever filtered out or deleted. */
export function getEntityNarrationHistoryOp(w, { entityId }) {
  return { entityId, history: getEntityNarrationHistory(w, entityId) };
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

export { WriteupImportRegenerateScopeError, FramingRoundLimitError };
