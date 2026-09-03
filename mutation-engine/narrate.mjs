/**
 * Scene narration pass — the mutation engine's third outward-facing
 * Anthropic API call (alongside texture.mjs's texturing pass and
 * time-skip/resolve-seed.mjs's seed resolution), and Phase 3's actual new
 * content: the second LLM call from the project's original two-call pattern
 * (PLAN.md's "Core Pattern" — mutation call, then a separate scene/
 * consequence-narration call for what the GM reads aloud). Nothing textured
 * so far has produced this; `rationale` on a Mutation is reviewer-facing,
 * this is player-facing.
 *
 * Structurally parallel to texture.mjs (same fillTemplate/callModel
 * plumbing via ./llm-call.mjs, same DI opts.client/apiKey/model/maxTokens),
 * but a genuinely different job and a genuinely different output shape:
 * plain prose, not a JSON array validated against schema.mjs's Mutation
 * shape. Since this output never touches the graph, there is no schema to
 * validate against and therefore no retry-on-validation-failure loop the
 * way textureRegion has one — trimmed, with only an empty-response guard.
 * It DOES still retry once on truncation (stop_reason max_tokens), same as
 * every other LLM call site in this codebase: a truncated response is a
 * budget problem, not a content problem, and here specifically a silent one
 * (raw.trim() is non-empty for prose cut off mid-sentence), so it gets
 * caught explicitly rather than reaching a player at the table looking
 * complete.
 *
 * HARD CONSTRAINT (matches this project's standing no-silent-auto-write
 * invariant, applied to narration instead of mutation): narration only ever
 * runs against a batch whose mutations are ALL status:'accepted'. Read-aloud
 * text at the table functions as stated fact to players — generating it
 * before a human has confirmed the underlying mutations would be a
 * narrower but real violation of that invariant. assertBatchNarratable()
 * enforces this in code (throws NarrationGateError, does not silently
 * narrate a subset or no-op) — narrateBatch() calls it before ever building
 * a prompt or spending a token.
 *
 * PHASE 10 (per-entity narration & persistence, plans/phase-10-review.md /
 * plans/phase-10-tasks.md task 10.2): narrateBatch() above is the reason a
 * cluster of real bugs got reported after first hands-on use of review-ui --
 * one call narrates a whole BATCH, so every row in it was shown the exact
 * same prose ("regenerate" just re-ran the identical whole-batch call), and
 * review-ui never passed real currentLocation/reachableAreas grounding
 * anyway (always "(not specified)"), so the model had nothing to anchor a
 * specific moment to and defaulted to a generic scene-setting framing.
 * `narrateEntity()` below is the fix: same gate (assertMutationNarratable,
 * scoped to ONE mutation instead of the whole batch), same truncation
 * handling (factored into the shared `runNarrationCall` helper both
 * functions now call, rather than duplicating the retry loop a second time
 * in this file), but targeted using the entity's own real, immediate graph
 * neighbors (wf-mcp-server/lib/graph.mjs's `neighborhood()` -- the same
 * adjacency primitive time-skip/resolve-pending.mjs and time-skip/
 * run-cycle.mjs already reuse rather than write a second graph-walk;
 * importing it here from mutation-engine/ follows that exact established
 * precedent, not a new layering direction) instead of an always-empty
 * location/area pair. On success it persists the result via
 * mutation-engine/entity-narration.mjs's saveEntityNarration() so the
 * result is durable across a page reload, not just returned to the caller
 * -- the actual fix for "if I leave and come back to the queue page, I can
 * generate a new narration."
 *
 * narrateBatch() itself is NOT deleted or changed in observable behavior --
 * per the design doc, per-entity is now the default path review-ui uses
 * (task 10.4/10.5), but the whole-batch call stays available (wf_narrate_batch
 * still works) in case a whole-scene summary is ever independently useful.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callModelDetailed, fillTemplate as fillTemplateShared } from "./llm-call.mjs";
import { neighborhood, findEntity, findEdge } from "../wf-mcp-server/lib/graph.mjs";
import { saveEntityNarration } from "./entity-narration.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "narrate.md"), "utf8");

export const DEFAULT_NARRATE_MODEL = "claude-sonnet-5";
// "Immediate graph neighbors" (task 10.2's own wording) -- depth 1, not a
// wider blast-radius walk. This is grounding for one entity's own narration,
// not a propagation pass; a deeper walk would pull in context several hops
// away that has nothing to do with what's actually near this entity right
// now.
export const DEFAULT_ENTITY_NARRATE_DEPTH = 1;

/**
 * Thrown when a batch is not eligible for narration — some mutation in it is
 * not status:'accepted'. A typed error, not a silent no-op or a partial
 * narration of just the accepted subset (per task 3.2/3.3's explicit
 * "don't partially narrate" requirement).
 */
