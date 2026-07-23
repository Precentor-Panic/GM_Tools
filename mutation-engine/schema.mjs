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
 * impactScore). It uses `.passthrough()` deliberately: review-state.mjs
 * stores a richer per-mutation envelope on top of this validated core
 * (mutationId, status, regionId, entityContext, preState — see
 * review-state.mjs and rollback.mjs) and re-parsing that envelope through
 * this schema must not silently drop those bookkeeping fields.
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
}).passthrough();

export const ReviewState = z.enum([
  "pending",
  "accepted",
  "rejected",
  "regenerate-requested",
  "rolled-back"
]);

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
  mutations: z.array(Mutation),
  status: BatchStatus
});
