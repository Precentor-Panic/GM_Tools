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

export const SCHEMA_VERSION = 1;

// Same op set wf-mcp-server/index.mjs's wf_apply_mutations already accepts.
export const MutationOp = z.enum([
  "upsert_entity",
  "upsert_edge",
  "delete_entity",
  "delete_edge",
  "upsert_type",
  "upsert_relationship_type"
]);

export const SourceKind = z.enum(["ambient-decay", "seeded-propagation", "manual"]);

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

export const Batch = z.object({
  id: z.string(),
  world: z.string(),
  createdAt: z.string(),
  scope: z.record(z.string(), z.any()),
  elapsedTimeDescriptor: z.string().optional(),
  mutations: z.array(StoredMutation),
  status: BatchStatus
});