export class NarrationGateError extends Error {
  constructor(message, { batchId, notAccepted } = {}) {
    super(message);
    this.name = "NarrationGateError";
    this.batchId = batchId;
    this.notAccepted = notAccepted; // [{mutationId, status}]
  }
}

/** Thrown when the model returns nothing usable (empty text after trimming), or a response stays truncated after the retry. */
export class NarrationError extends Error {
  constructor(message, { batchId, mutationId, rawResponse } = {}) {
    super(message);
    this.name = "NarrationError";
    this.batchId = batchId;
    this.mutationId = mutationId; // set for narrateEntity's errors, undefined for narrateBatch's (whole-batch grain has no single mutationId)
    this.rawResponse = rawResponse;
  }
}

/**
 * Gate check: every mutation in the batch must be status:'accepted'. Throws
 * NarrationGateError (listing each offending mutationId + its actual status)
 * if not, or if the batch has no mutations at all (nothing to narrate).
 * Exported standalone so callers (e.g. wf_narrate_batch) can run the same
 * check independently of actually making the API call, and so it's directly
 * unit-testable without mocking a client.
 *
 * @param {object} batch  a review-state.mjs Batch object
 * @throws {NarrationGateError}
 */
export function assertBatchNarratable(batch) {
  const notAccepted = batch.mutations.filter((m) => m.status !== "accepted");
  if (notAccepted.length) {
    const detail = notAccepted.map((m) => `${m.mutationId} (${m.status})`).join(", ");
    throw new NarrationGateError(
      `Batch "${batch.id}" has ${notAccepted.length} mutation(s) that are not accepted -- narration only runs ` +
      `against a fully-accepted batch, never pending/rejected/regenerate-requested ones. Not accepted: ${detail}`,
      { batchId: batch.id, notAccepted: notAccepted.map((m) => ({ mutationId: m.mutationId, status: m.status })) }
    );
  }
  if (!batch.mutations.length) {
    throw new NarrationGateError(`Batch "${batch.id}" has no mutations -- nothing to narrate.`, {
      batchId: batch.id,
      notAccepted: []
    });
  }
}

/**
 * Entity-grain equivalent of assertBatchNarratable(): the SAME hard
 * constraint (no-silent-auto-write invariant, applied to narration), but
 * checked against ONE mutation's own status rather than requiring the whole
 * batch to be accepted -- task 10.2's actual gate-grain fix. Throws a plain
 * Error if no mutation with `mutationId` exists in the batch at all (a
 * caller bug, not a review-state precondition failure), or NarrationGateError
 * (same shape assertBatchNarratable throws, so existing error-mapping code
 * like review-ui/server.mjs's statusForError needs no change) if the
 * mutation exists but isn't status:'accepted'.
 *
 * @param {object} batch  a review-state.mjs Batch object
 * @param {string} mutationId
 * @returns {object} the found StoredMutation, status:'accepted' guaranteed
 * @throws {NarrationGateError}
 */
export function assertMutationNarratable(batch, mutationId) {
  const mutation = batch.mutations.find((m) => m.mutationId === mutationId);
  if (!mutation) {
    throw new Error(`No mutation with mutationId="${mutationId}" in batch "${batch.id}" -- nothing to narrate.`);
  }
  if (mutation.status !== "accepted") {
    throw new NarrationGateError(
      `Mutation "${mutationId}" in batch "${batch.id}" is not accepted (status: "${mutation.status}") -- entity ` +
      `narration only runs against an accepted mutation, never pending/rejected/regenerate-requested.`,
      { batchId: batch.id, notAccepted: [{ mutationId, status: mutation.status }] }
    );
  }
  return mutation;
}

