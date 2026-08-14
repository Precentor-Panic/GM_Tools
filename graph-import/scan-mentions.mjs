/**
 * Scan for mentioned entities — pure Node, LLM-dependent (same category as
 * graph-import/writeup-import.mjs's proposeWfiFromWriteup: a real Anthropic
 * API call, same llm-call.mjs plumbing).
 *
 * Phase 12 task 12.5. Given a block of text (primarily Phase 11's already-
 * displayed generated prep content) written FROM THE PERSPECTIVE OF one
 * already-committed graph entity (the "source entity"), scan it for OTHER
 * named entities it mentions, and produce two genuinely distinct result
 * kinds:
 *   - LINK: the mention's name+type matches an entity that already exists
 *     in the live graph — propose a new EDGE from the source entity to that
 *     existing entity. The existing entity itself is never touched.
 *   - PROPOSE-NEW: the mention doesn't match anything — propose creating a
 *     brand-new entity (name/type/short description) AND an edge to it.
 *
 * Dedup reuses writeup-import.mjs's OWN previewWriteupImport (which itself
 * reuses interchange.mjs's importGraph findExisting -- see that module's own
 * top-of-file note on why this project never reimplements that matching)
 * rather than a second name+type comparison written from scratch here. This
 * is not just "the same algorithm" -- it is *literally the same function
 * call*, per the design doc's [DECIDED] "reuses writeup-import's existing
 * name+type dedup matching exactly."
 *
 * WHY LINK AND PROPOSE-NEW ARE GENUINELY DIFFERENT CODE PATHS, NOT COSMETIC
 * LABELS (the self-review remediation checklist's own explicit concern):
 * previewMentionScan's per-mention branch below produces a STRUCTURALLY
 * DIFFERENT mutation set for each kind -- a link is exactly ONE upsert_edge
 * mutation and NO entity mutation at all; a propose-new is exactly TWO
 * mutations (an upsert_entity create, and an upsert_edge to it). This isn't
 * one shape with a different `entityContext.scanResultKind` sticker; the
 * array of mutations produced is objectively different in length and
 * composition depending on which branch ran.
 *
 * Result review routes through the EXISTING accept/reject/regenerate review
 * flow (review-state.mjs's createBatch, exactly like writeup-import.mjs's
 * importWriteup) — per decision 3, an LLM-assisted graph extension always
 * stays gated, unlike task 12.3's manual-edit immediate-write path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { callModelDetailed, fillTemplate as fillTemplateShared, parseJsonResponse } from "../mutation-engine/llm-call.mjs";
import { createBatch } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { attachDiffs } from "../time-skip/run.mjs";
import { previewWriteupImport } from "./writeup-import.mjs";
// Phase 37.6 task 4 (graph-context census): scan-mentions was one of the
// audit's context-FREE call sites -- the source entity's own real graph
// neighborhood (buildAdjacencyContext, narrate.mjs's shared entity-centric
// builder, this project's default for a NEW call site like this one) is now
// grounding for the mention scan, same reasoning as the other entity-centric
// LLM calls that already reuse it.
import { buildAdjacencyContext } from "../mutation-engine/narrate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "scan-mentions.md"), "utf8");

export const DEFAULT_SCAN_MODEL = "claude-sonnet-5";
export const DEFAULT_SCAN_MAX_TOKENS = 2048;
// All mutations from one scan land in a single synthetic region, matching
// writeup-import.mjs's own WRITEUP_IMPORT_REGION_ID precedent (no BFS/
// connectivity clustering concept applies to a holistic text-scan pass) --
// its OWN region id, not a reused "writeup-import" label, so a batch
// headline correctly reads as a mention-scan, not a writeup import.
export const MENTION_SCAN_REGION_ID = "mention-scan";

// Default relationship for a freshly-proposed mention edge -- deliberately
// generic ("we don't yet know the real relationship, just that the source
// entity's own content mentions this one"); the review screen's editable
// relationship-type control (task 12.5's [DECIDED] shape) is exactly for
// refining this before accept, same convention task 12.3's own
// press-and-hold edge draw uses for a freshly-created manual edge.
export const DEFAULT_MENTION_RELATIONSHIP = "unspecified";

// Same MAX_WRITEUP_CHARS-style v1 length guard writeup-import.mjs already
// established (gm-tools-conventions: don't over-build chunking speculatively)
// -- scanned text is typically one entity's own prep-content field, orders
// of magnitude smaller than a whole writeup, but the guard costs nothing to
// reuse at the same threshold.
export const MAX_SCAN_CHARS = 40000;

export class ScanTextTooLargeError extends Error {
  constructor(message, { length, max } = {}) {
    super(message);
    this.name = "ScanTextTooLargeError";
    this.length = length;
    this.max = max;
  }
}

export class ScanValidationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "ScanValidationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

const EntityType = z.enum(["person", "place", "faction", "object", "event", "concept"]);

const MentionItem = z.object({
  name: z.string().min(1),
  type: EntityType,
  description: z.string().optional()
});

const MentionsResponse = z.object({ mentions: z.array(MentionItem) });

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

/** Renders buildAdjacencyContext's neighborDescriptions into the prompt's bullet-list shape, same convention element-assist.mjs's describeNeighborhood uses for its own (bespoke, richer) neighborhood section. */
export function renderNeighborhoodContext(neighborDescriptions) {
  if (!neighborDescriptions.length) return "(no recorded graph connections)";
  return neighborDescriptions.map((d) => `- ${d}`).join("\n");
}

