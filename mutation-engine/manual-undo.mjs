/**
 * Manual-edit undo buffer — pure, Foundry-free, unit-testable.
 *
 * Phase 12 task 12.4. Flagged by the design review (plans/phase-12-review.md)
 * as "the single most important piece of this phase" and "not optional":
 * manual node/edge create/edit/delete (task 12.3) and narration reset (task
 * 12.6) all write immediately, with NO review-state batch wrapping them --
 * so unlike every other write path in this project, they get zero coverage
 * from `rollback.mjs`'s existing batch-rollback mechanism. This module is
 * the dedicated, independent undo path for exactly that gap.
 *
 * DELIBERATELY MIRRORS `rollback.mjs`'s OWN SIMPLICITY, per the design doc's
 * explicit instruction: single slot, most-recent-manual-edit-only, no
 * history list. Read `rollback.mjs` before touching this file -- the whole
 * point is that this is the SAME shape of thing (a Batch holding the info
 * needed to compute + apply an inverse), just for the immediate-write path
 * instead of the review-batch path, and just one slot deep instead of
 * addressable-by-batchId.
 *
 * Storage: ONE JSON file per world (`<manualUndoRoot>/<world>.json`) holding
 * either `null` (empty slot) or a single UndoAction object -- matches
 * human-review.mjs's one-file-per-world convention (this store's only query
 * is "what's the current slot for this world," never a cross-batch scan).
 * Default root is GM_Tools/manual-undo/ (sibling to review-state/,
 * entity-narration/, human-review/, pending-resolution/, prep-content/,
 * user-settings/); override with GM_TOOLS_MANUAL_UNDO_DIR (tests use this
 * for isolation, matching every sibling store's own established
 * regression-test convention). Reuses review-state.mjs's `withLock`/
 * `ConcurrentWriteError` rather than a second file-locking implementation.
 *
 * SHAPE: an UndoAction carries everything needed to reverse exactly one
 * manual write, in one of two forms (never both):
 *   - `graphMutations` (object[]|null): a mutations array (the same
 *     {op,id,data} shape every other producer in this codebase already
 *     uses) to apply, via the SAME live-then-headless apply path every
 *     other write in this project uses
 *     (wf-mcp-server/lib/mutation-ops.mjs's applyMutationsWithHeadlessFallback),
 *     to reverse a graph write (add/edit/delete node/edge). For a
 *     delete_entity's cascade (task 12.3/12.4's explicit "delete node with
 *     its cascade as ONE atomic undo unit" requirement), this array holds
 *     BOTH the node's own re-create AND every one of its cascade-deleted
 *     edges' re-create, applied together in ONE call -- see
 *     wf-mcp-server/lib/manual-edit-ops.mjs's deleteNodeOp for where this
 *     array is actually built.
 *   - `narrationUndo` ({entityId, priorProse:string|null}|null): task
 *     12.6's narration-reset undo, which does NOT touch the graph at all --
 *     it needs its own inverse because entity-narration.mjs's history is
 *     APPEND-ONLY (see that module's own doc comment: nothing is ever
 *     deleted), so "undo a reset" must ALSO be append-only, not a delete of
 *     the reset's empty entry. See wf-mcp-server/lib/manual-edit-ops.mjs's
 *     undoLastManualEditOp for how this gets applied via
 *     entity-narration.mjs's own saveEntityNarration/supersedeEntityNarration
 *     -- no new mechanism invented there either.
 *
 * Exactly one of `graphMutations`/`narrationUndo` is non-null on any given
 * UndoAction -- enforced by the zod schema below (`.refine`).
 *
 * LAST-WRITE-WINS, NOT A STACK: `setUndoSlot` unconditionally overwrites
 * whatever was there, per the design doc's explicit "any new manual edit
 * overwrites the slot" instruction -- there is no history list to push onto.
 * `consumeUndoSlot` both returns AND clears the slot atomically (undoing an
 * undo isn't supported, matching rollback.mjs's own "no multi-batch version
 * history" scope).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "manual-undo");

// SCHEMA_VERSION 2 (Phase 30 task 30.1): additive -- ManualUndoKind gained
// "reparent_node" (manual-edit-ops.mjs's new atomic drag-drop reparent op:
// a delete-old-containment-edge + add-new-containment-edge pair grouped as
// ONE undo action, same `graphMutations`-array shape every other
// graph-mutation kind here already uses -- no new UndoAction field, no
// migration needed for a persisted v1 slot, since a stale slot is consumed
// (or simply overwritten by the next write) rather than read back across a
// process restart in any load-bearing way).
//
// SCHEMA_VERSION 3 (Phase 34 task 34.1): additive -- ManualUndoKind gained
// "remove_reparent_up" (manual-edit-ops.mjs's new removeNodeReparentUp, the
// hybrid "remove from graph" op: reparent every containment child up one
// level, THEN delete the node cascading its remaining edges, as ONE atomic
// undo action -- same `graphMutations`-array shape, same no-migration
// reasoning as SCHEMA_VERSION 2's own note above).
//
// SCHEMA_VERSION 4 (Phase 38 task 38.3): additive -- ManualUndoKind gained
// "anchor_membership" (manual-edit-ops.mjs's new anchorMembership, the World
// Loyalty tree's own atomic drag-drop re-anchor: a delete-old-loyalty-edges
// + add-new-membership-edge group, EXACT sibling shape to "reparent_node"
// above, one edge family over -- same no-migration reasoning).
export const SCHEMA_VERSION = 4;

export const ManualUndoKind = z.enum([
  "add_node",
  "add_edge",
  "edit_node",
  "edit_edge",
  "delete_node",
  "delete_edge",
  "reparent_node",
  "remove_reparent_up",
  "anchor_membership",
  "narration_reset"
]);

export const UndoAction = z
  .object({
    actionId: z.string(),
    kind: ManualUndoKind,
    world: z.string(),
    createdAt: z.string(),
    description: z.string(),
    graphMutations: z.array(z.record(z.string(), z.any())).nullable(),
    narrationUndo: z.object({ entityId: z.string(), priorProse: z.string().nullable() }).nullable()
  })
  .strict()
  .refine(
    (v) => (v.graphMutations !== null) !== (v.narrationUndo !== null),
    { message: "UndoAction must carry exactly one of graphMutations/narrationUndo, never both, never neither" }
  );

export function manualUndoRoot() {
  return process.env.GM_TOOLS_MANUAL_UNDO_DIR || DEFAULT_ROOT;
}

function slotFilePath(world) {
  return join(manualUndoRoot(), `${world}.json`);
}

/** Generate an undo-action id. Injectable via a caller's own id if needed; deterministic-test callers pass one through the `action` object directly instead of relying on this. */
export function makeUndoActionId() {
  return `undo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The current slot for a world, or null if empty. Does not consume it. */
export function getUndoSlot(world) {
  const filePath = slotFilePath(world);
  if (!existsSync(filePath)) return null;
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return raw === null ? null : UndoAction.parse(raw);
}

function writeSlot(world, value) {
  const filePath = slotFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  });
  return value;
}

/**
 * Overwrite the slot with a new action -- last-write-wins, never a stack.
 * @param {string} world
 * @param {{kind:string, description:string, graphMutations?:object[]|null, narrationUndo?:object|null}} action
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]  injectable id generator, for deterministic tests
 * @param {string} [opts.now]           injectable ISO timestamp, for deterministic tests
 * @returns {object} the stored UndoAction
 */
export function setUndoSlot(world, action, opts = {}) {
  const makeId = opts.makeId ?? makeUndoActionId;
  const now = opts.now ?? new Date().toISOString();
  const stored = UndoAction.parse({
    actionId: makeId(),
    kind: action.kind,
    world,
    createdAt: now,
    description: action.description,
    graphMutations: action.graphMutations ?? null,
    narrationUndo: action.narrationUndo ?? null
  });
  return writeSlot(world, stored);
}

/** Explicitly clear the slot without consuming/returning it (used after a successful undo, and available standalone). */
export function clearUndoSlot(world) {
  return writeSlot(world, null);
}

/**
 * Atomically read-and-clear the slot -- the primitive undoLastManualEditOp
 * builds on: fetch what's there, clear it (so a crash/retry mid-apply can't
 * double-consume the same action), then the caller applies the inverse.
 * Returns null if the slot was already empty.
 */
export function consumeUndoSlot(world) {
  const current = getUndoSlot(world);
  if (current === null) return null;
  clearUndoSlot(world);
  return current;
}

export { ConcurrentWriteError };
