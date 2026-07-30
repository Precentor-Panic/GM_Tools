/**
 * Action-economy scoring — Phase 18 task 18.3. PURE function, zero I/O, zero
 * LLM calls — matches mutation-engine/propagate.mjs's convention exactly.
 * Consumes combat-planning/bestiary-ingest.mjs's RawBestiaryFields (attacks,
 * multiattack, rechargeAbilities, legendaryActions) and computes a
 * deterministic action-economy score — the OTHER half of the
 * extraction/scoring split (18.1's LLM call never computes this itself).
 *
 * Recharge-ability EXPECTED VALUE, not full-value credit (design record
 * §1a's stated concern, operationalized as a scoring requirement): a
 * recharge ability is weighted by its actual per-round trigger probability
 * (a d6 recharge roll: "5-6" = 2/6, "6" = 1/6), never credited at full
 * damage every round.
 */
import { diceAverage } from "./dice.mjs";

// A per-legendary-action value estimate -- legendary actions are cheaper
// than a full turn (usually a single attack or minor effect), so this is
// deliberately a flat, conservative per-action figure rather than trying to
// model exactly what each legendary action does (that detail isn't in
// RawBestiaryFields at all -- only count/costPerAction are).
const LEGENDARY_ACTION_VALUE_ESTIMATE = 6;

/**
 * A recharge roll range (e.g. "5-6", "6", "4-6") as printed -> the fraction
 * of a standard d6 roll that triggers it. Falls back to 1/6 (the narrowest,
 * most conservative real range) for a shape this doesn't recognize, rather
 * than crediting a malformed/unexpected string at full value.
 * @param {string} rechargeOn
 * @returns {number}   in (0, 1]
 */
function rechargeChance(rechargeOn) {
  if (typeof rechargeOn !== "string") return 1 / 6;
  const trimmed = rechargeOn.trim();
  const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (hi >= lo && hi <= 6 && lo >= 1) return (hi - lo + 1) / 6;
  }
  const single = trimmed.match(/^(\d+)$/);
  if (single) {
    const n = Number(single[1]);
    if (n >= 1 && n <= 6) return (6 - n + 1) / 6;
  }
  return 1 / 6;
}

/**
 * @param {object} rawFields   a RawBestiaryFields-shaped object (or any
 *   subset of {attacks, multiattack, rechargeAbilities, legendaryActions})
 * @returns {{score:number, breakdown:{baseAttacksPerRound:number, rechargeExpectedValue:number, legendaryActionValue:number}}}
 */
export function computeActionEconomyScore(rawFields = {}) {
  const attacks = rawFields.attacks ?? [];
  const multiattackCount = rawFields.multiattack?.count ?? 1;

  const perAttackTotal = attacks.reduce((sum, attack) => sum + (diceAverage(attack?.damageDice) ?? 0), 0);
  const baseAttacksPerRound = perAttackTotal * multiattackCount;

  const rechargeExpectedValue = (rawFields.rechargeAbilities ?? []).reduce((sum, ability) => {
    const avg = diceAverage(ability?.damageDice) ?? 0;
    return sum + avg * rechargeChance(ability?.rechargeOn);
  }, 0);

  const legendaryActionValue = rawFields.legendaryActions?.count
    ? rawFields.legendaryActions.count * LEGENDARY_ACTION_VALUE_ESTIMATE
    : 0;

  const score = baseAttacksPerRound + rechargeExpectedValue + legendaryActionValue;

  return {
    score,
    breakdown: { baseAttacksPerRound, rechargeExpectedValue, legendaryActionValue }
  };
}