/**
 * Task 12.5's LLM call: extract entity mentions from `scanText`, grounded in
 * whose content it is (`sourceEntity`) and, as of Phase 37.6 task 4, that
 * source entity's own real graph neighborhood. Same retry-once-then-typed-
 * error convention as proposeWfiFromWriteup/proposeFramingsFromWriteup.
 *
 * @param {string} scanText
 * @param {{name:string, type:string}} sourceEntity
 * @param {object} [opts]  same DI shape (client/apiKey/model/maxTokens) as every other LLM call site in this codebase
 * @param {string} [opts.neighborhoodContext]  pre-rendered graph-neighbor bullet list (renderNeighborhoodContext below); omit for "(no recorded graph connections)" -- scanForMentionedEntities always supplies this from the live snapshot, so this only defaults for a caller invoking proposeMentionedEntities directly without one
 * @returns {Promise<{mentions: Array<{name:string, type:string, description?:string}>}>}
 * @throws {ScanTextTooLargeError}
 * @throws {ScanValidationError}
 */
export async function proposeMentionedEntities(scanText, sourceEntity, opts = {}) {
  if (typeof scanText !== "string" || !scanText.trim()) {
    throw new Error("proposeMentionedEntities requires non-empty scanText.");
  }
  if (scanText.length > MAX_SCAN_CHARS) {
    throw new ScanTextTooLargeError(
      `Scan text is ${scanText.length} characters, over the ${MAX_SCAN_CHARS}-character v1 guard.`,
      { length: scanText.length, max: MAX_SCAN_CHARS }
    );
  }
  if (!sourceEntity?.name || !sourceEntity?.type) {
    throw new Error("proposeMentionedEntities requires sourceEntity.{name,type}.");
  }

  const basePrompt = fillTemplate({
    scanText,
    sourceEntityName: sourceEntity.name,
    sourceEntityType: sourceEntity.type,
    neighborhoodContext: opts.neighborhoodContext ?? "(no recorded graph connections)",
    retryNote: opts.note ? `Additional note: ${opts.note}` : ""
  });

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  let maxTokens = opts.maxTokens ?? DEFAULT_SCAN_MAX_TOKENS;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_SCAN_MODEL,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      lastError = new Error(`Model response was truncated at max_tokens=${maxTokens} before it finished.`);
      if (attempt < maxAttempts) {
        maxTokens *= 2;
        continue;
      }
      break;
    }

    try {
      const parsed = parseJsonResponse(raw);
      const validated = MentionsResponse.parse(parsed);
      return { mentions: validated.mentions };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error — fix it and respond with ONLY ` +
          `the corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new ScanValidationError(`Scan-for-mentions proposal failed validation twice: ${lastError?.message}`, {
    attempts: maxAttempts,
    lastError,
    rawResponse: lastRaw
  });
}

