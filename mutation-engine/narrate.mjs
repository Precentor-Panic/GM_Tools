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
 * way textureRegion has one — a single call, trimmed, with only an
 * empty-response guard.
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
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callModel, fillTemplate as fillTemplateShared } from "./llm-call.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "narrate.md"), "utf8");

export const DEFAULT_NARRATE_MODEL = "claude-sonnet-5";

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

/** Thrown when the model returns nothing usable (empty text after trimming). */
export class NarrationError extends Error {
  constructor(message, { batchId, rawResponse } = {}) {
    super(message);
    this.name = "NarrationError";
    this.batchId = batchId;
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
      if (Array.isArray(m.diff) && m.diff.length) {
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

  const { world, currentLocation, reachableAreas, note } = ctx;
  const mutationSummary = renderMutationSummary(batch.mutations) || "(no mutations)";

  const prompt = fillTemplate({
    world: world ?? batch.world,
    currentLocation: currentLocation ?? "(not specified)",
    reachableAreas: Array.isArray(reachableAreas) && reachableAreas.length ? reachableAreas.join(", ") : "(not specified)",
    elapsedTimeDescriptor: batch.elapsedTimeDescriptor ?? "(not specified)",
    mutationSummary,
    steeringNote: note ? `Additional guidance from the GM for this narration -- follow it: ${note}` : ""
  });

  const raw = await callModel(prompt, {
    ...opts,
    model: opts.model ?? DEFAULT_NARRATE_MODEL,
    // A narration response is short prose (2-3 paragraphs), not a JSON
    // payload describing many entities the way texture.mjs's response can
    // be -- 1024 (resolve-seed.mjs's default) is closer to right than
    // llm-call.mjs's 2048 shared default, but still pass explicitly rather
    // than rely on the shared default, same reasoning resolve-seed.mjs gives
    // for its own explicit override.
    maxTokens: opts.maxTokens ?? 1024
  });

  const prose = raw.trim();
  if (!prose) {
    throw new NarrationError(`Narration call for batch "${batch.id}" returned empty text.`, {
      batchId: batch.id,
      rawResponse: raw
    });
  }

  return { batchId: batch.id, prose };
}
