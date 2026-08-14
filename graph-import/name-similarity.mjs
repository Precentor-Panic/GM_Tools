/**
 * Deterministic name-similarity primitives — pure, dependency-free, no LLM.
 *
 * Friction Wave 1 (W1a): extracted from graph-import/scan-mentions.mjs
 * (Phase 13 task 13.4's fuzzy pre-pass) into a shared module, because the
 * SAME near-miss matching is now needed by three callers:
 *   - scan-mentions.mjs's own fuzzy pre-pass (the original home — it
 *     re-exports everything it used to define, so existing importers keep
 *     working unchanged);
 *   - the review UI's near-match chips on proposed CREATE cards (W1a — the
 *     Kilmarn live exercise's "duplicate checking is a manual tab-flip loop"
 *     friction: "Master Vane" vs canon "Master Aldric Vane", "Trade
 *     Council" vs "Kilmarn Trade Council", "Guild Seal (Dyers' Hall)" vs
 *     "Guild Seal", "Lowway" vs "The Lowway", and the exact-name/
 *     different-type miss "Kilmarn Bridge" place-vs-object);
 *   - the writeup-import near-miss normalization pass (W2a, Agent 2's
 *     track), which runs the same scoring over extracted entity names
 *     BEFORE the importGraph dry-run.
 *
 * Two scoring tiers, deliberately separate:
 *   - `nameSimilarity` — the ORIGINAL, conservative Phase 13.4 score
 *     (stopword-stripped token Jaccard + single-token edit-distance ratio),
 *     moved here VERBATIM. scan-mentions' auto-rewrite pre-pass keeps using
 *     exactly this, so its behavior does not change with the move (its
 *     existing tests are the regression guard).
 *   - `nameNearMatchScore` — `nameSimilarity` plus a token-CONTAINMENT
 *     signal (every significant token of the shorter name appears in the
 *     longer one) for the "name is a shorthand/expansion of the other"
 *     shape Jaccard alone under-scores ("Master Vane" ⊂ "Master Aldric
 *     Vane" is Jaccard 2/3 ≈ 0.67, below the 0.75 threshold, but is
 *     exactly the near-miss the Kilmarn exercise hit four times in one
 *     batch). Used by the ADVISORY near-match chips (W1a) and available to
 *     W2a — callers that auto-act (rather than advise) should decide their
 *     own threshold consciously.
 */

// A small, fixed stopword list for common filler words in a name/title (not
// a language-detection feature -- just enough to stop "Gorrim the Smith"
// vs "Gorrim Smith" from reading as two different sets of significant words).
export const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "de", "van", "der"]);

/**
 * Lowercase, strip possessive 's ("Vane's Contract Ledger" → the same
 * significant tokens as "Vane Contract Ledger" — the Kilmarn seed-3b
 * possessive-phrasing dup shape), strip punctuation (which also flattens a
 * disambiguating parenthetical: "Guild Seal (Dyers' Hall)" → guild seal
 * dyers hall), split, drop stopwords (which also handles a leading
 * article: "The Lowway" → lowway).
 */
export function normalizeNameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_STOPWORDS.has(t));
}

