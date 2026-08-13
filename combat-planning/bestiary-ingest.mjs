/**
 * Bestiary ingestion — Phase 18 task 18.1. LLM extraction ONLY, no scoring.
 *
 * Design record §1a / §5's review: the LLM extracts RAW FIELDS from a
 * pasted-text or PDF stat block, never a derived power/threat score.
 * Scoring is combat-planning/action-economy.mjs's job (task 18.3), a
 * separate pure function consuming this module's output — three independent
 * reviewers converged on this split because an LLM silently
 * mis-weighting a recharge ability (or double/under-counting multiattack)
 * would poison a score a downstream heuristic then treats as ground truth.
 *
 * PDF input: no new npm dependency for PDF parsing (design record §1's
 * explicit instruction) — Claude's Messages API accepts a `document`
 * content block natively, and mutation-engine/llm-call.mjs's
 * callModelDetailed(prompt, opts) already passes `prompt` straight through
 * as the Anthropic SDK's `content` field, which accepts either a string or a
 * content-block array. Verified live against the real API before this file
 * was written (task 18.1's own first-thing-to-do instruction): a small
 * hand-built single-page PDF containing a stat block, sent as
 * `[{type:"document", source:{type:"base64", media_type:"application/pdf",
 * data}}, {type:"text", text: extractionPrompt}]`, round-tripped correctly
 * with zero changes to llm-call.mjs — confirming the PDF-content-block
 * assumption this module (and party-roster-ingest.mjs) is built on.
 *
 * Same retry-once-on-truncation / retry-once-on-validation-failure / then
 * typed-error convention as graph-import/writeup-import.mjs's
 * proposeWfiFromWriteup, factored into combat-planning/llm-extract.mjs so
 * this module and party-roster-ingest.mjs/thematic-filter.mjs don't each
 * carry their own drifting copy of that loop.
 *
 * Phase 37.6 task 4 (graph-context census) RATIONALE: this call site stays
 * deliberately context-free — no World Fabric graph context (buildAdjacencyContext
 * or otherwise) is threaded into this prompt, and that's intentional, not an
 * oversight the census missed. This is stat-block PARSING: the input is a
 * pasted block of monster mechanics (or a PDF page of one) with a fixed,
 * self-contained field vocabulary (AC/HP/speed/actions/etc.) that means the
 * same thing regardless of which world or campaign it's being added to.
 * World-graph context would be pure noise here — it can't help extract a
 * number or an ability text more accurately, and risks the model trying to
 * (wrongly) reconcile the stat block against unrelated campaign lore instead
 * of just transcribing what's on the page. party-roster-ingest.mjs's own
 * extraction call is the same shape, same reasoning — see its own header.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fillTemplate as fillTemplateShared } from "../mutation-engine/llm-call.mjs";
import { extractWithRetry, parseJsonResponse } from "./llm-extract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "bestiary-ingest.md"), "utf8");

export const DEFAULT_BESTIARY_INGEST_MODEL = "claude-sonnet-5";
export const DEFAULT_BESTIARY_INGEST_MAX_TOKENS = 2048;

export class BestiaryExtractionValidationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "BestiaryExtractionValidationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

// --- RawBestiaryFields schema -------------------------------------------
// Deliberately NOT .strict(): zod's default object behavior strips unknown
// keys rather than passing them through, which is exactly what enforces
// this module's hardest contract (bestiary-ingest.test.mjs's own framing)
// -- a `score`/`actionEconomyScore`/`threatScore` field the model adds
// despite instructions is silently dropped here, not merely undocumented.

const RawAttack = z.object({
  name: z.string(),
  toHitBonus: z.number().optional(),
  damageDice: z.string(),
  damageType: z.string().optional()
});

const RawMultiattack = z.object({
  count: z.number(),
  attackNames: z.array(z.string()).optional()
});

const RawRechargeAbility = z.object({
  name: z.string(),
  rechargeOn: z.string(),
  damageDice: z.string().optional()
});

const RawLegendaryActions = z.object({
  count: z.number(),
  costPerAction: z.number().optional()
});

export const RawBestiaryFields = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  challengeRating: z.union([z.string(), z.number()]).optional(),
  level: z.number().optional(),
  hp: z.number(),
  ac: z.number(),
  attacks: z.array(RawAttack).optional().default([]),
  multiattack: RawMultiattack.optional(),
  rechargeAbilities: z.array(RawRechargeAbility).optional(),
  legendaryActions: RawLegendaryActions.optional(),
  lairEffects: z.boolean().optional(),
  auraEffects: z.array(z.string()).optional(),
  appliedEffects: z.array(z.string()).optional()
});

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

function noteSection(opts) {
  return opts.note ? `Additional note from the reviewer: ${opts.note}` : "";
}

/**
 * @param {string} text                pasted stat-block text
 * @param {object} [opts]
 * @returns {Promise<object>}          RawBestiaryFields-shaped, no score field
 * @throws {BestiaryExtractionValidationError}
 */
export async function proposeBestiaryEntryFromText(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("proposeBestiaryEntryFromText requires non-empty text.");
  }
  const basePrompt = fillTemplate({
    sourceSection: `## Stat block text\n\n${text}`,
    retryNote: noteSection(opts)
  });

  return extractWithRetry({
    buildContent: (failureNote) => basePrompt + failureNote,
    parse: (raw) => RawBestiaryFields.parse(parseJsonResponse(raw)),
    opts,
    ErrorClass: BestiaryExtractionValidationError,
    errorLabel: "bestiary extraction",
    defaultModel: DEFAULT_BESTIARY_INGEST_MODEL,
    defaultMaxTokens: DEFAULT_BESTIARY_INGEST_MAX_TOKENS
  });
}

/**
 * @param {string} pdfBase64
 * @param {object} [opts]               same as proposeBestiaryEntryFromText
 * @returns {Promise<object>}
 * @throws {BestiaryExtractionValidationError}
 */
export async function proposeBestiaryEntryFromPdf(pdfBase64, opts = {}) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) {
    throw new Error("proposeBestiaryEntryFromPdf requires non-empty pdfBase64.");
  }
  const baseNote = noteSection(opts);

  return extractWithRetry({
    buildContent: (failureNote) => [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      {
        type: "text",
        text: fillTemplate({
          sourceSection: "The stat block is provided as an attached PDF document -- read it directly.",
          retryNote: baseNote + failureNote
        })
      }
    ],
    parse: (raw) => RawBestiaryFields.parse(parseJsonResponse(raw)),
    opts,
    ErrorClass: BestiaryExtractionValidationError,
    errorLabel: "bestiary extraction",
    defaultModel: DEFAULT_BESTIARY_INGEST_MODEL,
    defaultMaxTokens: DEFAULT_BESTIARY_INGEST_MAX_TOKENS
  });
}