// ---------------------------------------------------------------------------
// Phase 13 task 13.4: lightweight deterministic pre-pass. The project owner's
// own observation: generated content tends to already use "the right names"
// (it's grounded in real graph context per Phase 10/11's adjacency-aware
// generation), so a cheap, deterministic, non-LLM check over the existing
// graph's entity names should catch SOME matches that only get proposed as
// new today because the LLM's own extracted name is an imperfect match for
// what's actually a real existing entity (a dropped filler word, a minor
// spelling variant) -- exactly the class of thing findExisting's own EXACT
// case-insensitive name+type comparison (interchange.mjs) can never catch by
// construction. Runs ALONGSIDE the exact matcher, never replacing it, and
// exists specifically to REDUCE (not eliminate) how often task 13.3's
// "Link to existing instead" correction is needed -- imperfect matching is
// expected and fine; 13.3 covers the rest.
//
// Friction Wave 1 (W1a): the implementation moved VERBATIM to the shared
// graph-import/name-similarity.mjs (the review UI's near-match chips and the
// writeup-import near-miss normalization now need the same primitives), and
// is re-exported here so every existing importer of this module keeps
// working unchanged. This module's own call sites (applyFuzzyPrepass in
// previewMentionScan below) behave identically -- the moved code is the
// same code.
// ---------------------------------------------------------------------------
import {
  nameSimilarity,
  FUZZY_MATCH_THRESHOLD,
  findFuzzyEntityMatch,
  applyFuzzyPrepass
} from "./name-similarity.mjs";
export { nameSimilarity, FUZZY_MATCH_THRESHOLD, findFuzzyEntityMatch, applyFuzzyPrepass };

/**
 * Task 12.5's dedup + mutation-shaping step: classify each mention as LINK
 * or PROPOSE-NEW by reusing writeup-import.mjs's previewWriteupImport (which
 * reuses importGraph's own findExisting), then build the genuinely different
 * mutation set each kind requires (see this module's own top-of-file note).
 * Phase 13 task 13.4's fuzzy pre-pass (applyFuzzyPrepass, above) runs first,
 * so a near-miss name gets a real chance to resolve as a LINK via the same
 * exact-match path a genuine match would take.
 *
 * @param {Array<{name:string, type:string, description?:string}>} mentions
 * @param {string} sourceEntityId  the entity whose content was scanned — every produced edge originates here
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]  injectable id generator, forwarded to previewWriteupImport
 * @returns {{mutations:object[], linkCount:number, newCount:number}}
 */
export function previewMentionScan(mentions, sourceEntityId, existingSnapshot, opts = {}) {
  const existing = {
    entities: existingSnapshot.entities ?? [],
    edges: existingSnapshot.edges ?? [],
    entityTypes: existingSnapshot.entityTypes ?? []
  };
  const sourceEntity = existing.entities.find((e) => e.id === sourceEntityId);
  if (!sourceEntity) {
    throw new Error(`No entity "${sourceEntityId}" found in the live graph — cannot scan its content for mentions.`);
  }
  if (!mentions.length) {
    return { mutations: [], linkCount: 0, newCount: 0 };
  }

  const existingEntityIdSet = new Set(existing.entities.map((e) => e.id));
  const prepassedMentions = applyFuzzyPrepass(mentions, existing.entities);

  // The one and only place THIS module reuses writeup-import's real name+type
  // dedup -- no edges passed in (mentions carry no edges of their own; every
  // edge below is constructed by THIS function, from sourceEntityId out to
  // each mention's resolved id), so previewWriteupImport's returned
  // `mutations` array is exactly one upsert_entity per mention, in order
  // (see that function's own doc comment: with createMissingEndpoints left
  // at its default and zero edges in the input, no stub entities are ever
  // created either).
  const proposal = {
    entities: prepassedMentions.map((m, i) => ({
      name: m.name,
      type: m.type,
      description: m.description,
      rationale: m.fuzzyMatchedFrom
        ? `Mentioned in ${sourceEntity.name}'s content as "${m.fuzzyMatchedFrom}" — matched to the existing entity "${m.name}" by the deterministic name-similarity pre-pass (task 13.4).`
        : `Mentioned in ${sourceEntity.name}'s content.`
    })),
    edges: []
  };
  const { mutations: entityMutations } = previewWriteupImport(proposal, existing, opts.makeId ? { makeId: opts.makeId } : {});

  const mutations = [];
  let linkCount = 0;
  let newCount = 0;

  entityMutations.forEach((entityMutation, i) => {
    const mention = mentions[i];
    const prepassed = prepassedMentions[i];
    const matchedExisting = existingEntityIdSet.has(entityMutation.id);

    if (matchedExisting) {
      // LINK: the entity itself is untouched -- ONLY an edge mutation, no
      // upsert_entity at all. This is the structural difference from the
      // propose-new branch below, not a label difference.
      linkCount++;
      const rationale = prepassed.fuzzyMatchedFrom
        ? `"${mention.name}" is mentioned in ${sourceEntity.name}'s content and closely matches the existing entity "${entityMutation.data.name}" (caught by the deterministic name-similarity pre-pass, not an exact name match) — proposing a link rather than a duplicate.`
        : `"${mention.name}" is mentioned in ${sourceEntity.name}'s content and already exists in the graph as this entity — proposing a link rather than a duplicate.`;
      mutations.push({
        op: "upsert_edge",
        data: { sourceId: sourceEntityId, targetId: entityMutation.id, relationshipType: DEFAULT_MENTION_RELATIONSHIP },
        rationale,
        batchId: "placeholder",
        sourceKind: "mention-scan",
        regionId: MENTION_SCAN_REGION_ID,
        entityContext: { scanResultKind: "link", name: entityMutation.data.name, type: entityMutation.data.type }
      });
    } else {
      // PROPOSE-NEW: the entity create AND the edge to it, together.
      newCount++;
      mutations.push({
        ...entityMutation,
        // previewWriteupImport (reused above for its dedup, not its
        // provenance labeling) stamps sourceKind:'writeup-import' onto every
        // mutation it builds -- override it here so this module's own
        // creates are correctly auditable as 'mention-scan', matching every
        // OTHER mutation this function produces.
        sourceKind: "mention-scan",
        regionId: MENTION_SCAN_REGION_ID,
        entityContext: { scanResultKind: "new", name: entityMutation.data.name, type: entityMutation.data.type, importance: entityMutation.data.importance, tags: entityMutation.data.tags }
      });
      mutations.push({
        op: "upsert_edge",
        data: { sourceId: sourceEntityId, targetId: entityMutation.id, relationshipType: DEFAULT_MENTION_RELATIONSHIP },
        rationale: `"${mention.name}" is mentioned in ${sourceEntity.name}'s content and doesn't match any existing entity — proposing a new entity and a link to it.`,
        batchId: "placeholder",
        sourceKind: "mention-scan",
        regionId: MENTION_SCAN_REGION_ID,
        entityContext: { scanResultKind: "new", name: entityMutation.data.name, type: entityMutation.data.type }
      });
    }
  });

  return { mutations, linkCount, newCount };
}

