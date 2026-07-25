/**
 * Mutation engine schemas — pure, Foundry-free, unit-testable.
 *
 * Zod schemas for the shapes the mutation engine passes between its stages
 * (propagate -> texture -> review-state -> rollback) and that get persisted
 * to review-state/<world>/<batchId>.json. See mutation-engine/README.md for
 * the human-readable format note required by the gm-tools-conventions skill.
 *
 * `Mutation` extends wf-mcp-server's existing `wf_apply_mutations` input shape
 * (op/id/data) — see wf-mcp-server/index.mjs's `mutationSchema` — with the
 * fields the review workflow needs (rationale, batchId, sourceKind,
 * impactScore). It is `.strict()` — a freshly-proposed mutation (the shape
 * texture.mjs's LLM call and any hand-authored 'manual' mutation must satisfy)
 * has no business carrying anything else, and a typo'd field name should be
 * caught, not silently ignored. `StoredMutation` below is the separate,
 * wider schema for the persisted envelope review-state.mjs actually writes
 * to disk — see its own doc comment for why the two are split rather than
 * using `.passthrough()` on this one.
 */
import { z } from "zod";

// Bumped 1 -> 2 for Phase 3.5 (deferred/lazy consequence resolution):
// SourceKind gained 'deferred-resolution' (mutations produced by
// time-skip/resolve-pending.mjs's on-demand resolve or time-skip/
// run-cycle.mjs's growth-bound sweep, as opposed to a fresh propagate/decay
// pass) and Batch gained the optional `resolvedPendingEntries` field (which
// ledger entries, if any, a batch resolves — see pending-ledger.mjs's own
// doc comment and applyLedgerOutcome()). Both are additive (old batch files
// still parse unchanged), but per this project's schema-versioning
// discipline every shape change bumps the version and gets a note here.
export const SCHEMA_VERSION = 2;

// Same op set wf-mcp-server/index.mjs's wf_apply_mutations already accepts.
export const MutationOp = z.enum([
  "upsert_entity",
  "upsert_edge",
  "delete_entity",
  "delete_edge",
  "upsert_type",
  "upsert_relationship_type"
]);

// 'deferred-resolution' (Phase 3.5): a mutation produced by texturing an
// entity's accumulated pending-ledger backlog (time-skip/resolve-pending.mjs's
// on-demand resolve, or time-skip/run-cycle.mjs's growth-bound sweep) rather
// than a fresh candidateDeltas pass — distinct from 'ambient-decay'/
// 'seeded-propagation' (both describe a single fresh delta) and from
// 'manual' (rollback.mjs's restore mutations; a genuinely different origin).
export const SourceKind = z.enum(["ambient-decay", "seeded-propagation", "manual", "deferred-resolution"]);

export const Mutation = z.object({
  op: MutationOp,
  id: z.string().optional(),
  data: z.record(z.string(), z.any()).optional(),
  rationale: z.string(),
  batchId: z.string(),
  sourceKind: SourceKind,
  impactScore: z.number().optional()
}).strict();

export const ReviewState = z.enum([
  "pending",
  "accepted",
  "rejected",
  "regenerate-requested",
  "rolled-back"
]);

/**
 * StoredMutation — the persisted per-mutation envelope review-state.mjs
 * actually writes to review-state/<world>/<batchId>.json. Extends `Mutation`'s
 * validated core with the review-workflow bookkeeping fields that get
 * layered on at different pipeline stages, each still validated (not
 * passed through blind):
 *   - `regionId`/`entityContext` — attached by texture.mjs at texturing time
 *   - `mutationId`/`status`      — attached by review-state.mjs's createBatch
 *   - `preState`                 — attached by rollback.mjs's acceptMutations
 *   - `diff`                     — attached by whoever ran diff.mjs against a
 *                                   live snapshot before persisting (grain.mjs
 *                                   reads this field to render field-level
 *                                   diffs; see wf_propose_mutations)
 * Splitting this out from `Mutation` (rather than `Mutation.passthrough()`)
 * means `Mutation` itself stays strict, while re-validating a stored/loaded
 * mutation object still checks every field it actually carries.
 */
export const StoredMutation = Mutation.extend({
  mutationId: z.string(),
  status: ReviewState,
  regionId: z.string().optional(),
  entityContext: z.any().optional(),
  preState: z.any().nullable().optional(),
  diff: z.any().optional()
}).strict();

// Batch-level lifecycle status. 'open' while any mutation is still pending
// review; 'synced' once wf_sync_to_foundry has been attempted for the
// accepted subset; 'rolled-back' once rollbackBatch has run against it.
export const BatchStatus = z.enum(["open", "synced", "rolled-back"]);

// Phase 3.5: which pending-ledger entries (mutation-engine/pending-ledger.mjs)
// a batch resolves, if any — recorded by time-skip/resolve-pending.mjs and
// time-skip/run-cycle.mjs's growth-bound sweep at batch-creation time, and
// read by pending-ledger.mjs's applyLedgerOutcome() on wf_accept/wf_reject to
// know what to clear (accept) or revert to 'pending' (reject). `regionId`
// scopes a record to the specific texture call that produced it (a
// wf_run_cycle batch can mix ordinary headline regions with a
// "region-pending-sweep" region in the same batch — only the latter's
// entries should move on a scoped accept/reject of that region). Absent
// entirely on any batch that didn't originate from a resolve/sweep — the
// overwhelming common case.
const ResolvedPendingEntry = z.object({
  regionId: z.string(),
  entityId: z.string(),
  entryIds: z.array(z.string())
});

export const Batch = z.object({
  id: z.string(),
  world: z.string(),
  createdAt: z.string(),
  scope: z.record(z.string(), z.any()),
  elapsedTimeDescriptor: z.string().optional(),
  mutations: z.array(StoredMutation),
  status: BatchStatus,
  resolvedPendingEntries: z.array(ResolvedPendingEntry).optional()
});
