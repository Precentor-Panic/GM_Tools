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
 * Known Phase-1 limitation: a mutation that *created* a brand-new entity/edge
 * (no id known at accept-time — Foundry assigns the id when it actually
 * applies the create, and Phase 1 has no headless-apply id read-back path;
 * that's explicitly Phase 2b's job) cannot be targeted for a delete-based
 * rollback. Such entries are reported in the returned `skipped` array
 * rather than silently dropped or crashing.
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

  for (const entry of batch.mutations) {
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
            "created entity/edge has no known id -- cannot target a delete for rollback " +
            "(Phase 1 limitation: no headless-apply id read-back yet, see Phase 2b)"
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
