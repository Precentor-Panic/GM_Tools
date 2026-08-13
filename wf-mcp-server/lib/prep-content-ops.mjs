/**
 * Shared prep-content operations — Phase 11 task 11.3. Same "front-ends are
 * thin wrappers, never logic duplicators" convention as
 * wf-mcp-server/lib/mutation-ops.mjs: every exported function here takes an
 * already-resolved `dir`/`w` and returns a plain JS object, called
 * identically by wf-mcp-server's MCP tools AND review-ui/server.mjs's HTTP
 * routes — no independent business logic in either front-end.
 *
 * Deliberately separate from mutation-ops.mjs (not added into that file):
 * prep content is not part of the mutation-engine/review-state.mjs pipeline
 * at all (see mutation-engine/prep-content.mjs's own top-of-file doc
 * comment for the full "why a separate store" reasoning, confirmed against
 * the real schema, not just asserted) — this module's operations only ever
 * touch the live snapshot (read-only, for grounding context) and
 * prep-content.mjs's own store. Nothing here writes a Mutation/StoredMutation,
 * creates a review-state Batch, or is reachable from any
 * accept/reject/sync-to-Foundry code path.
 *
 * "Already-committed entity" precondition: every operation here resolves
 * its target entity from the LIVE snapshot (loadSnapshot), never from a
 * pending/proposed batch mutation — matching the design doc's "triggered
 * after commit, not in Batch Review" requirement structurally, not just by
 * convention: there is no batchId parameter anywhere in this module's
 * surface, so it is not reachable from Batch Review's mutation-scoped
 * routes even in principle.
 */
import { loadSnapshot } from "./snapshot.mjs";
import { findEntity } from "./graph.mjs";
import { buildAdjacencyContext, DEFAULT_ENTITY_NARRATE_DEPTH } from "../../mutation-engine/narrate.mjs";
import { markHumanReviewed } from "../../mutation-engine/human-review.mjs";
import {
  proposeFramingsForEntity,
  requestPrepReframing,
  composePrepFramingNote,
  generatePrepContent,
  regeneratePrepField,
  savePrepContent,
  acceptPrepContent,
  discardPrepContent,
  markPrepContentStale,
  updatePrepField,
  getPrepContent,
  fieldsSchemaForType,
  MAX_PREP_FRAMING_ROUNDS
} from "../../mutation-engine/prep-content.mjs";

/**
 * Resolve the target entity (from the LIVE snapshot only) plus its
 * buildAdjacencyContext()-shaped grounding context. Throws a plain, clear
 * error if the entity isn't found -- "develop this node" only ever targets
 * a real, already-committed entity, never a proposed-but-unsynced mutation.
 */
function loadEntityAndContext(dir, w, entityId) {
  const { entities, edges } = loadSnapshot(dir, w).snapshot;
  const entity = findEntity(entities, entityId);
  if (!entity) {
    throw new Error(`No committed entity "${entityId}" found in world "${w}"'s live snapshot -- "develop this node" only applies to an already-committed entity.`);
  }
  const ctx = buildAdjacencyContext(entities, edges, entityId, DEFAULT_ENTITY_NARRATE_DEPTH);
  return { entity, ctx };
}

/**
 * wf_propose_prep_framings / review-ui's propose-framings route: the initial, round-1 framing call for a single entity.
 * QA W1 Fix 3: `opts` (default `{}`) forwards to proposeFramingsForEntity's own opts -- the
 * offline-degrade injection seam. Omitted -> real client construction, byte-identical to
 * every pre-fix caller.
 */
export async function proposePrepFramingsOp(dir, w, { entityId }, opts = {}) {
  const { entity, ctx } = loadEntityAndContext(dir, w, entityId);
  const { framings } = await proposeFramingsForEntity(entity, ctx, opts);
  return { entityId, entityType: entity.type, entityName: entity.name, framings, framingRound: 1 };
}

/**
 * wf_reframe_prep_framings / review-ui's reframe route: a reviewer-rejected
 * round of framings gets one bounded reframe. `priorRoundCount` is
 * caller-supplied (the client's own ephemeral flow state, same pattern
 * Phase 8's review-ui frontend already uses for writeup-import's framing
 * flow) since there is no persisted object yet at this stage to carry a
 * round counter server-side.
 */
