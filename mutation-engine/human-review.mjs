/**
 * Unreviewed-accumulation tracking — pure, Foundry-free, unit-testable.
 *
 * Phase 4 task 4.2. Tracks, per (world, entityId), the last time a HUMAN
 * actually looked at (not just auto-accepted) that entity's mutation diff —
 * distinct from any existing `updatedAt`/`lastSession`-style timestamp WF
 * already carries on the entity itself, and distinct from Phase 3.5's
 * pending-ledger.mjs (that tracks content not yet resolved/textured; this
 * tracks content that WAS applied but never actually reviewed — a different
 * kind of debt, deliberately not conflated with or reusing the pending
 * ledger's storage, per this task's own explicit instruction).
 *
 * Two signals, tracked together per entity:
 *   - `lastHumanReviewedAt` — ISO timestamp of the last genuine review
 *     action, or `null` if never reviewed. Updated ONLY by a *scoped*
 *     action (`wf_review_batch` at `region`/`entity` grain, or an
 *     `wf_accept`/`wf_reject`/`wf_regenerate` call at `region`/`entity`
 *     scope) — never by a whole-`batch`-scope action. That distinction is
 *     the entire point of this feature: a GM batch-accepting 40 mutations
 *     without reading any of them must not count as having reviewed them.
 *   - `unreviewedAcceptCount` — how many times a whole-batch accept-all has
 *     applied a mutation touching this entity since its last genuine
 *     review. Reset to 0 by any genuine review action; incremented by
 *     `recordUnreviewedAccept` (called only from a `batch`-scope
 *     `wf_accept`, never from `wf_reject`/`wf_regenerate`, since only an
 *     *accepted* mutation actually lands on the graph — a batch-reject-all
 *     leaves no unreviewed content behind to worry about).
 *
 * Storage: ONE JSON file per world (not one-per-entity, unlike
 * pending-ledger.mjs's own convention) — `<humanReviewRoot>/<world>.json`,
 * mapping `entityId -> {lastHumanReviewedAt, unreviewedAcceptCount}`. A
 * single per-world file, because the primary consumer
 * (`findUnreviewedEntities`) needs to scan every tracked entity in a world
 * at once; a file-per-entity layout would mean a readdir + N reads for
 * every query, for no benefit at this project's scale (a GM's own campaign
 * graph, not a database's worth of rows). Default root is
 * `GM_Tools/human-review/` (sibling to `review-state/` and
 * `pending-resolution/`); override with `GM_TOOLS_HUMAN_REVIEW_DIR` (tests
 * use this for isolation, same pattern as the two sibling stores). Reuses
 * review-state.mjs's `withLock`/`ConcurrentWriteError` rather than a second
 * file-locking implementation, per gm-tools-conventions and
 * pending-ledger.mjs's own precedent for doing the same.
 *
 * Lives in its own module rather than extending review-state.mjs (the task
 * file's own starting hypothesis, explicitly flagged there as non-binding)
 * — same reasoning pending-ledger.mjs already established for itself: a
 * genuinely separate concept, with its own storage shape and its own query
 * surface (cross-batch, keyed by entity rather than by batch), earns its
 * own file rather than growing review-state.mjs's batch-file-per-batch
 * concern into a second, unrelated per-entity-across-batches one.
 *
 * Staleness-query framing: the task file asks to reuse an "N sessions or M
 * accepted-mutations" framing from the project's original requirements doc,
 * if findable via PLAN.md/memory — searched both; no such framing exists
 * anywhere outside the task file's own passing mention of it. This module
 * substitutes "N days" for "N sessions" (no session-counter primitive
 * exists anywhere else in this project to key off — World Fabric's own
 * `sessionNumber` in snapshot meta is a global per-world counter, not a
 * per-entity one, and isn't visible to this Foundry-free module anyway),
 * and keeps the "M accepted-mutations" half exactly as specified. Both
 * thresholds are per-call-configurable, not hardcoded, per the task's own
 * "make it configurable" instruction; `DEFAULT_MAX_AGE_DAYS`/
 * `DEFAULT_MAX_UNREVIEWED_ACCEPTS` below are the documented defaults.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "human-review");

export const DEFAULT_MAX_AGE_DAYS = 14;
export const DEFAULT_MAX_UNREVIEWED_ACCEPTS = 5;

export function humanReviewRoot() {
  return process.env.GM_TOOLS_HUMAN_REVIEW_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(humanReviewRoot(), `${world}.json`);
}

function readState(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeState(world, state) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  });
  return state;
}

function entryFor(state, entityId) {
  return state[entityId] ?? { lastHumanReviewedAt: null, unreviewedAcceptCount: 0 };
}

/**
 * Mark a set of entities as genuinely reviewed by a human RIGHT NOW: sets
 * `lastHumanReviewedAt` to the current time and resets
 * `unreviewedAcceptCount` to 0. Call this ONLY from a scoped
 * (`region`/`entity`, never `batch`) review view or accept/reject/regenerate
 * action.
 *
 * @param {string} world
 * @param {string[]} entityIds   falsy entries are silently skipped (e.g. a
 *                                create mutation with no id yet)
 * @param {object} [opts]
 * @param {string} [opts.now]    injectable ISO timestamp, for deterministic tests
 * @returns {object} the full updated per-world state
 */
