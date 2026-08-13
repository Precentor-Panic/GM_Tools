/**
 * Party roster ingestion — Phase 18 task 18.2. Same extraction-ONLY shape as
 * combat-planning/bestiary-ingest.mjs (18.1), applied to PC character sheets
 * instead of monster stat blocks.
 *
 * Design record §1b: extracted fields split into TWO STRUCTURALLY SEPARATE
 * groups with two different downstream consumers -- combatRelevant feeds
 * combat-planning/action-economy.mjs + the encounter heuristic (18.3-18.5);
 * buildRelevant feeds getPartyContext() (18.6) ONLY, never the combat
 * heuristic. Enforced structurally (not just documented) by the zod schema
 * below: each group only recognizes its own field names, so a model that
 * mis-places a field puts it where the schema silently strips it, same
 * "unknown keys stripped, not passed through" mechanism
 * bestiary-ingest.mjs's RawBestiaryFields relies on to keep a stray `score`
 * field out.
 *
 * Same PDF-content-block mechanism as bestiary-ingest.mjs (verified live
 * against the real API in that task) and the same retry-once-on-truncation /
 * retry-once-on-validation-failure / typed-error convention, via
 * combat-planning/llm-extract.mjs.
 *
 * Phase 37.6 task 4 (graph-context census) RATIONALE: same as
 * bestiary-ingest.mjs's own note — deliberately context-free. This is
 * character-SHEET parsing (AC/HP/class/level/spell slots/etc.), a
 * self-contained field vocabulary that means the same thing regardless of
 * which world/campaign it's being added to; World Fabric graph context would
 * be noise, not grounding, for transcribing what's on the sheet.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fillTemplate as fillTemplateShared } from "../mutation-engine/llm-call.mjs";
import { extractWithRetry, parseJsonResponse } from "./llm-extract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "party-roster-ingest.md"), "utf8");

export const DEFAULT_PARTY_ROSTER_INGEST_MODEL = "claude-sonnet-5";
export const DEFAULT_PARTY_ROSTER_INGEST_MAX_TOKENS = 2048;

export class PartyRosterExtractionValidationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "PartyRosterExtractionValidationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

const CombatRelevant = z
  .object({
    class: z.string().optional(),
    level: z.number().optional(),
    ac: z.number().optional(),
    hp: z.number().optional(),
    attackBonus: z.number().optional(),
    damagePerRoundEstimate: z.number().optional(),
    saveDCs: z.record(z.string(), z.number()).optional(),
    notableAbilities: z.array(z.string()).optional()
  })
  .default({});

const BuildRelevant = z
  .object({
    skills: z.array(z.string()).optional(),
    expertise: z.array(z.string()).optional(),
    notableTraits: z.array(z.string()).optional(),
    backstoryHooks: z.array(z.string()).optional()
  })
  .default({});

export const RawPartyMemberFields = z.object({
  name: z.string().min(1),
  combatRelevant: CombatRelevant,
  buildRelevant: BuildRelevant
});

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

function noteSection(opts) {
  return opts.note ? `Additional note from the reviewer: ${opts.note}` : "";
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @returns {Promise<object>}   RawPartyMemberFields-shaped
 * @throws {PartyRosterExtractionValidationError}
 */
export async function proposePartyMemberFromText(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("proposePartyMemberFromText requires non-empty text.");
  }
  const basePrompt = fillTemplate({
    sourceSection: `## Character sheet text\n\n${text}`,
    retryNote: noteSection(opts)
  });

  return extractWithRetry({
    buildContent: (failureNote) => basePrompt + failureNote,
    parse: (raw) => RawPartyMemberFields.parse(parseJsonResponse(raw)),
    opts,
    ErrorClass: PartyRosterExtractionValidationError,
    errorLabel: "party-roster extraction",
    defaultModel: DEFAULT_PARTY_ROSTER_INGEST_MODEL,
    defaultMaxTokens: DEFAULT_PARTY_ROSTER_INGEST_MAX_TOKENS
  });
}

/**
 * @param {string} pdfBase64
 * @param {object} [opts]
 * @returns {Promise<object>}
 * @throws {PartyRosterExtractionValidationError}
 */
export async function proposePartyMemberFromPdf(pdfBase64, opts = {}) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) {
    throw new Error("proposePartyMemberFromPdf requires non-empty pdfBase64.");
  }
  const baseNote = noteSection(opts);

  return extractWithRetry({
    buildContent: (failureNote) => [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      {
        type: "text",
        text: fillTemplate({
          sourceSection: "The character sheet is provided as an attached PDF document -- read it directly.",
          retryNote: baseNote + failureNote
        })
      }
    ],
    parse: (raw) => RawPartyMemberFields.parse(parseJsonResponse(raw)),
    opts,
    ErrorClass: PartyRosterExtractionValidationError,
    errorLabel: "party-roster extraction",
    defaultModel: DEFAULT_PARTY_ROSTER_INGEST_MODEL,
    defaultMaxTokens: DEFAULT_PARTY_ROSTER_INGEST_MAX_TOKENS
  });
}
