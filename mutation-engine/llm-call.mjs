/**
 * Shared LLM-call plumbing — pure except for the outbound network call
 * itself, unit-testable via opts.client injection like everything else
 * that calls it.
 *
 * Extracted during Phase 2's remediation pass: mutation-engine/texture.mjs's
 * texturing pass and time-skip/resolve-seed.mjs's seed resolution had grown
 * near-identical callModel/fillTemplate/JSON-fence-stripping helpers once a
 * second real outbound-LLM call site existed (texture.mjs was the only one
 * during Phase 1, so the duplication wasn't real yet). Per gm-tools-
 * conventions ("reuse existing primitives before writing new ones" / stop
 * if you're writing the same logic twice), this is the single home for that
 * plumbing now — both modules import from here rather than each keeping
 * their own copy.
 */
import Anthropic from "@anthropic-ai/sdk";

/** Fill `{{key}}` placeholders in a prompt template from a flat vars object. */
export function fillTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/** Strip a leading/trailing ```json ... ``` markdown fence, if the model added one despite being asked not to. */
export function stripCodeFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

/** Parse a JSON value out of a model's raw text response, tolerating a markdown code fence. */
export function parseJsonResponse(text) {
  return JSON.parse(stripCodeFences(text));
}

/**
 * Call an Anthropic-SDK-shaped client with a single user-role text prompt,
 * returning the raw text plus whether the response was cut off by hitting
 * max_tokens before the model finished (stop_reason === "max_tokens").
 *
 * Exposing truncation explicitly matters: a truncated response is usually
 * still handed to a JSON parser downstream, which produces a generic,
 * confusing SyntaxError ("unexpected end of JSON input", "unterminated
 * string", etc. depending on exactly where the cut lands) that looks like a
 * quoting/escaping problem with the input text but is actually just "the
 * budget was too small for this answer" -- a real bug found via first hands-on
 * use of writeup-import (Phase 8): the same short, special-character-free
 * writeup still failed with "unexpected end of JSON output", which is only
 * explicable by truncation, not malformed input.
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {object} [opts.client]  injectable Anthropic-SDK-shaped client (for tests / DI) --
 *                                 if omitted, a real client is constructed from opts.apiKey
 * @param {string} [opts.apiKey]
 * @param {string} opts.model     the caller resolves its own default (e.g.
 *                                 `opts.model ?? DEFAULT_TEXTURE_MODEL`) before calling --
 *                                 this function has no opinion on what model to default to,
 *                                 since different call sites want different defaults
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export async function callModelDetailed(prompt, opts) {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    messages: [{ role: "user", content: prompt }]
  });
  const textBlock = (response.content ?? []).find((b) => b.type === "text");
  return { text: textBlock?.text ?? "", truncated: response.stop_reason === "max_tokens" };
}

/**
 * Convenience wrapper over callModelDetailed for callers that don't (yet)
 * check truncation themselves -- returns just the text, same as before this
 * was split out. Prefer callModelDetailed for any new call site that retries
 * on failure, since truncation should bump the token budget, not just resend
 * the same prompt with a "please fix it" note (which cannot fix a budget
 * problem).
 *
 * @returns {Promise<string>}
 */
export async function callModel(prompt, opts) {
  const { text } = await callModelDetailed(prompt, opts);
  return text;
}
