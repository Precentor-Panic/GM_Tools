/**
 * Entity narration store — pure, Foundry-free, unit-testable.
 *
 * Phase 10 task 10.1. Replaces whole-batch narration's only-ever-in-memory
 * result (review-ui's old `reviewState.narrationCache`, reset on every fresh
 * `renderReview()` call, never written to disk — the root cause of "if I
 * leave and come back to the queue page, I can generate a new narration"
 * documented in plans/phase-10-review.md) with a genuine, durable, per-entity
 * HISTORY.
 *
 * Storage: one JSON file per (world, entityId) — matching pending-ledger.mjs's
 * own per-entity-file convention (`pending-resolution/<world>/<entityId>.json`)
 * rather than human-review.mjs's one-file-per-world convention, because this
 * store's actual query pattern (per this phase's task list: get an entity's
 * current narration, get its full history) is always keyed by a single
 * entity — there is no "scan every narrated entity in a world at once" query
 * anywhere in this phase's scope the way human-review.mjs's
 * findUnreviewedEntities() needs. `<entityNarrationRoot>/<world>/<entityId>.json`,
 * a flat array of EntityNarrationEntry objects. Default root is
 * GM_Tools/entity-narration/ (sibling to review-state/, pending-resolution/,
 * human-review/); override with GM_TOOLS_ENTITY_NARRATION_DIR (tests use this
 * for isolation — see this project's standing "no write in this file leaked
 * into the repo's real default directory" regression-test convention,
 * test/user-settings.test.mjs, copied here).
 *
 * HISTORY, not a single overwritten "latest" value (an explicit, direct
 * requirement from the project owner — plans/phase-10-tasks.md task 10.1):
 * every save appends a new entry and marks any existing `status:'current'`
 * entry `'superseded'` first. Nothing is ever deleted. Only one entry per
 * entity may be `'current'` at a time. `supersedeEntityNarration` (called
 * when the entity is mutated again — see wf-mcp-server/lib/mutation-ops.mjs's
 * acceptMutationIds, task 10.3) marks the current entry superseded WITHOUT
 * adding a new one, so a stale narration stops presenting as current the
 * moment the entity it describes changes again, without losing the ability
 * to recall it later.
 *
 * Concurrency: reuses review-state.mjs's `withLock`/`ConcurrentWriteError`
 * rather than a second file-locking implementation, per gm-tools-conventions
 * and pending-ledger.mjs/human-review.mjs's own precedent for doing the same.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "entity-narration");

// Bumped 1 -> 2 for Phase 12 task 12.6 (narration reset): EntityNarrationEntry
// gained an optional `origin` field ("reset" for a task-12.6 reset entry,
// absent/undefined for every ordinary narrateEntity()-produced entry) so a
// reset's deliberately-empty prose is distinguishable from a hypothetical
// future genuinely-empty narration, both in the history list and by
// manual-edit-ops.mjs's undo (which needs to tell "this is the reset marker
// I'm about to supersede" apart from anything else). Purely additive -- old
// entries (no `origin` key at all) still parse unchanged.
export const SCHEMA_VERSION = 2;

export const EntityNarrationStatus = z.enum(["current", "superseded"]);
export const EntityNarrationOrigin = z.enum(["reset"]);

export const EntityNarrationEntry = z.object({
  narrationId: z.string(),
  prose: z.string(),
  createdAt: z.string(),
  sourceMutationId: z.string().optional(),
  sourceBatchId: z.string().optional(),
  origin: EntityNarrationOrigin.optional(),
  status: EntityNarrationStatus
}).strict();

export function entityNarrationRoot() {
  return process.env.GM_TOOLS_ENTITY_NARRATION_DIR || DEFAULT_ROOT;
}

function worldDir(world) {
  return join(entityNarrationRoot(), world);
}

function narrationFilePath(world, entityId) {
  return join(worldDir(world), `${entityId}.json`);
}

/** Generate a narration-entry id. Injectable (opts.makeId) for deterministic tests, same pattern as review-state.mjs's makeBatchId / pending-ledger.mjs's makeEntryId. */
export function makeNarrationId() {
  return `enarr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Full history for an entity, oldest-first as stored. Returns [] if the entity has never been narrated — not an error. */
export function getEntityNarrationHistory(world, entityId) {
  const filePath = narrationFilePath(world, entityId);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** The one entry with status:'current', or null if the entity has never been narrated (or its only narration has since been superseded with nothing to replace it). */
export function getCurrentEntityNarration(world, entityId) {
  return getEntityNarrationHistory(world, entityId).find((e) => e.status === "current") ?? null;
}

function writeHistory(world, entityId, entries) {
  const validated = entries.map((e) => EntityNarrationEntry.parse(e));
  const filePath = narrationFilePath(world, entityId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Record a new narration for an entity: marks any existing `'current'` entry
 * `'superseded'` (still present in history, never deleted), appends the new
 * entry as `'current'`.
 *
 * @param {string} world
 * @param {string} entityId
 * @param {{prose:string, sourceMutationId?:string, sourceBatchId?:string, origin?:'reset'}} data
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]   narration id generator, injectable for tests
 * @param {string} [opts.now]            injectable ISO timestamp, for deterministic tests
 * @returns {object[]} the entity's full, updated history
 */
export function saveEntityNarration(world, entityId, { prose, sourceMutationId, sourceBatchId, origin }, opts = {}) {
  const makeId = opts.makeId ?? makeNarrationId;
  const now = opts.now ?? new Date().toISOString();
  const existing = getEntityNarrationHistory(world, entityId).map((e) =>
    e.status === "current" ? { ...e, status: "superseded" } : e
  );
  const entry = {
    narrationId: makeId(),
    prose,
    createdAt: now,
    ...(sourceMutationId ? { sourceMutationId } : {}),
    ...(sourceBatchId ? { sourceBatchId } : {}),
    ...(origin ? { origin } : {}),
    status: "current"
  };
  return writeHistory(world, entityId, [...existing, entry]);
}

/**
 * Mark the entity's current narration (if any) as superseded WITHOUT adding
 * a new entry — called when the entity is mutated again (task 10.3), so a
 * stale narration stops presenting as current. Never deletes anything, and
 * is a safe no-op (returns the unchanged, possibly-empty history, writes
 * nothing to disk) for an entity that has no narration at all yet.
 *
 * @param {string} world
 * @param {string} entityId
 * @returns {object[]} the entity's full history (unchanged if there was no `'current'` entry to supersede)
 */
export function supersedeEntityNarration(world, entityId) {
  const existing = getEntityNarrationHistory(world, entityId);
  if (!existing.some((e) => e.status === "current")) return existing; // safe no-op: nothing current to supersede
  const updated = existing.map((e) => (e.status === "current" ? { ...e, status: "superseded" } : e));
  return writeHistory(world, entityId, updated);
}

export { ConcurrentWriteError };