/**
 * Build real grounding context from an entity's own immediate graph
 * neighbors, reusing wf-mcp-server/lib/graph.mjs's neighborhood() (the same
 * BFS primitive wf_get_adjacent/time-skip/resolve-pending.mjs already
 * expose/reuse) rather than a second graph-walk. Repurposes narrate.md's
 * existing `currentLocation`/`reachableAreas` template slots -- per task
 * 10.2's own wording ("replace the always-empty currentLocation/
 * reachableAreas slots with real grounding pulled from the entity's own
 * immediate graph neighbors") -- rather than inventing a third prompt
 * template just for entity grain: `currentLocation` becomes the narrated
 * entity itself (what/where this narration is actually about), and
 * `reachableAreas` becomes its immediate neighbors, each labeled with the
 * relationship connecting them, so the model has real, specific, non-generic
 * material to ground the scene in instead of inventing one from nothing.
 *
 * @param {object[]} entities  the live snapshot's entities
 * @param {object[]} edges     the live snapshot's edges
 * @param {string} entityId    the narrated entity/edge's target id (StoredMutation.id)
 * @param {number} [depth]     defaults to DEFAULT_ENTITY_NARRATE_DEPTH (1 -- immediate neighbors only)
 * @returns {{entityLabel:string, neighborDescriptions:string[]}}
 */
export function buildAdjacencyContext(entities, edges, entityId, depth = DEFAULT_ENTITY_NARRATE_DEPTH) {
  const entity = findEntity(entities, entityId);
  if (entity) {
    const entityLabel = `${entity.name}${entity.type ? ` (${entity.type})` : ""}`;
    const { edges: nearbyEdges } = neighborhood(entities, edges, entityId, depth);
    const entityMap = new Map(entities.map((e) => [e.id, e]));
    const seen = new Set();
    const neighborDescriptions = [];
    for (const edge of nearbyEdges) {
      // neighborhood() at depth=1 only ever returns edges incident to
      // entityId in the first place, but this guard keeps the result
      // correct even if a caller passes a larger depth (edges among
      // neighbors-of-neighbors would otherwise leak in as if they were
      // "immediate").
      if (edge.sourceId !== entityId && edge.targetId !== entityId) continue;
      const otherId = edge.sourceId === entityId ? edge.targetId : edge.sourceId;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const other = entityMap.get(otherId);
      neighborDescriptions.push(`${other?.name ?? otherId} (${edge.relationshipType})`);
    }
    return { entityLabel, neighborDescriptions };
  }

  // SELF-REVIEW REMEDIATION: `entityId` isn't an entity at all for an
  // upsert_edge/delete_edge mutation -- StoredMutation.id there is the EDGE's
  // own id, which is never a key in neighborhood()'s adjacency map (built
  // from edge.sourceId/targetId, not edge.id). Without this branch, an edge
  // mutation's narration would ground on the raw internal edge id string
  // with zero neighbors -- not a crash, but exactly the kind of hollow,
  // untargeted context this task exists to eliminate, and edge mutations
  // (relationship strength/valence/notes changes) are a common, ordinary
  // case in this codebase, not a rare corner. Ground on the edge's own two
  // endpoints instead: the relationship IS the "entity" being narrated, and
  // its endpoints are its most immediate real context.
  const edge = findEdge(edges, entityId);
  if (edge) {
    const entityMap = new Map(entities.map((e) => [e.id, e]));
    const sourceName = entityMap.get(edge.sourceId)?.name ?? edge.sourceId;
    const targetName = entityMap.get(edge.targetId)?.name ?? edge.targetId;
    const entityLabel = `${sourceName} ↔ ${targetName} (${edge.relationshipType})`;

    const neighborDescriptions = [];
    const seen = new Set([edge.sourceId, edge.targetId]);
    for (const [anchorId, anchorName] of [[edge.sourceId, sourceName], [edge.targetId, targetName]]) {
      const { edges: anchorEdges } = neighborhood(entities, edges, anchorId, depth);
      for (const nearbyEdge of anchorEdges) {
        if (nearbyEdge.id === edge.id) continue; // the edge being narrated itself, not one of its neighbors
        if (nearbyEdge.sourceId !== anchorId && nearbyEdge.targetId !== anchorId) continue;
        const otherId = nearbyEdge.sourceId === anchorId ? nearbyEdge.targetId : nearbyEdge.sourceId;
        if (seen.has(otherId)) continue;
        seen.add(otherId);
        const otherName = entityMap.get(otherId)?.name ?? otherId;
        neighborDescriptions.push(`${anchorName} → ${otherName} (${nearbyEdge.relationshipType})`);
      }
    }
    return { entityLabel, neighborDescriptions };
  }

  // Neither a known entity nor a known edge -- degrade to the raw id rather
  // than throwing, matching renderMutationSummary's own existing fallback
  // convention (`m.entityContext?.name ?? m.id ?? m.mutationId`) elsewhere
  // in this file for the same "we don't actually know what this is" case.
  return { entityLabel: entityId, neighborDescriptions: [] };
}

