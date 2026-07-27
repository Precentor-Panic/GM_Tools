/**
 * Rollback — pure, Foundry-free, unit-testable.
 *
 * `acceptMutations` captures pre-mutation entity/edge state into the batch
 * record at accept-time (before the mutation is ever applied to the live
 * graph) — the caller supplies the current entities/edges (e.g. from
 * wf-mcp-server's loadSnapshot), since this module has no Foundry/file-bridge
 * access of its own per the module-layout convention (pure library code).
 *
 * `rollbackBatch` re-applies the captured pre-state for the **most-recently-
 * accepted batch only** (confirmed Phase-1 scope — no multi-batch version
 * history). It does not itself write to the World Fabric graph: rollback.mjs
 * is Foundry-free, so it computes and returns the restore-mutation array;
 * the caller (the wf_sync_to_foundry-style MCP tool, or a test's mocked
 * apply) is responsible for actually applying them, e.g. via
 * wf-mcp-server's existing wf_apply_mutations.
 *
 * Newly-created entities/edges (Phase 4 task 4.1): a mutation that *creates*
 * a brand-new entity/edge has no id known at accept-time — nothing assigns
 * one until the mutation is actually applied. `acceptMutations` below still
 * correctly captures `preState: null` for these (there is nothing to
 * restore-to; a rollback should delete, not restore-a-value), but
 * `rollbackBatch` can only turn that into a real delete once `entry.id` gets
 * filled in after the fact. For the headless path (`graph-import/
 * headless-apply.mjs`'s `applyHeadless`), that gap is closed: it now
 * pre-assigns and reports back the id it gives every id-less create, and
 * wf-mcp-server's `wf_sync_to_foundry` writes that id back onto the batch's
 * stored mutation entry before this module ever sees it again — by the time
 * `rollbackBatch` runs, `entry.id` is populated and it resolves to a real
 * delete_entity/delete_edge, same as any other created-entity case with a
 * known id. No code change was needed in this file itself for that — this
 * function already re-reads `entry.id` fresh off the loaded batch, it just
 * needed something upstream to have actually written it there.
 *
 * The live-Foundry path is a genuinely different story, confirmed by reading
 * both `graph-service.mjs`'s `startMutationWatcher`/`applyMutations` and
 * `wf-mcp-server/index.mjs`'s `applyMutationsToFoundry`: Foundry assigns the
 * created id server-side (`foundry.utils.randomID()`, inside the browser
 * session), but the mutation watcher never writes that id anywhere the file
 * bridge can read it back — it applies, flushes, and clears
 * world-fabric-mutations.json to `[]`, and that's the entire signal
 * `applyMutationsToFoundry` gets. Closing this would require a change to
 * World Fabric itself (e.g. the watcher writing a small id-assignment result
 * file alongside the mutations file), which is out of scope here — World
 * Fabric is a separate, read-only-for-this-phase project. A mutation created
 * via the live path (rather than synced headless) therefore still has no id
 * to target and is reported in the returned `skipped` array rather than
 * silently dropped or crashing — a real, confirmed, but currently unclosable
 * (from this side of the file bridge) limitation, not an oversight.
 */
import { loadBatch, saveBatch } from "./review-state.mjs";

/**
 * Mark a set of mutations within a batch as accepted, capturing each
 * target's current (pre-mutation) entity/edge state first.
 *
 * @param {string} world
 * @param {string} batchId
 * @param {string[]} mutationIds
 * @param {object[]} currentEntities  live snapshot entities, for pre-state capture
 * @param {object[]} currentEdges     live snapshot edges, for pre-state capture
 * @returns {object} the updated batch
 */