export async function reframePrepFramingsOp(dir, w, { entityId, priorRoundCount }, opts = {}) {
  const { entity, ctx } = loadEntityAndContext(dir, w, entityId);
  const { framings } = await requestPrepReframing(entity, ctx, priorRoundCount ?? 1, opts);
  return { entityId, entityType: entity.type, entityName: entity.name, framings, framingRound: (priorRoundCount ?? 1) + 1 };
}

/**
 * wf_generate_prep_content / review-ui's generate route: phase 2 of the
 * two-stage pipeline. Composes the reviewer's framing selection into a
 * steering note, runs the real generation call, and immediately persists
 * the result as a 'proposed' draft (so a page refresh mid-review never
 * loses a just-generated draft) -- NOT yet 'accepted'; a separate explicit
 * accept step is still required, matching the design doc's "propose ->
 * review -> accept" gate.
 */
export async function generatePrepContentOp(dir, w, { entityId, selection }, opts = {}) {
  const { entity, ctx } = loadEntityAndContext(dir, w, entityId);
  const note = composePrepFramingNote(selection);
  const { fields } = await generatePrepContent(entity, ctx, note, opts);
  return savePrepContent(w, entityId, { entityType: entity.type, framingUsed: note, fields });
}

/** wf_get_prep_content / review-ui's GET route: a pure read, no model call. Returns null if the entity has never been developed. */
export function getPrepContentOp(w, { entityId }) {
  return { entityId, prepContent: getPrepContent(w, entityId) };
}

/**
 * wf_accept_prep_content: the initial full-block accept -- required before
 * field-granular regeneration is meaningful (the design doc's living-doc
 * requirement).
 *
 * Task 14.4 (QA-pass finding): every OTHER write path in this project
 * (mutation-ops.mjs's scoped accept, manual-edit-ops.mjs's six write
 * functions) calls markHumanReviewed for a genuinely scoped, deliberate GM
 * action -- this one never did, at all, leaving a developed-and-accepted
 * entity indistinguishable from one nobody has ever opened. Developing an
 * entity's content and explicitly accepting it is real, deliberate
 * engagement with that specific entity (the Phase 4 distinction: a scoped
 * accept counts as review, a whole-batch accept-all does not) -- there is
 * no "batch" concept here at all, so this is unambiguously the scoped case.
 */
export function acceptPrepContentOp(w, { entityId }) {
  const result = acceptPrepContent(w, entityId);
  markHumanReviewed(w, [entityId]);
  return result;
}

/** wf_discard_prep_content: discard a not-yet-accepted 'proposed' draft outright -- the reject half of "propose -> review -> accept/reject". Refuses to discard accepted/stale content (prep-content.mjs's own guard). */
export function discardPrepContentOp(w, { entityId }) {
  return discardPrepContent(w, entityId);
}

/**
 * wf_regenerate_prep_field / review-ui's field-regenerate route: the
 * living-doc field-granular edit path. Loads the entity's CURRENT fields as
 * consistency context (so the new value doesn't contradict the rest of the
 * document), regenerates just the one named field, and persists it via
 * updatePrepField (which itself only ever touches that one key).
 */
export async function regeneratePrepFieldOp(dir, w, { entityId, fieldName, note }, opts = {}) {
  const existing = getPrepContent(w, entityId);
  if (!existing) {
    throw new Error(`No prep content for entity "${entityId}" in world "${w}" -- generate it first before regenerating a field.`);
  }
  const { entity, ctx } = loadEntityAndContext(dir, w, entityId);
  const newValue = await regeneratePrepField(entity, ctx, existing.fields, fieldName, note, opts);
  return updatePrepField(w, entityId, fieldName, newValue);
}

/** wf_mark_prep_content_stale: manual staleness flag (task 11.4 also calls markPrepContentStale directly from the accept hook -- this is the same underlying function, exposed for a GM who wants to flag it themselves without waiting for a re-mutation). */
export function markPrepContentStaleOp(w, { entityId }) {
  return markPrepContentStale(w, entityId);
}

export { fieldsSchemaForType, MAX_PREP_FRAMING_ROUNDS };