/**
 * Render each accepted mutation's post-mutation state (not the raw delta
 * object) for the prompt: entity/edge name, what changed (diff.mjs's
 * field-level to-values when present, falling back to the raw `data`
 * payload), and the reviewer's rationale as grounding context for the
 * model (input context only -- the prompt itself instructs against
 * reviewer-facing language leaking into the OUTPUT).
 */
function renderMutationSummary(mutations) {
  return mutations
    .map((m) => {
      const name = m.entityContext?.name ?? m.id ?? m.mutationId;
      let changeDesc;
      if (m.op === "delete_entity" || m.op === "delete_edge") {
        // time-skip/run.mjs's attachDiffs() only computes a diff for
        // upsert_entity/upsert_edge (see its own doc comment) -- a delete op
        // reaches here with no `diff` and typically no `data` either, which
        // would otherwise fall through to the generic "(no field-level
        // detail recorded)" case below and read as missing information
        // rather than as the deletion it actually is. Narration needs to
        // know something was removed/destroyed, not just that nothing was
        // recorded about it.
        changeDesc = "removed/destroyed";
      } else if (Array.isArray(m.diff) && m.diff.length) {
        changeDesc = m.diff
          .map((d) => (d.field === "(created)" ? "newly created" : `${d.field} is now ${JSON.stringify(d.to)}`))
          .join("; ");
      } else if (m.data && Object.keys(m.data).length) {
        changeDesc = JSON.stringify(m.data);
      } else {
        changeDesc = "(no field-level detail recorded)";
      }
      return `- ${name} (${m.op}): ${changeDesc}. Why: ${m.rationale}`;
    })
    .join("\n");
}

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

/**
 * Shared retry/truncation-handling core for BOTH narrateBatch and
 * narrateEntity -- factored out (Phase 10) so the entity-grain call reuses
 * this logic exactly rather than a second, drifting copy of it existing
 * lower in this same file. Prose has no schema to validate (unlike
 * textureRegion's JSON output), so there's no validation-failure retry loop
 * here, only truncation handling: a truncated narration is uniquely
 * dangerous because raw.trim() below is still non-empty for a story cut off
 * mid-sentence, so without this check a truncated narration would silently
 * reach a player at the table as if it were the complete text, with no
 * error at all. One bounded retry with a doubled budget, matching every
 * other LLM call site's truncation handling in this codebase.
 *
 * @param {string} prompt
 * @param {object} opts               same shape narrateBatch/narrateEntity's own opts take
 * @param {object} errorContext       {batchId, mutationId?} -- threaded onto NarrationError for a clear message
 * @returns {Promise<string>} trimmed, non-empty prose
 * @throws {NarrationError}
 */
