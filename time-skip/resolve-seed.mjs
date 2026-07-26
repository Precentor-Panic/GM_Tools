/**
 * LLM-inferred seed resolution — the mutation engine's second outward-facing
 * Anthropic API call (alongside mutation-engine/texture.mjs's texturing
 * pass). Given a freeform GM event description ("the tavern owner dies"),
 * resolves it to a graph entity id via an LLM call against the candidate
 * entity list.
 *
 * Deliberately kept separate from time-skip/scope.mjs's resolveScope()
 * (Phase 2 task 2.2b's explicit instruction) -- resolveScope is pure/
 * deterministic and cheap to verify (propagate.mjs-style unit tests, no
 * mocking needed), which is exactly what made it fast to build and trust.
 * Seed inference is fundamentally LLM-dependent and needs texture.mjs's
 * test pattern instead: a unit test with the API call mocked (orchestration/
 * validation/retry logic), plus a documented manual/integration smoke test.
 *
 * Mirrors texture.mjs's shape closely on purpose (same retry-once ->
 * typed-error-on-second-failure convention, same DI opts.client/apiKey/
 * model/maxTokens) -- this is the second module in the codebase making an
 * outbound LLM call, and there's no reason to invent a second pattern for it.
 * callModel/fillTemplate/JSON-fence-stripping are shared with texture.mjs
 * via mutation-engine/llm-call.mjs (extracted during Phase 2's remediation
 * pass once this became the second real call site — see that module's own
 * doc comment).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { callModelDetailed, fillTemplate as fillTemplateShared, parseJsonResponse } from "../mutation-engine/llm-call.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "resolve-seed.md"), "utf8");

export const DEFAULT_RESOLVE_SEED_MODEL = "claude-sonnet-5";

/**
 * Thrown for the two genuinely-exceptional outcomes: no entity plausibly
 * matches ('no-match' -- a typed error, not a silent no-op, per this task's
 * acceptance criterion), or the model's output never validates after one
 * retry ('invalid-response', mirroring texture.mjs's TextureValidationError).
 * The THIRD possible outcome, 'ambiguous' (multiple plausible candidates),
 * is deliberately NOT an error -- resolveSeed() returns it as a normal
 * result (`{status:'ambiguous', candidates:[...]}`) so a caller can present
 * the candidates and ask, rather than the caller having to catch-and-unwrap
 * an exception for an expected, non-exceptional outcome.
 */
export class SeedResolutionError extends Error {
  constructor(message, { kind, reason, rawResponse, attempts, lastError } = {}) {
    super(message);
    this.name = "SeedResolutionError";
    this.kind = kind; // 'no-match' | 'invalid-response'
    this.reason = reason;
    this.rawResponse = rawResponse;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

const Candidate = z.object({
  entityId: z.string(),
  name: z.string(),
  reason: z.string()
});

const RawResolution = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.literal("single"), entityId: z.string(), rationale: z.string() }),
  z.object({ resolution: z.literal("ambiguous"), candidates: z.array(Candidate).min(2) }),
  z.object({ resolution: z.literal("no-match"), reason: z.string() })
]);

function renderEntityContext(entities) {
  return entities
    .map((e) => `${e.name} (${e.type}) [id=${e.id}]: ${e.summary || e.description || "(no description)"}`)
    .join("\n");
}

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

/**
 * Resolve a freeform event description to a graph entity id.
 *
 * @param {string} eventDescription  e.g. "the tavern owner dies"
 * @param {{entities:object[], edges?:object[]}} snapshot  candidate entities to match against
 *   (the caller is responsible for narrowing this to a relevant subset for large graphs --
 *   e.g. via wf_get_context's budgeted serialization -- this function does not itself budget)
 * @param {object} [opts]
 * @param {object} [opts.client]  injectable Anthropic-SDK-shaped client (for tests / DI)
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<
 *   {status:'resolved', entityId:string, name:string, rationale:string} |
 *   {status:'ambiguous', candidates:Array<{entityId:string,name:string,reason:string}>}
 * >}
 * @throws {SeedResolutionError} kind='no-match' when nothing in the candidate list plausibly
 *   matches; kind='invalid-response' if the model's output never validates after one retry
 */
export async function resolveSeed(eventDescription, snapshot, opts = {}) {
  const { entities } = snapshot;
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const entityContext = renderEntityContext(entities) || "(no entities)";

  const basePrompt = fillTemplate({ eventDescription, entityContext, retryNote: "" });

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  // maxTokens default (1024) preserved explicitly here, distinct from
  // llm-call.mjs's own 2048 default -- a resolution response is much
  // shorter than a texturing response, no reason to share that default.
  let maxTokens = opts.maxTokens ?? 1024;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_RESOLVE_SEED_MODEL,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      // Same truncation-vs-content-problem reasoning as texture.mjs's
      // textureRegion / graph-import/writeup-import.mjs's
      // proposeWfiFromWriteup -- most plausible trigger here is a genuinely
      // large 'ambiguous' candidate list (many plausible entities, each with
      // its own reason string), not a malformed response. Double the budget
      // and retry with the SAME prompt rather than resend the identical
      // budget and truncate at the same point again.
      lastError = new Error(
        `Model response was truncated at max_tokens=${maxTokens} before it finished -- the resolution for ` +
        `"${eventDescription}" was larger than the token budget allowed.`
      );
      if (attempt < maxAttempts) {
        maxTokens *= 2;
        continue;
      }
      break;
    }

    try {
      const parsed = parseJsonResponse(raw);
      const validated = RawResolution.parse(parsed);

      if (validated.resolution === "single") {
        if (!entityMap.has(validated.entityId)) {
          throw new Error(
            `Model returned entityId "${validated.entityId}", which is not in the candidate entity list.`
          );
        }
        return {
          status: "resolved",
          entityId: validated.entityId,
          name: entityMap.get(validated.entityId).name,
          rationale: validated.rationale
        };
      }

      if (validated.resolution === "ambiguous") {
        for (const c of validated.candidates) {
          if (!entityMap.has(c.entityId)) {
            throw new Error(
              `Model returned candidate entityId "${c.entityId}", which is not in the candidate entity list.`
            );
          }
        }
        return { status: "ambiguous", candidates: validated.candidates };
      }

      // validated.resolution === "no-match"
      throw new SeedResolutionError(
        `No entity plausibly matches "${eventDescription}": ${validated.reason}`,
        { kind: "no-match", reason: validated.reason, rawResponse: raw }
      );
    } catch (err) {
      if (err instanceof SeedResolutionError) throw err; // a real, final result -- not a retry-worthy failure
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error — fix it and respond with ONLY ` +
          `the corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new SeedResolutionError(
    `Seed resolution failed validation twice for "${eventDescription}": ${lastError?.message}`,
    { kind: "invalid-response", attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}