export function markHumanReviewed(world, entityIds, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const state = readState(world);
  for (const entityId of entityIds) {
    if (!entityId) continue;
    state[entityId] = { lastHumanReviewedAt: now, unreviewedAcceptCount: 0 };
  }
  return writeState(world, state);
}

/**
 * Record that a set of entities were just accepted WITHOUT a scoped human
 * review — a whole-`batch`-scope accept-all — incrementing each entity's
 * `unreviewedAcceptCount` by 1. Never touches `lastHumanReviewedAt`: an
 * accept-all is exactly NOT a review, by design.
 *
 * @param {string} world
 * @param {string[]} entityIds
 * @returns {object} the full updated per-world state
 */
export function recordUnreviewedAccept(world, entityIds) {
  const state = readState(world);
  for (const entityId of entityIds) {
    if (!entityId) continue;
    state[entityId] = { ...entryFor(state, entityId), unreviewedAcceptCount: entryFor(state, entityId).unreviewedAcceptCount + 1 };
  }
  return writeState(world, state);
}

/** Read one entity's tracked review state (the never-reviewed default if untracked). */
export function getHumanReviewState(world, entityId) {
  return entryFor(readState(world), entityId);
}

/**
 * Surface entities whose applied-but-unreviewed history has gone too long:
 * never reviewed, last reviewed more than `maxAgeDays` ago, or accumulated
 * at least `maxUnreviewedAccepts` batch-accept-all touches since the last
 * real review. Either threshold alone is enough to flag an entity ("N days
 * OR M accepted-mutations", not AND) — matching the task's own "N sessions
 * or M accepted-mutations" framing (see this module's own doc comment for
 * the N-sessions -> N-days substitution).
 *
 * Only entities with SOME tracked history are considered — an entity that
 * has never been touched by accept/review at all has no "applied-but-
 * unreviewed history" to flag in the first place.
 *
 * @param {string} world
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays]           default DEFAULT_MAX_AGE_DAYS
 * @param {number} [opts.maxUnreviewedAccepts] default DEFAULT_MAX_UNREVIEWED_ACCEPTS
 * @param {string} [opts.now]                  injectable "current time" ISO string, for deterministic tests
 * @returns {Array<{entityId:string, lastHumanReviewedAt:string|null, unreviewedAcceptCount:number, reason:'never-reviewed'|'stale'|'accumulated'}>}
 */
export function findUnreviewedEntities(world, opts = {}) {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxUnreviewedAccepts = opts.maxUnreviewedAccepts ?? DEFAULT_MAX_UNREVIEWED_ACCEPTS;
  const now = new Date(opts.now ?? new Date().toISOString());
  const state = readState(world);

  const flagged = [];
  for (const [entityId, entry] of Object.entries(state)) {
    if (entry.lastHumanReviewedAt === null) {
      flagged.push({ entityId, ...entry, reason: "never-reviewed" });
      continue;
    }
    const ageDays = (now.getTime() - new Date(entry.lastHumanReviewedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= maxAgeDays) {
      flagged.push({ entityId, ...entry, reason: "stale" });
    } else if (entry.unreviewedAcceptCount >= maxUnreviewedAccepts) {
      flagged.push({ entityId, ...entry, reason: "accumulated" });
    }
  }
  return flagged;
}

export { ConcurrentWriteError };