async function runNarrationCall(prompt, opts, errorContext) {
  const { batchId, mutationId } = errorContext;
  const label = mutationId ? `mutation "${mutationId}" in batch "${batchId}"` : `batch "${batchId}"`;

  // A narration response is short prose (2-3 paragraphs), not a JSON
  // payload describing many entities the way texture.mjs's response can
  // be -- 1024 (resolve-seed.mjs's default) is closer to right than
  // llm-call.mjs's 2048 shared default, but still pass explicitly rather
  // than rely on the shared default, same reasoning resolve-seed.mjs gives
  // for its own explicit override.
  let maxTokens = opts.maxTokens ?? 1024;
  let raw = "";
  let truncated = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    ({ text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_NARRATE_MODEL,
      maxTokens
    }));
    if (!truncated) break;
    if (attempt < 2) maxTokens *= 2;
  }

  if (truncated) {
    throw new NarrationError(
      `Narration call for ${label} was truncated at max_tokens=${maxTokens} on both attempts -- the narration ` +
      `was larger than the token budget allowed.`,
      { batchId, mutationId, rawResponse: raw }
    );
  }

  const prose = raw.trim();
  if (!prose) {
    throw new NarrationError(`Narration call for ${label} returned empty text.`, { batchId, mutationId, rawResponse: raw });
  }
  return prose;
}

/**
 * Narrate an already-accepted batch: one Anthropic API call, plain prose out.
 *
 * @param {object} batch  a review-state.mjs Batch object -- EVERY mutation in it must be status:'accepted'
 * @param {object} [ctx]
 * @param {string} [ctx.world]              defaults to batch.world
 * @param {string} [ctx.currentLocation]    grounding hint, e.g. current scene location
 * @param {string[]} [ctx.reachableAreas]   grounding hint, areas the party could move to next
 * @param {string} [ctx.note]               regenerate-with-note steering guidance -- does NOT touch
 *                                           review-state.mjs's mutation-acceptance status, only the prompt
 * @param {object} [opts]
 * @param {object} [opts.client]  injectable Anthropic-SDK-shaped client (for tests / DI)
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{batchId:string, prose:string}>}
 * @throws {NarrationGateError} if any mutation in the batch is not accepted (or the batch is empty)
 * @throws {NarrationError} if the model returns empty text
 */
export async function narrateBatch(batch, ctx = {}, opts = {}) {
  assertBatchNarratable(batch);

  const { world, currentLocation, reachableAreas, note, withheldGuidance } = ctx;
  const mutationSummary = renderMutationSummary(batch.mutations) || "(no mutations)";

  const prompt = fillTemplate({
    world: world ?? batch.world,
    currentLocation: currentLocation ?? "(not specified)",
    reachableAreas: Array.isArray(reachableAreas) && reachableAreas.length ? reachableAreas.join(", ") : "(not specified)",
    elapsedTimeDescriptor: batch.elapsedTimeDescriptor ?? "(not specified)",
    mutationSummary,
    // Narrative-state knowledge gate (table-facing output): the ops layer
    // passes renderAllusionInstruction()'s block when accepted targets hold
    // unrevealed truths; empty (today's exact prompt) when nothing is gated.
    withheldGuidance: withheldGuidance ?? "",
    steeringNote: note ? `Additional guidance from the GM for this narration -- follow it: ${note}` : ""
  });

  const prose = await runNarrationCall(prompt, opts, { batchId: batch.id });
  return { batchId: batch.id, prose };
}

