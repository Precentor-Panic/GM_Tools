// Phase 19 task 19.0 -- shared setup/contract helpers for the combat-planning
// e2e suite (review-ui/test/e2e/combat-planning-*.e2e.mjs). NOT itself an
// *.e2e.mjs file (the npm run test:e2e glob is test/e2e/*.e2e.mjs), same
// exemption as fixture.mjs itself -- every combat-planning-*.e2e.mjs file
// imports what it needs from here rather than each re-deriving fixture-data
// shapes independently.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND THE REAL PHASE-18/19 GAPS IT DOCUMENTS
// ===========================================================================
// Task 19.0's own instruction is to seed fixture data "via the real
// ingestion API in test setup, not hand-built fixture JSON." For
// bestiary/party-roster ENTRIES that's straightforward: combat-planning/
// bestiary-store.mjs's saveBestiaryEntry / combat-planning/party-roster-
// store.mjs's savePartyMember ARE the real, already-shipped store-write code
// path (task 18.1/18.2, not test-only fixture plumbing) -- calling them
// directly is the exact same "real API, not hand-authored JSON files"
// convention the session-planner e2e files already established by calling
// bootstrapSnapshot/applyHeadless directly instead of writing snapshot JSON
// by hand.
//
// What's NOT straightforward, and had to be resolved here rather than
// silently worked around: this project has zero ANTHROPIC_API_KEY in the
// build/test environment (PLAN.md's own standing note), and review-ui/
// server.mjs's combat-planning routes call proposeBestiaryEntryFromText/
// proposePartyMemberFromText/proposeThematicTags with NO way to inject a
// fake client (unlike mutation-engine/llm-call.mjs's own opts.client
// convention) -- confirmed by reading server.mjs's combat-planning routes
// (~line 1390+) and review-ui/test/combat-planning-routes.test.mjs's own
// header comment ("the real LLM-backed success path is a companion smoke
// test"). This is this project's ESTABLISHED split (gm-tools-conventions:
// "a unit test with the API call mocked ... plus a documented ... smoke test
// that makes a real API call"), not a Phase 19 gap -- but it means genuinely
// driving the two real LLM-touching submit actions (bestiary/party-roster
// ingest, the theme box) through a live browser, in THIS suite, without a
// key, requires Playwright's own route-interception + route.fulfill()
// (page.route(...)) to fully mock the HTTP response rather than let it reach
// the real network -- see combat-planning-ingestion-flagging.e2e.mjs and
// combat-planning-loading-scope.e2e.mjs for where this is actually used.
//
// A SECOND, more load-bearing gap surfaced while grounding this contract in
// the real shipped Phase 18 route (review-ui/server.mjs's POST
// /api/combat-planning/encounter-suggest, ~line 1456): as shipped, that
// route ALWAYS calls thematic-filter.mjs's proposeThematicTags (a real LLM
// call) UNCONDITIONALLY -- there is no request field to skip it, even with
// an empty bestiary pool. This directly contradicts plans/phase-19-review.md
// §2's own explicit, load-bearing claim: "the difficulty-rail suggestion...
// is deterministic, local, and instant... only the ingestion screen and the
// optional theme box need any 'still working' / latency affordance." As
// shipped, EVERY difficulty-tier click, catalog add/remove, and knob change
// would need a live API key and ~5-60s of latency -- exactly the outcome the
// design record says must never happen. A second, related gap: encounter-
// suggest's `party` is unconditionally `listPartyMembers(w)` (the FULL
// roster) with no way to pass a client-side-filtered attendance subset, and
// encounter-heuristic.mjs's `suggestEncounter` has no way to score an
// EXPLICIT DM-picked combination (only its own internal greedy auto-fill,
// via unexported helpers) -- both required for design record §1's roster-
// attendance-toggle and catalog-manual-add mechanics to produce a live,
// accurate recompute at all.
//
// None of the above is this test-authoring pass's job to fix (task 19.0 is
// tests-before-implementation, "do NOT build any implementation to make
// them pass") -- but the DOM contract these tests specify is unbuildable
// without SOME resolution, so the fix is specified here, precisely, as part
// of the interface contract 19.1/19.2/19.5 must implement (a small, additive,
// backward-compatible extension of the ALREADY-EXISTING encounter-suggest
// route -- no new route, matching plans/phase-19-tasks.md's own "no new
// server routes" framing under its literal reading: existing routes may
// still grow new OPTIONAL request fields):
//
//   POST /api/combat-planning/encounter-suggest -- REQUIRED new optional
//   request-body fields, all backward-compatible (omitting all three
//   reproduces today's exact shipped behavior byte-for-byte):
//     - themeText (string, optional): omitted or blank/whitespace-only =>
//       proposeThematicTags is SKIPPED ENTIRELY, candidatePool is the full
//       un-filtered accepted-bestiary pool, and the whole request executes
//       deterministically with ZERO LLM calls. Non-empty => today's shipped
//       behavior (calls proposeThematicTags for real).
//     - attendingMemberIds (string[], optional): when present, `party` is
//       listPartyMembers(w) FILTERED to only these ids before being passed
//       into suggestEncounter/computeSnowballDelta. Omitted => today's
//       shipped behavior (the full roster).
//     - manualCombination ({entryId, count}[], optional): when present, the
//       server scores EXACTLY this combination (still applying `knobs`,
//       still computing burstCeiling/snowballDelta/asymmetricRiskFlag the
//       identical way) instead of auto-building one via targetDifficulty.
//       The response's `combination` field echoes back exactly
//       manualCombination. Omitted => today's shipped auto-fill behavior.
//
// Every combat-planning-*.e2e.mjs file in this suite that exercises the
// difficulty rail, roster attendance, catalog add/remove, or knob changes
// relies on this corrected contract -- always sending `themeText: ""` (or
// omitting it) for those interactions, so the ONLY two real HTTP requests in
// this whole suite that ever need an LLM-call mock are the ones explicitly
// noted above. Every test below is EXPECTED TO FAIL right now with a
// Playwright "waiting for selector" / timeout error at the very first
// selector lookup (no nav entry, no #view-combat-planning exist yet) -- this
// happens well before any test body reaches a point where the corrected
// route contract above would even matter, so this gap does not change how
// the RED run behaves today; it changes what 19.2/19.5 must build to turn
// these tests green later.
//
// ===========================================================================
// SCORE-CONFIDENCE derivedScore SHAPE (scenario 3/4's fixtures) -- ALSO A
// NEW CONTRACT, NOT SHIPPED BY PHASE 18
// ===========================================================================
// combat-planning/bestiary-store.mjs's BestiaryEntry.derivedScore exists as
// a slot (task 18.1) but is NEVER ACTUALLY POPULATED by any shipped
// production code path -- updateBestiaryEntryScore is exported but has zero
// callers outside its own test file (confirmed by grep). Separately,
// plans/phase-18-review.md §4 explicitly left "the exact shape of the
// combat system profile concept... whether a first version should just
// hardcode 5e math and treat everything else as the crude fallback" as an
// UNRESOLVED open question -- meaning there is no shipped signal
// distinguishing a "full-profile" bestiary entry from a "crude-fallback"
// one at all. plans/phase-19-review.md's three-state confidence format
// (solid decimal / dashed banded range with an attached "why fuzzy" note /
// "Unscored -- reference only" pill, ALL in the identical layout slot)
// requires SOME such signal to exist for 19.5 to build against, so this
// suite specifies one, seeded directly via saveBestiaryEntry's own
// derivedScore parameter (bypassing the still-unresolved COMPUTATION
// question entirely -- these tests are a display-contract spec, not a
// scoring-confidence-computation spec):
//
//   derivedScore = null                                          -- UNSCORED (never computed at all)
//   derivedScore = { scored:false, confidence:"unscored", reason:"..." } -- UNSCORED (computed, explicitly gave up)
//   derivedScore = { scored:true,  confidence:"solid",  value:14.2, breakdown:{...} }
//   derivedScore = { scored:true,  confidence:"banded", rangeLow:10, rangeHigh:16, fuzzyNote:"..." }
//
// A future pass that actually resolves the "combat system profile" question
// should compute and attach this SAME shape via a small, additive change to
// POST /api/combat-planning/bestiary/:id/accept (calling
// updateBestiaryEntryScore before/as part of accepting) -- flagged here,
// not built here, matching this file's other flagged-not-built gaps above.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, IPHONE_13_VIEWPORT } from "./fixture.mjs";

export { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, IPHONE_13_VIEWPORT };

/**
 * A minimal, VALID RawBestiaryFields-shaped object (satisfies
 * combat-planning/bestiary-ingest.mjs's RawBestiaryFields zod schema)
 * suitable as a base for a "full profile" (solid-decimal-scorable) catalog
 * entry -- a real attack, no outlier flags (per-round damage well under hp).
 * @param {object} [overrides]
 */
export function fullProfileRawFields(overrides = {}) {
  return {
    name: "Test Goblin",
    type: "humanoid",
    challengeRating: "1/4",
    hp: 7,
    ac: 15,
    attacks: [{ name: "Scimitar", toHitBonus: 4, damageDice: "1d6+2", damageType: "slashing" }],
    ...overrides
  };
}

/**
 * A gross-outlier-shaped RawBestiaryFields: a single attack whose dice
 * average, times multiattack count, exceeds the creature's OWN hp --
 * combat-planning/bestiary-store.mjs's checkBestiaryOutliers (task 18.1)
 * flags this for human confirmation. Used by
 * combat-planning-ingestion-flagging.e2e.mjs (scenario 5).
 */
export function outlierRawFields(overrides = {}) {
  return {
    name: "Test Implausible Ogre",
    type: "giant",
    hp: 10,
    ac: 11,
    attacks: [{ name: "Greatclub", toHitBonus: 6, damageDice: "40d10+400", damageType: "bludgeoning" }],
    ...overrides
  };
}

