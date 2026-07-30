/**
 * Thematic filter — Phase 18 task 18.5. THE ONE LLM-TOUCHING PIECE of the
 * encounter-suggestion pipeline, deliberately kept in its own separate
 * module so combat-planning/encounter-heuristic.mjs's deterministic core
 * stays LLM-free and independently testable without mocking a client.
 *
 * Design record §2's closing paragraph: "given the current scene's context
 * (location, active threat, faction present -- pulled straight from the
 * graph, the same grounding pattern narrate.mjs's buildAdjacencyContext
 * already uses), suggest which bestiary tags/types fit thematically. It
 * narrows the candidate pool by fit; the heuristic picks the actual roster
 * by math. The LLM never decides final difficulty or composition."
 *
 * This module never builds its own grounding context — it consumes
 * mutation-engine/narrate.mjs's buildAdjacencyContext output as-is (the
 * caller, e.g. a future review-ui route, is responsible for calling it
 * first). Same retry-once-on-truncation / retry-once-on-validation-failure
 * / typed-error convention as every other LLM-touching module in this
 * codebase, via combat-planning/llm-extract.mjs — with one EXTRA validation
 * rule specific to this module: a filteredEntryIds value the model invents
 * that wasn't in the input candidatePool is treated as a validation
 * failure (triggering the same retry-once path), never silently passed
 * through -- this module narrows an existing pool, it does not invent new
 * monsters.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fillTemplate as fillTemplateShared } from "../mutation-engine/llm-call.mjs";
import { extractWithRetry, parseJsonResponse } from "./llm-extract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "thematic-filter.md"), "utf8");

export const DEFAULT_THEMATIC_FILTER_MODEL = "claude-sonnet-5";
export const DEFAULT_THEMATIC_FILTER_MAX_TOKENS = 1024;

export class ThematicFilterValidationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "ThematicFilterValidationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

const ThematicFilterResponse = z.object({
  filteredEntryIds: z.array(z.string()),
  rationale: z.string()
});

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

/**
 * @param {{entityLabel:string, neighborDescriptions:string[]}} sceneContext   buildAdjacencyContext's own output shape
 * @param {Array<{entryId:string, rawFields:object}>} candidatePool
 * @param {object} [opts]
 * @returns {Promise<{filteredEntryIds:string[], rationale:string}>}
 * @throws {ThematicFilterValidationError}
 */
export async function proposeThematicTags(sceneContext, candidatePool, opts = {}) {
  const poolIds = new Set(candidatePool.map((c) => c.entryId));
  const basePrompt = fillTemplate({
    entityLabel: sceneContext?.entityLabel ?? "(not specified)",
    neighborDescriptions: (sceneContext?.neighborDescriptions ?? []).join(", ") || "(none)",
    candidatePoolJson: JSON.stringify(
      candidatePool.map((c) => ({ entryId: c.entryId, name: c.rawFields?.name, type: c.rawFields?.type })),
      null,
      2
    ),
    retryNote: opts.note ? `Additional note from the reviewer: ${opts.note}` : ""
  });

  return extractWithRetry({
    buildContent: (failureNote) => basePrompt + failureNote,
    parse: (raw) => {
      const parsed = ThematicFilterResponse.parse(parseJsonResponse(raw));
      const invalidIds = parsed.filteredEntryIds.filter((id) => !poolIds.has(id));
      if (invalidIds.length > 0) {
        throw new Error(
          `filteredEntryIds contained id(s) not present in the input candidatePool: ${invalidIds.join(", ")}. ` +
          `Only ever return ids that were given to you in the candidate pool -- never invent a new one.`
        );
      }
      return parsed;
    },
    opts,
    ErrorClass: ThematicFilterValidationError,
    errorLabel: "thematic filter",
    defaultModel: DEFAULT_THEMATIC_FILTER_MODEL,
    defaultMaxTokens: DEFAULT_THEMATIC_FILTER_MAX_TOKENS
  });
}
