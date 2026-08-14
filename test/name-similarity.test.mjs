// Friction Wave 1 (W1a) — graph-import/name-similarity.mjs, the shared
// deterministic near-miss matcher extracted from scan-mentions.mjs. The
// positive cases below are the REAL duplicate creates from the Kilmarn live
// exercise (review-state batch batch_mssa9fid_zldbi0 and the friction log's
// seed-3a/3b entries) — not invented examples. The negative cases guard the
// original Phase 13.4 conservatism ("Kael" vs "Kaelen" must never match).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeNameTokens,
  nameSimilarity,
  nameNearMatchScore,
  findNearMatches,
  findFuzzyEntityMatch,
  applyFuzzyPrepass,
  FUZZY_MATCH_THRESHOLD
} from "../graph-import/name-similarity.mjs";

// ---------------------------------------------------------------------------
// normalizeNameTokens — possessives, parentheticals, leading articles
// ---------------------------------------------------------------------------

test("normalizeNameTokens strips possessive 's, parentheticals, and leading articles", () => {
  assert.deepEqual(normalizeNameTokens("Vane's Contract Ledger"), ["vane", "contract", "ledger"]);
  assert.deepEqual(normalizeNameTokens("Guild Seal (Dyers' Hall)"), ["guild", "seal", "dyers", "hall"]);
  assert.deepEqual(normalizeNameTokens("The Lowway"), ["lowway"]);
  // Unicode apostrophe variant too
  assert.deepEqual(normalizeNameTokens("Vane’s Seal Ring"), ["vane", "seal", "ring"]);
});

// ---------------------------------------------------------------------------
// nameSimilarity — the moved Phase 13.4 behavior must be unchanged
// ---------------------------------------------------------------------------

test("nameSimilarity: dropped filler word still scores 1.0 (Phase 13.4 behavior preserved)", () => {
  assert.equal(nameSimilarity("Gorrim the Smith", "Gorrim Smith"), 1);
});

test("nameSimilarity: single-token spelling variant clears the threshold", () => {
  assert.ok(nameSimilarity("Osrik", "Osric") >= FUZZY_MATCH_THRESHOLD);
});

test("nameSimilarity: 'Kael' vs 'Kaelen' stays below the threshold (genuinely different names)", () => {
  assert.ok(nameSimilarity("Kael", "Kaelen") < FUZZY_MATCH_THRESHOLD);
});

test("nameSimilarity: leading-article near-miss 'Lowway' vs 'The Lowway' scores 1.0", () => {
  assert.equal(nameSimilarity("Lowway", "The Lowway"), 1);
});

// ---------------------------------------------------------------------------
// nameNearMatchScore — the containment tier the Kilmarn dups need
// ---------------------------------------------------------------------------

test("nameNearMatchScore catches the real Kilmarn shorthand/expansion dups at or above the threshold", () => {
  const cases = [
    ["Master Vane", "Master Aldric Vane"],
    ["Trade Council", "Kilmarn Trade Council"],
    ["Guild Seal (Dyers' Hall)", "Guild Seal"],
    ["Vane's Contract Ledger", "Contract Ledger"],
    ["Founding Charter of Kilmarn", "Founding Charter"]
  ];
  for (const [a, b] of cases) {
    const score = nameNearMatchScore(a, b);
    assert.ok(score >= FUZZY_MATCH_THRESHOLD, `${a} vs ${b} scored ${score}, expected >= ${FUZZY_MATCH_THRESHOLD}`);
  }
});

test("nameNearMatchScore stays conservative for genuinely different names", () => {
  assert.ok(nameNearMatchScore("Kael", "Kaelen") < FUZZY_MATCH_THRESHOLD, "no prefix-matching sneaks in via containment");
  assert.ok(nameNearMatchScore("Thread T-1", "Thread T-2") < FUZZY_MATCH_THRESHOLD, "sibling names with one differing token must not match");
  assert.ok(nameNearMatchScore("Sable Orren", "Master Aldric Vane") < FUZZY_MATCH_THRESHOLD);
});

// ---------------------------------------------------------------------------
// findNearMatches — the W1a card-chip query
// ---------------------------------------------------------------------------

const KILMARN_CANON = [
  { id: "vane", name: "Master Aldric Vane", type: "person" },
  { id: "bridge", name: "Kilmarn Bridge", type: "object" },
  { id: "council", name: "Kilmarn Trade Council", type: "faction" },
  { id: "seal", name: "Guild Seal", type: "object" },
  { id: "lowway", name: "The Lowway", type: "place" },
  { id: "kael", name: "Kael", type: "person" },
  { id: "kaelen", name: "Kaelen", type: "person" }
];

test("findNearMatches surfaces the same-type shorthand near-miss ('Master Vane' → 'Master Aldric Vane')", () => {
  const matches = findNearMatches("Master Vane", "person", KILMARN_CANON);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entityId, "vane");
  assert.equal(matches[0].reason, "similar-name");
});

test("findNearMatches flags an EXACT name with a DIFFERENT type ('Kilmarn Bridge' place vs canon object)", () => {
  const matches = findNearMatches("Kilmarn Bridge", "place", KILMARN_CANON);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entityId, "bridge");
  assert.equal(matches[0].reason, "exact-name-different-type");
  assert.equal(matches[0].score, 1);
});

test("findNearMatches excludes an exact name+type match (that's the exact dedup's territory)", () => {
  const matches = findNearMatches("Guild Seal", "object", KILMARN_CANON);
  assert.deepEqual(matches, []);
});

test("findNearMatches: fuzzy matching stays same-type-only", () => {
  // "Trade Council" guessed as a PLACE must not fuzzy-match the faction —
  // only an EXACT name earns a cross-type flag.
  const matches = findNearMatches("Trade Council", "place", KILMARN_CANON);
  assert.deepEqual(matches, []);
});

test("findNearMatches: 'Kael' (person) matches nothing — 'Kaelen' is a different person", () => {
  // canon has BOTH Kael and Kaelen; a new "Kael" create is exact-matched to
  // Kael (excluded as exact) and must NOT chip Kaelen.
  const matches = findNearMatches("Kael", "person", KILMARN_CANON);
  assert.deepEqual(matches, []);
});

test("findNearMatches sorts best-first and respects the max cap", () => {
  const entities = [
    { id: "a", name: "Iron Warden", type: "person" },
    { id: "b", name: "Iron Warden of the Gate", type: "person" },
    { id: "c", name: "The Iron Warden Keeper Sworn", type: "person" }
  ];
  const matches = findNearMatches("The Iron Warden", "person", entities, { max: 2 });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].entityId, "a", "exact-after-stopwords should rank first");
  assert.ok(matches[0].score >= matches[1].score);
});

// ---------------------------------------------------------------------------
// Re-exported Phase 13.4 helpers still behave (the move must be invisible)
// ---------------------------------------------------------------------------

test("findFuzzyEntityMatch / applyFuzzyPrepass still work via the shared module", () => {
  const existing = [{ id: "g", name: "Gorrim Smith", type: "person" }];
  const match = findFuzzyEntityMatch("Gorrim the Smith", "person", existing);
  assert.equal(match.entity.id, "g");
  const prepassed = applyFuzzyPrepass([{ name: "Gorrim the Smith", type: "person" }], existing);
  assert.equal(prepassed[0].name, "Gorrim Smith");
  assert.equal(prepassed[0].fuzzyMatchedFrom, "Gorrim the Smith");
});
