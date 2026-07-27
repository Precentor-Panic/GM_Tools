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

/**
 * Task 12.5's LLM call: extract entity mentions from `scanText`, grounded in
 * whose content it is (`sourceEntity`). Same retry-once-then-typed-error
 * convention as proposeWfiFromWriteup/proposeFramingsFromWriteup.
 *
 * @param {string} scanText
 * @param {{name:string, type:string}} sourceEntity
 * @param {object} [opts]  same DI shape (client/apiKey/model/maxTokens) as every other LLM call site in this codebase
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
// ---------------------------------------------------------------------------

// A small, fixed stopword list for common filler words in a name/title (not
// a language-detection feature -- just enough to stop "Gorrim the Smith"
// vs "Gorrim Smith" from reading as two different sets of significant words).
const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "de", "van", "der"]);

function normalizeNameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_STOPWORDS.has(t));
}

/** Classic Levenshtein edit distance -- small, dependency-free, no external library per gm-tools-conventions' dependency discipline. */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = tmp;
    }
  }
  return dp[n];
}

/**
 * A simple, explainable 0..1 name-similarity score, taking the BETTER of two
 * cheap signals rather than one alone (each catches a different real-world
 * near-miss shape, confirmed by this module's own test cases):
 *   - token-Jaccard over significant (stopword-stripped) words -- catches a
 *     dropped/added filler word ("Gorrim the Smith" vs "Gorrim Smith").
 *   - single-token edit-distance ratio -- catches a minor spelling variant
 *     on an otherwise one-word name ("Osrik" vs "Osric"), which token-Jaccard
 *     alone would score as a complete (0%) mismatch since neither token
 *     equals the other exactly.
 * Two SIMILAR-LOOKING but genuinely different short names ("Kael" vs
 * "Kaelen") deliberately score LOW here -- neither signal considers a
 * same-length-ish but distinct single word a near-miss of a completely
 * different single word once the edit distance is a large fraction of its
 * length, and there is no shared significant token between them either.
 */
export function nameSimilarity(nameA, nameB) {
  const tokensA = normalizeNameTokens(nameA);
  const tokensB = normalizeNameTokens(nameB);
  if (!tokensA.length || !tokensB.length) return 0;

  const setA = new Set(tokensA), setB = new Set(tokensB);
  const intersectionSize = [...setA].filter((t) => setB.has(t)).length;
  const unionSize = new Set([...setA, ...setB]).size;
  const jaccard = unionSize ? intersectionSize / unionSize : 0;

  let typoRatio = 0;
  if (tokensA.length === 1 && tokensB.length === 1) {
    const [a] = tokensA, [b] = tokensB;
    const dist = levenshteinDistance(a, b);
    typoRatio = 1 - dist / Math.max(a.length, b.length);
  }

  return Math.max(jaccard, typoRatio);
}

// Deliberately conservative -- a false-positive LINK (silently merging two
// genuinely different entities) is a much worse outcome than a
// false-negative (missing a real near-miss, which task 13.3's manual "Link
// to existing instead" correction already covers). Confirmed against this
// module's own test cases: high enough that "Kael" vs "Kaelen" (two
// genuinely different people who merely sound alike, similarity ~0.67)
// does NOT qualify, while "Gorrim Smith" vs "Gorrim the Smith" (a dropped
// filler word, similarity 1.0 after stopword-stripped token comparison) and
// a single-character spelling variant on an otherwise one-word name
// (similarity ~0.8) both comfortably do.
export const FUZZY_MATCH_THRESHOLD = 0.75;

/**
 * For one mention, find the best SAME-TYPE existing-entity near-miss at or
 * above FUZZY_MATCH_THRESHOLD, skipping anything that's already an EXACT
 * case-insensitive name+type match (that's findExisting's own job, not this
 * pre-pass's) -- null if nothing plausible is found.
 *
 * @param {string} mentionName
 * @param {string} mentionType
 * @param {object[]} existingEntities
 * @returns {{entity:object, score:number}|null}
 */
export function findFuzzyEntityMatch(mentionName, mentionType, existingEntities) {
  let best = null;
  let bestScore = 0;
  for (const e of existingEntities) {
    if (e.type !== mentionType || !e.name) continue;
    if (e.name.trim().toLowerCase() === String(mentionName).trim().toLowerCase()) continue;
    const score = nameSimilarity(mentionName, e.name);
    if (score >= FUZZY_MATCH_THRESHOLD && score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best ? { entity: best, score: bestScore } : null;
}

/**
 * Applies the pre-pass to a whole mentions array. The ONLY intervention this
 * makes: for a mention with no EXACT name+type match but a plausible fuzzy
 * one, REWRITE that mention's `name` to the existing entity's OWN exact
 * stored name (recording the original under `fuzzyMatchedFrom` for a
 * friendlier rationale) before handing off to previewWriteupImport's exact
 * matcher below. This is deliberately NOT a second classify-and-shape code
 * path: rewriting the name so the EXISTING exact matcher (findExisting,
 * completely unmodified) resolves it as a real match is what makes a
 * fuzzy-matched mention produce EXACTLY the same LINK mutation shape a
 * genuine exact match would have -- "prefer it (a link) over a blind
 * create," achieved by influencing the input, not duplicating logic.
 *
 * @param {Array<{name:string, type:string, description?:string}>} mentions
 * @param {object[]} existingEntities
 * @returns {Array<{name:string, type:string, description?:string, fuzzyMatchedFrom?:string}>}
 */
export function applyFuzzyPrepass(mentions, existingEntities) {
  const exactNameTypeKeys = new Set(
    existingEntities.filter((e) => e.name && e.type).map((e) => `${e.type}::${e.name.trim().toLowerCase()}`)
  );
  return mentions.map((mention) => {
    const exactKey = `${mention.type}::${String(mention.name).trim().toLowerCase()}`;
    if (exactNameTypeKeys.has(exactKey)) return mention; // already an exact match -- nothing for this pre-pass to do
    const fuzzy = findFuzzyEntityMatch(mention.name, mention.type, existingEntities);
    if (!fuzzy) return mention;
    return { ...mention, name: fuzzy.entity.name, fuzzyMatchedFrom: mention.name };
  });
}

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
  const { mentions } = await proposeMentionedEntities(scanText, sourceEntity, opts.llmOpts ?? {});
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
