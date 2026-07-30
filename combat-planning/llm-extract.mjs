/**
 * Shared LLM-extraction retry loop — Phase 18. Factors out the
 * retry-once-on-truncation (doubling maxTokens), retry-once-on-validation-
 * failure (re-prompting with the error), THEN throw-a-typed-error convention
 * that graph-import/writeup-import.mjs's proposeWfiFromWriteup/
 * proposeFramingsFromWriteup established, so combat-planning/
 * bestiary-ingest.mjs, party-roster-ingest.mjs, and thematic-filter.mjs
 * (three otherwise near-identical copies) share one implementation instead
 * of drifting independently.
 *
 * Deliberately still calls mutation-engine/llm-call.mjs's callModelDetailed
 * directly (this module is NOT itself Foundry-free/LLM-free — it exists
 * specifically for the LLM-touching ingestion/filter modules; it must never
 * be imported by combat-planning/encounter-heuristic.mjs, whose whole
 * contract is having no llm-call.mjs dependency at all).
 */
import { callModelDetailed, parseJsonResponse } from "../mutation-engine/llm-call.mjs";

/**
 * @param {object} args
 * @param {(failureNote: string) => (string|Array)} args.buildContent
 *   Builds this attempt's prompt content (a plain string OR an Anthropic
 *   content-block array). `failureNote` is `""` on the first attempt and a
 *   "your previous response failed validation..." explanation string on the
 *   validation-failure retry — the caller decides how to fold it in (a
 *   string prompt appends it directly; a content-block array typically
 *   appends it into its own trailing text block).
 * @param {(rawText: string) => any} args.parse
 *   Parses + validates the model's raw text, throwing on failure. Typically
 *   `(raw) => SomeZodSchema.parse(parseJsonResponse(raw))`.
 * @param {object} args.opts               forwarded to callModelDetailed (client/apiKey/model/maxTokens)
 * @param {Function} args.ErrorClass       thrown (typed) after two failed attempts
 * @param {string} args.errorLabel         human-readable label used in error messages (e.g. "bestiary extraction")
 * @param {string} args.defaultModel
 * @param {number} args.defaultMaxTokens
 * @returns {Promise<any>}                 parse()'s return value
 */
export async function extractWithRetry({
  buildContent,
  parse,
  opts,
  ErrorClass,
  errorLabel,
  defaultModel,
  defaultMaxTokens
}) {
  let maxTokens = opts.maxTokens ?? defaultMaxTokens;
  let failureNote = "";
  let lastError;
  let lastRaw;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const content = buildContent(failureNote);
    const { text: raw, truncated } = await callModelDetailed(content, {
      ...opts,
      model: opts.model ?? defaultModel,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      // Truncation is a budget problem, not a content problem -- resending
      // the identical content at the identical budget would just truncate
      // at the same point again (writeup-import.mjs's own reasoning).
      lastError = new Error(
        `Model response was truncated at max_tokens=${maxTokens} before it finished -- the ${errorLabel} was ` +
        `larger than the token budget allowed.`
      );
      if (attempt < maxAttempts) {
        maxTokens *= 2;
        continue;
      }
      break;
    }

    try {
      return parse(raw);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        failureNote =
          `\n\nYour previous response failed validation with this error -- fix it and respond with ONLY the ` +
          `corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
        continue;
      }
    }
  }

  throw new ErrorClass(
    `${errorLabel} failed validation twice: ${lastError?.message}`,
    { attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}

export { parseJsonResponse };