/** Classic Levenshtein edit distance -- small, dependency-free, no external library per gm-tools-conventions' dependency discipline. */
export function levenshteinDistance(a, b) {
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
// false-negative (missing a real near-miss, which the manual "Link to
// existing instead" / "convert to update" corrections already cover).
// Confirmed against this module's own test cases: high enough that "Kael"
// vs "Kaelen" (two genuinely different people who merely sound alike,
// similarity ~0.67) does NOT qualify, while "Gorrim Smith" vs "Gorrim the
// Smith" (a dropped filler word, similarity 1.0 after stopword-stripped
// token comparison) and a single-character spelling variant on an otherwise
// one-word name (similarity ~0.8) both comfortably do.
export const FUZZY_MATCH_THRESHOLD = 0.75;

/**
 * `nameSimilarity` plus a token-containment signal: if every significant
 * token of the shorter name appears in the longer one, score
 * 0.75 + 0.25·(|shorter|/|longer|) — always at or above the 0.75 threshold,
 * scaled up the closer the two names are to identical. Catches the
 * shorthand/expansion near-miss family the Kilmarn exercise hit repeatedly:
 *   "Master Vane" ⊂ "Master Aldric Vane"          → ~0.92
 *   "Trade Council" ⊂ "Kilmarn Trade Council"     → ~0.92
 *   "Guild Seal" ⊂ "Guild Seal (Dyers' Hall)"     → ~0.88
 *   "Contract Ledger" ⊂ "Vane's Contract Ledger"  → ~0.92
 * while "Kael" vs "Kaelen" still fails containment (exact-token membership,
 * not prefix matching) and stays at nameSimilarity's own low ~0.67.
 */
export function nameNearMatchScore(nameA, nameB) {
  const tokensA = normalizeNameTokens(nameA);
  const tokensB = normalizeNameTokens(nameB);
  if (!tokensA.length || !tokensB.length) return 0;
  const base = nameSimilarity(nameA, nameB);
  const [small, large] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const largeSet = new Set(large);
  const contained = small.every((t) => largeSet.has(t));
  if (!contained) return base;
  const containScore = 0.75 + 0.25 * (small.length / large.length);
  return Math.max(base, containScore);
}

/**
 * For one mention, find the best SAME-TYPE existing-entity near-miss at or
 * above FUZZY_MATCH_THRESHOLD, skipping anything that's already an EXACT
 * case-insensitive name+type match (that's findExisting's own job, not this
 * pre-pass's) -- null if nothing plausible is found. Moved verbatim from
 * scan-mentions.mjs (Phase 13.4); uses the ORIGINAL conservative
 * `nameSimilarity`, NOT `nameNearMatchScore`, so the auto-rewrite pre-pass's
 * behavior is unchanged by the extraction.
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
 * matcher. This is deliberately NOT a second classify-and-shape code
 * path: rewriting the name so the EXISTING exact matcher (findExisting,
 * completely unmodified) resolves it as a real match is what makes a
 * fuzzy-matched mention produce EXACTLY the same LINK mutation shape a
 * genuine exact match would have -- "prefer it (a link) over a blind
 * create," achieved by influencing the input, not duplicating logic.
 * Moved verbatim from scan-mentions.mjs (Phase 13.4).
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
 * W1a: ALL plausible existing-graph near matches for one proposed name+type,
 * for DISPLAY on a review card (advisory — nothing here rewrites or merges
 * anything). Two match families, each with an explicit machine-readable
 * `reason` so the card can label them differently:
 *   - 'similar-name': same type, `nameNearMatchScore` at/above threshold
 *     (the shorthand/expansion + near-miss families). Same-type-only,
 *     matching findFuzzyEntityMatch's own conservatism.
 *   - 'exact-name-different-type': the name matches an existing entity
 *     EXACTLY (case-insensitive) but the type guess differs — the "Kilmarn
 *     Bridge" place-vs-object dup that name+type dedup misses by
 *     construction. Always surfaced, score 1.
 * An exact name+type match is deliberately EXCLUDED — that is the exact
 * dedup's own territory (importGraph's findExisting already turns those
 * into updates, so a create card should never carry one).
 *
 * @param {string} name        the proposed create's name
 * @param {string|undefined} type  the proposed create's type guess
 * @param {object[]} existingEntities  live-snapshot entities ({id,name,type})
 * @param {object} [opts]
 * @param {number} [opts.max=4]        cap on returned matches
 * @param {number} [opts.threshold=FUZZY_MATCH_THRESHOLD]
 * @returns {Array<{entityId:string, name:string, type:string|null, score:number, reason:'similar-name'|'exact-name-different-type'}>} sorted best-first
 */
export function findNearMatches(name, type, existingEntities, opts = {}) {
  const max = opts.max ?? 4;
  const threshold = opts.threshold ?? FUZZY_MATCH_THRESHOLD;
  const nameNorm = String(name ?? "").trim().toLowerCase();
  if (!nameNorm) return [];
  const results = [];
  for (const e of existingEntities ?? []) {
    if (!e?.name || !e?.id) continue;
    const exact = e.name.trim().toLowerCase() === nameNorm;
    if (exact) {
      if (type && e.type && e.type !== type) {
        results.push({ entityId: e.id, name: e.name, type: e.type ?? null, score: 1, reason: "exact-name-different-type" });
      }
      continue; // exact name+type: the exact dedup's own territory, never a chip
    }
    if (type && e.type && e.type !== type) continue; // fuzzy stays same-type-only
    const score = nameNearMatchScore(name, e.name);
    if (score >= threshold) {
      results.push({ entityId: e.id, name: e.name, type: e.type ?? null, score: Math.round(score * 1000) / 1000, reason: "similar-name" });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, max);
}
