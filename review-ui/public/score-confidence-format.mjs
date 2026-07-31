/**
 * Small, pure, DOM-free helper for the three-state score-confidence display
 * contract — Phase 19 task 19.5 (built early, per plans/phase-19-tasks.md's
 * own suggestion, since its unit test can go green independently of any DOM
 * work). See test/combat-planning/score-confidence-format.test.mjs for the
 * full, authoritative contract this implements — that file's header comment
 * IS the spec.
 *
 * Lives in review-ui/public/ (not top-level combat-planning/) because it
 * must run IN THE BROWSER as part of combat-planning-view.js — mirrors
 * review-ui/public/debounced-save.mjs's own precedent exactly.
 *
 * Hard requirement (never a guessed default, matching this project's
 * established "render empty rather than padded" discipline): any input that
 * doesn't cleanly match one of the three known-good shapes below classifies
 * as "unscored" — never a fabricated solid value, never a thrown error.
 */
"use strict";

const UNSCORED_BASE = { state: "unscored", value: null, rangeLow: null, rangeHigh: null, fuzzyNote: null, reason: null };

function unscored(reason = null) {
  return { ...UNSCORED_BASE, reason };
}

/**
 * @param {null|undefined|{scored:boolean, confidence?:string, value?:number, rangeLow?:number, rangeHigh?:number, fuzzyNote?:string, reason?:string}} derivedScore
 * @returns {{state:"solid"|"banded"|"unscored", value:number|null, rangeLow:number|null, rangeHigh:number|null, fuzzyNote:string|null, reason:string|null}}
 */
export function classifyScoreConfidence(derivedScore) {
  if (derivedScore === null || derivedScore === undefined) return unscored(null);
  if (typeof derivedScore !== "object") return unscored(null);

  if (derivedScore.scored === false) {
    const reason = typeof derivedScore.reason === "string" ? derivedScore.reason : null;
    return unscored(reason);
  }

  if (derivedScore.scored === true && derivedScore.confidence === "solid") {
    const value = derivedScore.value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return { state: "solid", value, rangeLow: null, rangeHigh: null, fuzzyNote: null, reason: null };
    }
    return unscored(null);
  }

  if (derivedScore.scored === true && derivedScore.confidence === "banded") {
    const { rangeLow, rangeHigh, fuzzyNote } = derivedScore;
    const boundsOk = typeof rangeLow === "number" && Number.isFinite(rangeLow) && typeof rangeHigh === "number" && Number.isFinite(rangeHigh);
    const noteOk = typeof fuzzyNote === "string" && fuzzyNote.trim().length > 0;
    // A banded state with no explanatory note is a contract violation this
    // function must surface, not silently paper over -- degrades the WHOLE
    // result to unscored rather than inventing placeholder prose.
    if (boundsOk && noteOk) {
      return { state: "banded", value: null, rangeLow, rangeHigh, fuzzyNote, reason: null };
    }
    return unscored(null);
  }

  return unscored(null);
}
