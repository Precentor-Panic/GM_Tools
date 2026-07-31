import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * CONTRACT UNDER TEST — review-ui/public/score-confidence-format.mjs
 * (Phase 19 task 19.0, extracted per task 19.0's own invitation: "if any
 * part of the score-formatting/confidence-display logic can reasonably be
 * extracted as a small, pure, DOM-free helper function... write a plain
 * node --test unit test for it"). This module does not exist yet; this file
 * is the interface spec for it, expected to fail with "Cannot find module"
 * until task 19.5 lands.
 *
 * Lives in review-ui/public/ (NOT top-level combat-planning/) because it
 * must run IN THE BROWSER as part of combat-planning-view.js -- the browser
 * can only load static files under review-ui/public/ (server.mjs's
 * handleStatic guards PUBLIC_DIR), so a top-level combat-planning/*.mjs
 * module is unreachable from client-side code. This mirrors
 * review-ui/public/debounced-save.mjs's own precedent EXACTLY: a genuinely
 * pure, DOM-free module that lives in public/ (because the browser needs
 * it) but is tested from a plain `node --test` file at
 * test/combat-planning/ (this file), importing it via a relative path --
 * the SAME pattern test/session-planner/debounced-save.test.mjs already
 * established for review-ui/public/debounced-save.mjs.
 *
 * See review-ui/test/e2e/combat-planning-fixture.mjs's own header ("SCORE-
 * CONFIDENCE derivedScore SHAPE") for the full grounding on why this
 * `derivedScore` shape is a NEW contract this test specifies, not something
 * Phase 18 ever shipped or computed.
 *
 * ---------------------------------------------------------------------------
 * classifyScoreConfidence(derivedScore) -> {
 *   state: "solid" | "banded" | "unscored",
 *   value: number | null,        // only meaningful when state === "solid"
 *   rangeLow: number | null,     // only meaningful when state === "banded"
 *   rangeHigh: number | null,    // only meaningful when state === "banded"
 *   fuzzyNote: string | null,    // REQUIRED non-empty string when state === "banded"
 *   reason: string | null        // present when state === "unscored" and derivedScore explicitly said why
 * }
 *
 * Input shapes it must handle:
 *   - null / undefined                                             -> unscored, reason: null
 *   - { scored:false, confidence:"unscored", reason:"..." }        -> unscored, reason carried through
 *   - { scored:true, confidence:"solid", value:14.2, ... }         -> solid, value:14.2
 *   - { scored:true, confidence:"banded", rangeLow:10, rangeHigh:16, fuzzyNote:"..." } -> banded, both bounds + fuzzyNote carried through
 *
 * HARD REQUIREMENT (never a guessed default, matching this project's
 * established "render empty rather than padded" discipline, e.g.
 * effect-impact.mjs's scoreEffect for an unrecognized effect name): a
 * malformed/unrecognized shape (e.g. `{confidence:"solid"}` with NO `value`,
 * or a `state`-less object, or a totally unrelated object) must classify as
 * "unscored" -- NEVER fabricate a 0/NaN "solid" value and never throw.
 * ---------------------------------------------------------------------------
 */
import { classifyScoreConfidence } from "../../review-ui/public/score-confidence-format.mjs";

test("null/undefined derivedScore classifies as unscored with no reason", () => {
  const a = classifyScoreConfidence(null);
  assert.equal(a.state, "unscored");
  assert.equal(a.reason, null);

  const b = classifyScoreConfidence(undefined);
  assert.equal(b.state, "unscored");
});

test("an explicit {scored:false, confidence:'unscored', reason} carries the reason through unchanged", () => {
  const result = classifyScoreConfidence({ scored: false, confidence: "unscored", reason: "No quantitative combat stats were extracted." });
  assert.equal(result.state, "unscored");
  assert.equal(result.reason, "No quantitative combat stats were extracted.");
});

test("a solid derivedScore carries its numeric value through unchanged, never rounded/altered", () => {
  const result = classifyScoreConfidence({ scored: true, confidence: "solid", value: 14.2, breakdown: {} });
  assert.equal(result.state, "solid");
  assert.equal(result.value, 14.2);
  assert.equal(result.rangeLow, null);
  assert.equal(result.rangeHigh, null);
});

test("a banded derivedScore carries both range bounds AND a non-empty fuzzyNote through unchanged", () => {
  const result = classifyScoreConfidence({
    scored: true,
    confidence: "banded",
    rangeLow: 10,
    rangeHigh: 16,
    fuzzyNote: "No defined combat-system profile for this system -- showing a rough estimate."
  });
  assert.equal(result.state, "banded");
  assert.equal(result.rangeLow, 10);
  assert.equal(result.rangeHigh, 16);
  assert.equal(typeof result.fuzzyNote, "string");
  assert.ok(result.fuzzyNote.length > 0, "a banded result must always carry a real, non-empty fuzzyNote -- never left for the caller to infer from the visual treatment alone (design record's round-3 refinement)");
});

test("a banded derivedScore with a missing/empty fuzzyNote is a contract violation this function must surface, not silently paper over", () => {
  // A banded state with no explanatory note at all violates the design
  // record's own hard requirement ("must carry a one-line why-is-this-fuzzy
  // note directly attached... not left to be inferred") -- this function
  // must not silently invent placeholder text OR silently drop to a
  // fuzzyNote of "" as if that were fine. It degrades the WHOLE result to
  // "unscored" instead (a banded-without-explanation input is treated as
  // untrustworthy input, not partially trusted) -- never fabricates
  // explanatory prose that wasn't given to it.
  const result = classifyScoreConfidence({ scored: true, confidence: "banded", rangeLow: 10, rangeHigh: 16, fuzzyNote: "" });
  assert.equal(result.state, "unscored");
});

test("a malformed/unrecognized shape classifies as unscored, never a fabricated solid value and never throws", () => {
  assert.doesNotThrow(() => classifyScoreConfidence({ confidence: "solid" })); // no `value` at all
  assert.equal(classifyScoreConfidence({ confidence: "solid" }).state, "unscored");

  assert.doesNotThrow(() => classifyScoreConfidence({ scored: true, confidence: "solid", value: "not-a-number" }));
  assert.equal(classifyScoreConfidence({ scored: true, confidence: "solid", value: "not-a-number" }).state, "unscored");

  assert.doesNotThrow(() => classifyScoreConfidence({ someTotallyUnrelatedShape: 1 }));
  assert.equal(classifyScoreConfidence({ someTotallyUnrelatedShape: 1 }).state, "unscored");

  assert.doesNotThrow(() => classifyScoreConfidence("not even an object"));
  assert.equal(classifyScoreConfidence("not even an object").state, "unscored");
});
