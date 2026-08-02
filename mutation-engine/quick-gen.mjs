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
 */
import { callModelDetailed } from "./llm-call.mjs";

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
