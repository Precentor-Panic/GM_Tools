/**
 * Tiny shared dice-string helper — Phase 18. Pure, no I/O, no LLM calls.
 * Used by combat-planning/bestiary-store.mjs's checkBestiaryOutliers (task
 * 18.1) and combat-planning/action-economy.mjs (task 18.3) so both compute a
 * dice-string's average damage the same way instead of drifting.
 */

/**
 * Parses a dice-string average (e.g. "2d6+3" -> 10, "40d10+400" -> 620, a
 * bare flat number as a string -> itself). Returns null (never throws, never
 * guesses) for a shape it doesn't recognize.
 * @param {string} diceStr
 * @returns {number|null}
 */
export function diceAverage(diceStr) {
  if (typeof diceStr !== "string") return null;
  const trimmed = diceStr.trim();
  const m = trimmed.match(/^(\d+)d(\d+)\s*([+-]\s*\d+)?$/i);
  if (!m) {
    const flat = Number(trimmed);
    return Number.isFinite(flat) ? flat : null;
  }
  const count = Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3].replace(/\s+/g, "")) : 0;
  return count * ((sides + 1) / 2) + modifier;
}
