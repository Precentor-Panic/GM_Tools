/**
 * Pending-resolution ledger — pure, Foundry-free, unit-testable.
 *
 * Per-entity JSON file: <pendingLedgerRoot>/<world>/<entityId>.json — a flat
 * array of PendingEntry objects (SCHEMA_VERSION 1). Default root is
 * GM_Tools/pending-resolution/ (sibling to mutation-engine/); override with
 * GM_TOOLS_PENDING_LEDGER_DIR (tests use this for isolation, same pattern as
 * review-state.mjs's GM_TOOLS_REVIEW_STATE_DIR and time-skip/status.mjs's
 * GM_TOOLS_TIMESKIP_STATUS_DIR).
 *
 * This is Phase 3.5's actual new subsystem: a cheap, deterministic record of
 * "this entity was touched by cycle X's blast radius but not eagerly
 * textured" — written once (candidateDeltas already computed impactScore/
 * decay magnitude, so writing a ledger entry costs nothing beyond a small
 * file write), read/resolved later only if a GM explicitly asks about the
 * entity (time-skip/resolve-pending.mjs). `causeTag` is a cheap, deterministic
 * label (entity name + cycleDescriptor) — NOT a new LLM output; full
 * narrative context is pulled in at resolve time from `sourceBatchId` via
 * review-state.mjs's `loadBatch()`, never duplicated into the ledger entry
 * itself.
 *
 * Status lifecycle: 'pending' (available to be resolved) -> 'proposed'
 * (locked — part of an in-flight resolve/sweep batch pending review) ->
 * either removed entirely (`markResolved`, once the resolving batch is
 * accepted — a resolved entry has no further use, review-state.mjs's own
 * batch history is the permanent record) or back to 'pending'
 * (`revertToPending`, if the resolving batch is rejected — the underlying
 * debt is real and must not silently vanish).
 *
 * Concurrency: reuses review-state.mjs's `withLock`/`ConcurrentWriteError`
 * rather than duplicating a second file-locking implementation (per
 * gm-tools-conventions and this task's own explicit instruction) — `withLock`
 * was module-private there until this task exported it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "pending-resolution");

export const SCHEMA_VERSION = 1;

export const PendingStatus = z.enum(["pending", "proposed"]);

export const PendingEntry = z.object({
  entryId: z.string(),
  causeTag: z.string(),
  impactScore: z.number(),
  sourceBatchId: z.string(),
  cycleDescriptor: z.string(),
  status: PendingStatus,
  createdAt: z.string()
}).strict();

export function pendingLedgerRoot() {
  return process.env.GM_TOOLS_PENDING_LEDGER_DIR || DEFAULT_ROOT;
}

function worldDir(world) {
  return join(pendingLedgerRoot(), world);
}

function ledgerFilePath(world, entityId) {
  return join(worldDir(world), `${entityId}.json`);
}

/** Generate a pending-entry id. Injectable (opts.makeId) for deterministic tests, same pattern as review-state.mjs's makeBatchId. */
export function makeEntryId() {
  return `pend_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Read an entity's pending ledger. Returns [] if no file exists yet — not an error. */
export function readPending(world, entityId) {
  const filePath = ledgerFilePath(world, entityId);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeLedger(world, entityId, entries) {
  const validated = entries.map((e) => PendingEntry.parse(e));
  const filePath = ledgerFilePath(world, entityId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Append one pending entry to an entity's ledger. Validates the fully-formed
 * entry before writing (fail fast on a malformed caller, matching
 * review-state.mjs's createBatch precedent) — throws ConcurrentWriteError
 * (not a silent overwrite) if another writer currently holds this entity's
 * ledger lock.
 *
 * @param {string} world
 * @param {string} entityId
 * @param {object} entry                     {causeTag, impactScore, sourceBatchId, cycleDescriptor, status?, entryId?, createdAt?}
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]        entry id generator, injectable for tests
 * @returns {object[]} the entity's full, updated ledger
 */
export function writePending(world, entityId, entry, opts = {}) {
  const makeId = opts.makeId ?? makeEntryId;
  const existing = readPending(world, entityId);
  const full = {
    entryId: entry.entryId ?? makeId(),
    causeTag: entry.causeTag,
    impactScore: entry.impactScore,
    sourceBatchId: entry.sourceBatchId,
    cycleDescriptor: entry.cycleDescriptor,
    status: entry.status ?? "pending",
    createdAt: entry.createdAt ?? new Date().toISOString()
  };
  return writeLedger(world, entityId, [...existing, full]);
}

/**
 * List entity ids in `world` with at least one entry whose status is
 * 'pending' (i.e. actually available to be resolved — an entity whose only
 * entries are currently 'proposed', locked into an in-flight resolve batch,
 * does not count as having an available backlog). No separate index file:
 * readdirSync the world's ledger dir directly — cheap at this project's
 * scale, and a second index would be a second source of truth that can drift
 * (per this task's own reasoning).
 */
export function listPendingEntities(world) {
  const dir = worldDir(world);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".lock"))
    .map((f) => f.slice(0, -".json".length))
    .filter((entityId) => readPending(world, entityId).some((e) => e.status === "pending"));
}

function updateStatuses(world, entityId, entryIds, status) {
  const idSet = new Set(entryIds);
  const existing = readPending(world, entityId);
  const updated = existing.map((e) => (idSet.has(e.entryId) ? { ...e, status } : e));
  return writeLedger(world, entityId, updated);
}

/** Lock a set of pending entries into 'proposed' — they're now part of an in-flight resolve/sweep batch. */
export function markProposed(world, entityId, entryIds) {
  return updateStatuses(world, entityId, entryIds, "proposed");
}

/** Reject path: revert a set of entries back to 'pending' (status only — nothing deleted). The underlying debt is real and must not vanish just because a proposed resolution was rejected. */
export function revertToPending(world, entityId, entryIds) {
  return updateStatuses(world, entityId, entryIds, "pending");
}

/**
 * Accept path: remove a set of entries entirely — the terminal state, not a
 * status flag. Once a resolution is accepted, the entries are real, reviewed
 * graph mutations; review-state.mjs's own batch history (via sourceBatchId)
 * is the permanent record, so the ledger has no further use for them.
 */
export function markResolved(world, entityId, entryIds) {
  const idSet = new Set(entryIds);
  const existing = readPending(world, entityId);
  const remaining = existing.filter((e) => !idSet.has(e.entryId));
  return writeLedger(world, entityId, remaining);
}

/**
 * Task 3.5.4 hook: apply an accept/reject outcome to a batch's
 * `resolvedPendingEntries` metadata (recorded by time-skip/resolve-pending.mjs
 * and time-skip/run-cycle.mjs's growth-bound sweep at batch-creation time —
 * see schema.mjs's Batch.resolvedPendingEntries). For every record whose
 * `regionId` is touched by the given mutationIds, mark its ledger entries
 * resolved (accept) or reverted to pending (reject). No-op (returns []) for
 * the common case of a batch that carries no resolvedPendingEntries at all
 * (a plain wf_propose_mutations/wf_run_cycle-headline batch never does).
 *
 * Lives here (not review-state.mjs) to avoid a circular import: this module
 * already depends on review-state.mjs for `withLock`; review-state.mjs has
 * no reason to depend back on this one. The caller (wf-mcp-server's
 * wf_accept/wf_reject handlers) passes in the already-loaded, already-status-
 * updated Batch object rather than this function loading it itself, keeping
 * this module Foundry/file-bridge-agnostic and matching the "front-ends are
 * thin wrappers, no duplicated accept/reject logic" convention: the actual
 * status-transition call (acceptMutations/updateMutationStatus) still lives
 * exactly once, in review-state.mjs/rollback.mjs.
 *
 * @param {object} batch             a review-state.mjs Batch, already updated with the accept/reject statuses
 * @param {string[]} mutationIds     the mutationIds just accepted/rejected in this call
 * @param {'accepted'|'rejected'} outcome
 * @returns {Array<{regionId:string, entityId:string, entryIds:string[]}>} the records actually applied
 */
export function applyLedgerOutcome(batch, mutationIds, outcome) {
  const records = batch.resolvedPendingEntries;
  if (!records || !records.length) return [];

  const touchedRegionIds = new Set(
    batch.mutations
      .filter((m) => mutationIds.includes(m.mutationId))
      .map((m) => m.regionId)
      .filter(Boolean)
  );

  const applied = [];
  for (const record of records) {
    if (!touchedRegionIds.has(record.regionId)) continue;
    if (outcome === "accepted") {
      markResolved(batch.world, record.entityId, record.entryIds);
    } else if (outcome === "rejected") {
      revertToPending(batch.world, record.entityId, record.entryIds);
    } else {
      throw new Error(`applyLedgerOutcome: unknown outcome "${outcome}" (expected 'accepted' or 'rejected')`);
    }
    applied.push(record);
  }
  return applied;
}

export { ConcurrentWriteError };