/**
 * Task 12.5 end to end: propose mentions (LLM), classify+shape them
 * (previewMentionScan), attach live-snapshot diffs (same diff.mjs path
 * wf_propose_mutations/importWriteup already use), persist as a normal
 * review-state.mjs batch.
 *
 * @param {string} world
 * @param {string} sourceEntityId
 * @param {string} scanText
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot
 * @param {object} [opts]
 * @param {object} [opts.llmOpts]
 * @param {() => string} [opts.makeId]  batch id generator, injectable for tests
 * @returns {Promise<{batchId:string, mutationCount:number, linkCount:number, newCount:number, headline:string}>}
 */
export async function scanForMentionedEntities(world, sourceEntityId, scanText, existingSnapshot, opts = {}) {
  const sourceEntity = (existingSnapshot.entities ?? []).find((e) => e.id === sourceEntityId);
  if (!sourceEntity) {
    throw new Error(`No entity "${sourceEntityId}" found in the live graph — cannot scan its content for mentions.`);
  }
  // Phase 37.6 task 4: ground the scan in the source entity's own real graph
  // neighborhood (buildAdjacencyContext), same shared builder narrate.mjs's
  // other entity-centric callers already use.
  const { neighborDescriptions } = buildAdjacencyContext(existingSnapshot.entities ?? [], existingSnapshot.edges ?? [], sourceEntityId);
  const { mentions } = await proposeMentionedEntities(scanText, sourceEntity, {
    ...(opts.llmOpts ?? {}),
    neighborhoodContext: renderNeighborhoodContext(neighborDescriptions)
  });
  const { mutations, linkCount, newCount } = previewMentionScan(mentions, sourceEntityId, existingSnapshot, opts);
  const diffed = attachDiffs(mutations, existingSnapshot.entities ?? [], existingSnapshot.edges ?? []);

  const batch = createBatch(
    world,
    { mode: "mention-scan", sourceEntityId, sourceEntityName: sourceEntity.name, text: scanText },
    undefined,
    diffed,
    opts.makeId ? { makeId: opts.makeId } : {}
  );
  const batchSummary = summarizeBatch(batch);

  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    linkCount,
    newCount,
    headline: renderHeadline(batchSummary)
  };
}
