/**
 * Fast, single-shot ad-hoc generation primitive — Phase 22 task 22.6.
 *
 * Implements plans/phase-21-review.md §7 and §12's second identified
 * engine-layer requirement: "A fast, single-shot ad-hoc generation primitive
 * for the mid-session '+' flow ... genuinely distinct from the multi-round
 * Q&A pattern, since 'one field, one button, fast' rules out reusing the
 * full reframe-round machinery." Deliberately a MUCH THINNER wrapper than
 * the entity-content-generation flow one level up (wf-mcp-server's prep
 * content operations module) — not a smaller version of it, a genuinely
 * different, simpler primitive: exactly one call to
 * mutation-engine/llm-call.mjs's callModelDetailed, no templating, no
 * round-trip of any kind.
 *
 * Phase 37.6 task 4 (graph-context census): `groundPromptWithAnchor` below is
 * an OPTIONAL, additive pure helper POST /api/scene-planning/quick-gen calls
 * when the caller supplies an `anchorEntityId` — quick-gen's own design point
 * is an UNTETHERED ad-hoc scene, so there is often genuinely no anchor to
 * ground on (and as of this writing this route has no live frontend caller
 * at all, see the route's own doc comment), but the contract is ready for the
 * moment one is in play, reusing the SAME shared `buildAdjacencyContext`
 * (narrate.mjs) this project's other entity-centric LLM calls use rather than
 * quick-gen staying context-free by omission. `quickGenerate` itself is
 * UNCHANGED — still exactly one call, no templating of its own; grounding is
 * plain string composition the caller (the route) does before calling it.
 */
import { callModelDetailed } from "./llm-call.mjs";
import { buildAdjacencyContext } from "./narrate.mjs";

/**
 * The same fast/cheap model choice Phase 8's rubber-duck framing calls
 * already established for this project's "genuinely fast" bar.
 */
export const DEFAULT_QUICK_GEN_MODEL = "claude-haiku-4-5";

/**
 * @param {string} prompt          the FULLY-COMPOSED prompt text -- this
 *                                 function does no templating of its own.
 * @param {object} [opts]
 * @param {object} [opts.client]   injectable Anthropic-SDK-shaped client
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]    defaults to DEFAULT_QUICK_GEN_MODEL
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{text:string, truncated:boolean}>}   the same shape
 *                                 callModelDetailed itself already returns.
 */
export async function quickGenerate(prompt, opts = {}) {
  return callModelDetailed(prompt, { ...opts, model: opts.model ?? DEFAULT_QUICK_GEN_MODEL });
}

/**
 * Prepend real world-graph context (the anchor entity's own label + its
 * immediate graph neighbors) onto a caller-composed quick-gen prompt — pure,
 * no LLM call, directly unit-testable without a client. A no-op (returns
 * `prompt` verbatim) when `anchorEntityId` is falsy, so every EXISTING
 * context-free call of quickGenerate stays byte-for-byte unaffected.
 *
 * @param {string} prompt
 * @param {object[]} entities   live snapshot entities
 * @param {object[]} edges      live snapshot edges
 * @param {string} [anchorEntityId]
 * @returns {string}
 */
export function groundPromptWithAnchor(prompt, entities, edges, anchorEntityId) {
  if (!anchorEntityId) return prompt;
  const { entityLabel, neighborDescriptions } = buildAdjacencyContext(entities, edges, anchorEntityId);
  const contextBlock =
    `World graph context — ${entityLabel}` +
    (neighborDescriptions.length ? `, near: ${neighborDescriptions.join(", ")}` : "") +
    `. Ground the result in this if it fits.\n\n`;
  return `${contextBlock}${prompt}`;
}