/**
 * Narrate a SINGLE already-accepted mutation within a batch -- Phase 10's
 * per-entity replacement for narrateBatch as review-ui's default path (see
 * this module's top-of-file Phase 10 doc comment for the full "why").
 *
 * Same hard gate as narrateBatch, just scoped down to one mutation
 * (assertMutationNarratable, not assertBatchNarratable): the targeted
 * mutation must be status:'accepted', or this throws NarrationGateError
 * without ever building a prompt or spending a token. Same truncation
 * handling (runNarrationCall, shared with narrateBatch above). Genuinely
 * different from narrateBatch in exactly the two ways task 10.2 asks for:
 * (1) the prompt is built from only THIS mutation's own change (via
 * renderMutationSummary([mutation])), not every mutation in the batch --
 * fixing "narration is generated for one update in the batch and spread
 * across all of the nodes"; (2) currentLocation/reachableAreas are filled
 * from the entity's own real immediate graph neighbors (buildAdjacencyContext)
 * instead of always being "(not specified)" -- fixing the generic
 * "session zero"-style framing the empty grounding context was causing.
 *
 * On success, persists the result via entity-narration.mjs's
 * saveEntityNarration() -- the actual fix for narration never surviving a
 * page reload. Persistence is skipped (with a clear thrown error, not a
 * silent no-op) if the targeted mutation has no resolved `id` yet (a
 * newly-created entity/edge that was accepted but not yet synced through
 * the headless path that writes ids back) -- there is nothing to key the
 * narration store by in that case.
 *
 * @param {object} batch        a review-state.mjs Batch object
 * @param {string} mutationId   which mutation in the batch to narrate
 * @param {object} [ctx]
 * @param {string} [ctx.world]           defaults to batch.world
 * @param {object[]} [ctx.entities]      live snapshot entities, for adjacency grounding -- omit to fall back to "(not specified)"
 * @param {object[]} [ctx.edges]         live snapshot edges, for adjacency grounding
 * @param {number} [ctx.adjacencyDepth]  defaults to DEFAULT_ENTITY_NARRATE_DEPTH
 * @param {string} [ctx.note]            regenerate-with-note steering guidance
 * @param {object} [opts]                same as narrateBatch's opts
 * @returns {Promise<{batchId:string, mutationId:string, entityId:string|undefined, prose:string}>}
 * @throws {NarrationGateError} if the targeted mutation is not accepted (or doesn't exist in the batch)
 * @throws {NarrationError} if the model returns empty text, stays truncated, or the mutation has no resolved id to persist against
 */
export async function narrateEntity(batch, mutationId, ctx = {}, opts = {}) {
  const mutation = assertMutationNarratable(batch, mutationId);

  // Checked BEFORE spending an API call, not after: a mutation with no
  // resolved id can never be persisted by entity-narration.mjs (there's
  // nothing to key the store by), so there's no reason to pay for a real
  // narration call whose result would just be thrown away.
  if (!mutation.id) {
    throw new NarrationError(
      `Mutation "${mutationId}" in batch "${batch.id}" has no resolved entity/edge id yet (a newly-created entity ` +
      `accepted but not yet synced) -- entity narration has nothing to key entity-narration.mjs's persistent store ` +
      `by. Sync this batch first, then narrate again.`,
      { batchId: batch.id, mutationId }
    );
  }

  const { world, entities, edges, note, adjacencyDepth, withheldGuidance } = ctx;
  const mutationSummary = renderMutationSummary([mutation]) || "(no mutations)";

  let currentLocation = "(not specified)";
  let reachableAreas = "(not specified)";
  if (mutation.id && Array.isArray(entities) && Array.isArray(edges)) {
    const { entityLabel, neighborDescriptions } = buildAdjacencyContext(
      entities,
      edges,
      mutation.id,
      adjacencyDepth ?? DEFAULT_ENTITY_NARRATE_DEPTH
    );
    currentLocation = entityLabel;
    if (neighborDescriptions.length) reachableAreas = neighborDescriptions.join(", ");
  }

  const prompt = fillTemplate({
    world: world ?? batch.world,
    currentLocation,
    reachableAreas,
    elapsedTimeDescriptor: batch.elapsedTimeDescriptor ?? "(not specified)",
    mutationSummary,
    // Same knowledge-gate slot as narrateBatch — the ops layer supplies the
    // allusion block (scoped to this entity's own adjacency); "" = ungated.
    withheldGuidance: withheldGuidance ?? "",
    steeringNote: note ? `Additional guidance from the GM for this narration -- follow it: ${note}` : ""
  });

  const prose = await runNarrationCall(prompt, opts, { batchId: batch.id, mutationId });

  saveEntityNarration(world ?? batch.world, mutation.id, {
    prose,
    sourceMutationId: mutationId,
    sourceBatchId: batch.id
  });

  return { batchId: batch.id, mutationId, entityId: mutation.id, prose };
}