export function acceptMutations(world, batchId, mutationIds, currentEntities, currentEdges) {
  const batch = loadBatch(world, batchId);
  const entityMap = new Map(currentEntities.map((e) => [e.id, e]));
  const edgeMap = new Map(currentEdges.map((e) => [e.id, e]));

  for (const mutationId of mutationIds) {
    const entry = batch.mutations.find((m) => m.mutationId === mutationId);
    if (!entry) {
      throw new Error(`No mutation with mutationId="${mutationId}" in batch "${batchId}" (world "${world}")`);
    }
    const isEdgeOp = entry.op === "upsert_edge" || entry.op === "delete_edge";
    const source = isEdgeOp ? edgeMap : entityMap;
    const before = entry.id ? source.get(entry.id) : undefined;
    entry.preState = before ? structuredClone(before) : null;
    entry.status = "accepted";
  }

  return saveBatch(world, batch);
}

function deleteOpFor(op) {
  if (op === "upsert_entity") return "delete_entity";
  if (op === "upsert_edge") return "delete_edge";
  return op; // already a delete_* op, or something unexpected -- pass through rather than guess
}

/**
 * Compute the mutations needed to restore a batch's accepted entries to
 * their captured pre-accept state, and mark them rolled-back.
 *
 * Does NOT apply anything to the live graph itself (Foundry-free) — the
 * caller applies `restoreMutations` (e.g. via wf_apply_mutations).
 *
 * @param {string} world
 * @param {string} batchId
 * @returns {{batchId:string, restoreMutations:object[], skipped:Array<{mutationId:string, reason:string}>}}
 */
export function rollbackBatch(world, batchId) {
  const batch = loadBatch(world, batchId);
  const restoreMutations = [];
  const skipped = [];

  // Iterate in REVERSE chronological order when building restoreMutations
  // (task 14.1, QA-pass finding). headless-apply.mjs's mergedWfiRecord does
  // a shallow merge onto whatever the current state is AT APPLY TIME, and
  // multiple restore mutations targeting the same entity/edge id apply in
  // array order with the last one winning. Two accepted mutations touching
  // the same field on the same entity (e.g. a manual edit followed by its
  // own later undo, per Phase 13.1's auto-batching) each captured a
  // preState at their own accept time -- the EARLIER mutation's preState is
  // the truest "original" state, the LATER mutation's preState is merely
  // "the state right before that later edit" (less historical). Building
  // restoreMutations in original chronological order put the later (less
  // historical) preState last, so it won and silently left the earlier
  // change in place while still reporting every mutation rolled back.
  // Reversing means the earliest mutation's preState is pushed last, so it
  // applies last and correctly wins -- restoring the whole chain back to
  // the state before the FIRST mutation, not just before the last one.
  // Does not change which entries are considered "accepted" or their final
  // status, only the order restoreMutations are built in -- the common
  // single-mutation-per-entity case (each entry targets a distinct id) is
  // unaffected, since there's no collision for order to matter.
  for (const entry of [...batch.mutations].reverse()) {
    if (entry.status !== "accepted") continue;

    if (entry.preState === undefined) {
      skipped.push({
        mutationId: entry.mutationId,
        reason: "no captured pre-state -- this mutation was marked accepted without going through acceptMutations()"
      });
      continue;
    }

    if (entry.preState === null) {
      if (!entry.id) {
        skipped.push({
          mutationId: entry.mutationId,
          reason:
            "created entity/edge has no known id -- cannot target a delete for rollback. If this batch was " +
            "synced via wf_sync_to_foundry's headless path, the id should have been written back onto this " +
            "entry (Phase 4 task 4.1); if it wasn't (e.g. the batch was applied via the live-Foundry path, " +
            "which cannot report a created id back through the file bridge -- see this module's own doc " +
            "comment), it genuinely cannot be resolved from this side."
        });
        continue;
      }
      restoreMutations.push({
        op: deleteOpFor(entry.op),
        id: entry.id,
        rationale: "rollback: undo creation",
        batchId,
        sourceKind: "manual"
      });
    } else {
      restoreMutations.push({
        op: entry.op,
        id: entry.id,
        data: entry.preState,
        rationale: "rollback: restore pre-accept state",
        batchId,
        sourceKind: "manual"
      });
    }

    entry.status = "rolled-back";
  }

  batch.status = "rolled-back";
  saveBatch(world, batch);

  return { batchId, restoreMutations, skipped };
}