const SOLID_DERIVED_SCORE = { scored: true, confidence: "solid", value: 14.2, breakdown: { baseAttacksPerRound: 14.2, rechargeExpectedValue: 0, legendaryActionValue: 0 } };
const BANDED_DERIVED_SCORE = { scored: true, confidence: "banded", rangeLow: 10, rangeHigh: 16, fuzzyNote: "No defined combat-system profile for this system -- showing a rough estimate." };
const UNSCORED_DERIVED_SCORE = { scored: false, confidence: "unscored", reason: "No quantitative combat stats were extracted for this entry." };

export { SOLID_DERIVED_SCORE, BANDED_DERIVED_SCORE, UNSCORED_DERIVED_SCORE };

/**
 * Seeds one bestiary entry via the REAL store-write path (combat-planning/
 * bestiary-store.mjs's saveBestiaryEntry -- task 18.1's own shipped code,
 * not hand-authored fixture JSON) and accepts it (acceptBestiaryEntry) so it
 * is catalog-visible (this suite's own convention, documented in each test
 * file: the catalog only ever shows status:"accepted" entries). Dynamically
 * imports bestiary-store.mjs on first call so GM_TOOLS_BESTIARY_DIR (set by
 * setupScratchEnv, which MUST run first) is honored -- matches
 * session-planner-*.e2e.mjs's own dynamic-import-after-env-vars convention.
 * @param {{rawFields:object, derivedScore?:object|null}} fields
 * @returns {Promise<object>} the accepted BestiaryEntry
 */
export async function seedAcceptedBestiaryEntry({ rawFields, derivedScore = null }) {
  const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
  const entry = saveBestiaryEntry({ rawFields, derivedScore });
  return acceptBestiaryEntry(entry.id);
}

/**
 * Seeds one bestiary entry WITHOUT accepting it (status stays "proposed") --
 * used by combat-planning-ingestion-flagging.e2e.mjs (scenario 5), whose
 * subject IS the pending-review screen a not-yet-accepted entry renders on.
 */
export async function seedProposedBestiaryEntry({ rawFields, derivedScore = null }) {
  const { saveBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
  return saveBestiaryEntry({ rawFields, derivedScore });
}

/**
 * Seeds one party member via the REAL store-write path (combat-planning/
 * party-roster-store.mjs's savePartyMember, task 18.2's own shipped code).
 * `opts.now` (savePartyMember's own injectable createdAt override) lets
 * combat-planning-hp-staleness.e2e.mjs seed a deliberately-old member
 * without any real clock mocking.
 * @param {string} world
 * @param {{name:string, combatRelevant:object, buildRelevant?:object}} fields
 * @param {object} [opts]
 */
export async function seedPartyMember(world, fields, opts = {}) {
  const { savePartyMember } = await import("../../../combat-planning/party-roster-store.mjs");
  return savePartyMember(world, { buildRelevant: {}, ...fields }, opts);
}

/** ISO timestamp `hours` hours in the past -- for seedPartyMember's opts.now. */
export function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/** A fresh scratch temp dir prefix helper, matching every *.e2e.mjs file's own mkdtempSync(prefix) convention -- exported for files that want a one-off dir outside setupScratchEnv's own (e.g. none currently; kept for parity/future use). */
export function scratchPrefix(name) {
  return mkdtempSync(join(tmpdir(), name));
}

/**
 * Sets `localStorage["gmReview.world"]` to `world` before this suite's
 * combat-planning routes (world-scoped for party-roster/encounter-suggest,
 * NOT for the library-wide bestiary routes) are ever called from the
 * browser. MUST navigate to a real page on `base` FIRST -- `page.evaluate`
 * cannot touch localStorage on Playwright's initial `about:blank` document
 * (`SecurityError: Access is denied`). Deliberately explicit rather than
 * relying on app.js's own auto-pick-first-world-from-GET-/api/worlds
 * fallback (session-planner-*.e2e.mjs's own convention, which works there
 * because those tests bootstrap a real WF snapshot for their world) --
 * combat-planning's bestiary/party-roster stores are deliberately NOT
 * graph-backed (design record §1a), so this suite has no snapshot file for
 * `GET /api/worlds` to discover at all; setting the key directly is the
 * correct fix here, not a workaround.
 * @param {import('playwright').Page} pg
 * @param {string} base
 * @param {string} world
 */
export async function primeWorldSelection(pg, base, world) {
  await pg.goto(base);
  await pg.evaluate((w) => localStorage.setItem("gmReview.world", w), world);
}
