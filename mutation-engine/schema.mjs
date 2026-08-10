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
//
// Bumped 2 -> 3 for Phase 5 (import-from-writeup): SourceKind gained
// 'writeup-import' (mutations produced by graph-import/writeup-import.mjs's
// dry-run merge preview of an LLM-proposed WFI document against freeform
// text, as opposed to a graph-native propagate/decay/resolve pass). Purely
// additive — old batch files still parse unchanged.
//
// Bumped 3 -> 4 for Phase 12 task 12.5 (scan for mentioned entities):
// SourceKind gained 'mention-scan' (mutations produced by graph-import/
// scan-mentions.mjs's LLM-assisted scan of a block of text -- usually Phase
// 11 generated prep content -- for entity mentions, reusing writeup-import's
// own name+type dedup matching). Distinct from 'writeup-import' because its
// origin (one entity's own generated content, not a freeform campaign
// writeup) and its mutation shape (edge-only for a matched-existing mention,
// entity+edge for a genuinely new one -- see that module's own doc comment)
// are both meaningfully different, and this project's own convention is
// that a mutation's origin should always be auditable months later. Purely
// additive; old batch files still parse unchanged.
//
// Bumped 4 -> 5 for Phase 37 task 37.1 (Chronicle's shared proposal/diff
// card, review-ui/public/proposal-card.js, 37.2's build target): StoredMutation
// gained two new OPTIONAL fields, `type` (the entity/edge's own type, from
// the live entity or the mutation's own proposed data) and `risk` (one of
// 'safe'/'look'/'contradict', the pinned v1 DETERMINISTIC, non-LLM
// heuristic -- see time-skip/run.mjs's attachDiffs/deriveRisk and
// review-ui/test/e2e/phase37-fixture.mjs §7 for the full pinned rationale).
// Both are stamped by attachDiffs, the ONE function both orchestrateBatch
// AND orchestrateCycle already call before createBatch -- extending it there
// means both orchestrators gain type/risk for free, no second call site to
// remember. Purely additive -- old batch files with neither field still
// parse unchanged; a consumer must render a neutral/unlabeled state for an
// absent risk, never crash on a missing attribute.
export const SCHEMA_VERSION = 5;

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
//
// 'writeup-import' (Phase 5): a mutation produced by graph-import/
// writeup-import.mjs's dry-run merge preview — an LLM-proposed WFI document
// (extracted from freeform text) run through interchange.mjs's importGraph
// without persisting, converted into review-batch-shaped entries. Distinct
// from every other kind above because its origin is freeform text rather
// than the graph's own current state — surfaced separately for auditability
// (months later, "what proposed this" should say "a writeup import", not
// look like an ordinary event consequence).
export const SourceKind = z.enum([
  "ambient-decay",
  "seeded-propagation",
  "manual",
  "deferred-resolution",
  "writeup-import",
  "mention-scan"
]);

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
  diff: z.any().optional(),
  // Phase 37 task 37.1 (SCHEMA_VERSION 4 -> 5, see the header comment above):
  // stamped by attachDiffs -- the entity/edge's own type, and the pinned v1
  // deterministic risk-triage bucket. Both optional -- absent on any
  // pre-Phase-37 batch file.
  type: z.string().optional(),
  risk: z.enum(["safe", "look", "contradict"]).optional()
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
