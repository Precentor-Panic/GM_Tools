/**
 * Review-state store — pure, Foundry-free, unit-testable.
 *
 * File-per-batch JSON persistence: <reviewStateRoot>/<world>/<batchId>.json.
 * Default root is GM_Tools/review-state/ (sibling to mutation-engine/);
 * override with GM_TOOLS_REVIEW_STATE_DIR (tests use this to avoid writing
 * into the repo's real review-state/ directory and to keep parallel test
 * runs isolated from each other).
 *
 * Batch file format is `schema.mjs`'s `Batch` shape (SCHEMA_VERSION 1), with
 * each stored mutation carrying the enrichment `createBatch` adds on top of
 * the validated `Mutation` core: `mutationId` (stable per-mutation handle —
 * needed because a brand-new entity's own `id` doesn't exist yet at propose
 * time) and `status` (this mutation's ReviewState). Every mutation this
 * module writes or re-writes is validated against `schema.mjs`'s
 * `StoredMutation` — the wider schema that knows about this bookkeeping
 * envelope (and texture.mjs's regionId/entityContext, and rollback.mjs's
 * preState) — not the strict, pre-bookkeeping `Mutation` schema.
 *
 * Concurrency: every write (create or save) takes an exclusive lock file
 * (`<batchId>.json.lock`, created with the `wx` flag so a second writer's
 * open fails outright) before touching the batch file, and releases it in a
 * `finally`. A write that finds an existing lock throws `ConcurrentWriteError`
 * rather than blind-overwriting — per the no-silent-auto-write / concurrency
 * conventions, callers must retry or surface the conflict, not proceed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Batch, StoredMutation, ReviewState } from "./schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "review-state");

export class ConcurrentWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConcurrentWriteError";
  }
}

export function reviewStateRoot() {
  return process.env.GM_TOOLS_REVIEW_STATE_DIR || DEFAULT_ROOT;
}

function worldDir(world) {
  return join(reviewStateRoot(), world);
}

function batchFilePath(world, batchId) {
  return join(worldDir(world), `${batchId}.json`);
}

function lockFilePath(filePath) {
  return `${filePath}.lock`;
}

/**
 * Generate a batch id. Exported so callers that need the id *before*
 * createBatch runs (e.g. wf-mcp-server's wf_propose_mutations, which must
 * stamp batchId onto each Mutation before texturing, then force createBatch
 * to reuse that same id via opts.makeId) don't have to reimplement the
 * scheme. Injectable via opts.makeId for deterministic tests either way.
 */
export function makeBatchId() {
  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Acquire an exclusive lock for a batch file write, run fn(), release the
 * lock in a finally. Throws ConcurrentWriteError if the lock already exists.
 *
 * Exported (Phase 3.5 task 3.5.1) so mutation-engine/pending-ledger.mjs can
 * reuse this exact locking primitive for its own per-entity ledger files
 * instead of duplicating a second file-locking implementation — see that
 * module's own doc comment. Purely additive: no change to this function's
 * behavior or any existing caller.
 */
export function withLock(filePath, fn) {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockPath = lockFilePath(filePath);
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new ConcurrentWriteError(
        `Batch file is locked by an in-progress write: ${filePath}. ` +
        `Another writer (a live-diff call, a sync action, or a crashed process) holds the lock at ${lockPath}. ` +
        `Retry once that write completes, or investigate a stale lock if it persists.`
      );
    }
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    closeSync(fd);
    fd = undefined;
    return fn();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/**
 * Create a new batch: writes a batch file with all mutations status:'pending'.
 * @param {string} world
 * @param {object} scope                          e.g. {mode:'seed', anchorId, depth} or {mode:'ambient', elapsedSessions}
 * @param {string} [elapsedTimeDescriptor]
 * @param {object[]} mutations                     Mutation-shaped objects (validated against schema.mjs's StoredMutation once enriched)
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]             batch id generator, injectable for tests
 * @param {Array<{regionId:string,entityId:string,entryIds:string[]}>} [opts.resolvedPendingEntries]
 *                                                  Phase 3.5: which pending-ledger entries this batch resolves,
 *                                                  if any (see schema.mjs's Batch.resolvedPendingEntries doc comment)
 * @returns {object} the created Batch
 */
export function createBatch(world, scope, elapsedTimeDescriptor, mutations, opts = {}) {
  const makeId = opts.makeId ?? makeBatchId;
  const batchId = makeId();
  const createdAt = new Date().toISOString();

  const enriched = mutations.map((m, i) => {
    const mutationId = m.mutationId ?? `m${i}`;
    // Validate the fully-enriched, about-to-be-stored object in one pass —
    // throws on malformed input (including a typo'd bookkeeping field name),
    // fail fast, don't persist garbage.
    return StoredMutation.parse({ ...m, batchId, mutationId, status: "pending" });
  });

  const batch = Batch.parse({
    id: batchId,
    world,
    createdAt,
    scope,
    elapsedTimeDescriptor,
    mutations: enriched,
    status: "open",
    ...(opts.resolvedPendingEntries?.length ? { resolvedPendingEntries: opts.resolvedPendingEntries } : {})
  });

  const filePath = batchFilePath(world, batchId);
  withLock(filePath, () => {
    writeFileSync(filePath, JSON.stringify(batch, null, 2), "utf8");
  });

  return batch;
}

/** Load a batch by id. Throws if not found. */
export function loadBatch(world, batchId) {
  const filePath = batchFilePath(world, batchId);
  if (!existsSync(filePath)) {
    throw new Error(`No batch found: world="${world}" batchId="${batchId}" (looked at ${filePath})`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Persist a (presumably mutated) batch object back to disk, lock-guarded. */
export function saveBatch(world, batch) {
  const validated = Batch.parse(batch);
  const filePath = batchFilePath(world, validated.id);
  withLock(filePath, () => {
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Update a single mutation's review status within a batch.
 * @param {string} world
 * @param {string} batchId
 * @param {string} mutationId
 * @param {'pending'|'accepted'|'rejected'|'regenerate-requested'|'rolled-back'} status
 * @returns {object} the updated batch
 */
export function updateMutationStatus(world, batchId, mutationId, status) {
  ReviewState.parse(status); // throws on an invalid status
  const batch = loadBatch(world, batchId);
  const entry = batch.mutations.find((m) => m.mutationId === mutationId);
  if (!entry) {
    throw new Error(`No mutation with mutationId="${mutationId}" in batch "${batchId}" (world "${world}")`);
  }
  entry.status = status;
  return saveBatch(world, batch);
}

/**
 * List batches for a world. Returns lightweight summaries (not the full
 * mutation arrays) — call loadBatch(world, id) for full detail.
 */
export function listBatches(world) {
  const dir = worldDir(world);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".lock"))
    .map((f) => {
      const batch = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return {
        id: batch.id,
        createdAt: batch.createdAt,
        status: batch.status,
        scope: batch.scope,
        elapsedTimeDescriptor: batch.elapsedTimeDescriptor,
        mutationCount: batch.mutations.length,
        pendingCount: batch.mutations.filter((m) => m.status === "pending").length
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
}
