/**
 * Pack coefficient — Phase 18 task 18.4. PURE function, zero I/O, zero LLM
 * calls. Design record §2: "a one-line static multiplier, effective_threat
 * x f(mob_count, has_focus_fire_trait)... Six identical wolves are not six
 * independent threat units summed." No target-selection AI attempted
 * (correctly out of scope) -- a static knob, not a simulation.
 */

// A modest, static per-extra-monster bonus when a focus-fire trait is
// present (e.g. Pack Tactics) -- deliberately small and linear (not
// compounding) so the coefficient stays a "knob," not a runaway multiplier.
const FOCUS_FIRE_GROWTH_RATE = 0.1;

/**
 * @param {number} mobCount
 * @param {boolean} hasFocusFireTrait
 * @returns {number}   exactly 1 when hasFocusFireTrait is false (any
 *   mobCount) or when mobCount <= 1 (a single monster can't focus-fire with
 *   itself); > 1 otherwise, non-decreasing in mobCount.
 */
export function computePackCoefficient(mobCount, hasFocusFireTrait) {
  if (!hasFocusFireTrait || mobCount <= 1) return 1;
  return 1 + (mobCount - 1) * FOCUS_FIRE_GROWTH_RATE;
}

/**
 * @param {number} perMonsterThreat
 * @param {number} mobCount
 * @param {boolean} hasFocusFireTrait
 * @returns {number}   perMonsterThreat * mobCount * computePackCoefficient(mobCount, hasFocusFireTrait)
 */
export function applyPackCoefficient(perMonsterThreat, mobCount, hasFocusFireTrait) {
  return perMonsterThreat * mobCount * computePackCoefficient(mobCount, hasFocusFireTrait);
}
