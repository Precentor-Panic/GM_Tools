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
 *
 * WS-4 §0.7 defect fix (c) -- CR-DERIVED FALLBACK for an attackless stat
 * block: 26/82 real bestiary entries (Foundry-pulled rows whose attacks
 * never made it into rawFields, e.g. Adult Red Dragon) have `attacks:[]`
 * and no recharge/legendary fields either, so the attack-derived math above
 * always scored them exactly 0 -- permanently unselectable by
 * encounter-heuristic.mjs's `candidateThreat` (a `> 0` filter). When
 * `attacks` is empty AND the entry carries a numeric `challengeRating`
 * (`plutonium-source.mjs`'s own `crToNumber`, string-or-number-tolerant),
 * a coarse CR-proportional threat proxy steps in -- deliberately NOT a
 * DMG-table-calibrated damage-per-round figure (this module has no combat
 * system profile for that), the same "cruder power-score comparison" degrade
 * design record §2 already sanctions for a system with no defined profile.
 * `breakdown.crFallbackApplied` is the promised "note in the score that
 * threat is CR-derived" -- a caller/UI can show it without guessing from the
 * number alone. An attack-derived score, however small, always wins outright
 * over the CR proxy (only a genuinely EMPTY attacks list triggers this).
 */
import { diceAverage } from "./dice.mjs";
import { crToNumber } from "./plutonium-source.mjs";

// A per-legendary-action value estimate -- legendary actions are cheaper
// than a full turn (usually a single attack or minor effect), so this is
// deliberately a flat, conservative per-action figure rather than trying to
// model exactly what each legendary action does (that detail isn't in
// RawBestiaryFields at all -- only count/costPerAction are).
const LEGENDARY_ACTION_VALUE_ESTIMATE = 6;

// A deliberately coarse "threat per CR point" proxy, same "flat, conservative
// estimate" spirit as LEGENDARY_ACTION_VALUE_ESTIMATE above -- not calibrated
// against the DMG's offensive-CR table, just enough to make a CR-10 monster
// score meaningfully higher than a CR-1 one instead of scoring identically
// at 0.
const CR_THREAT_PER_POINT = 4;

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
 *   subset of {attacks, multiattack, rechargeAbilities, legendaryActions, challengeRating})
 * @returns {{score:number, breakdown:{baseAttacksPerRound:number, rechargeExpectedValue:number, legendaryActionValue:number, crDerivedThreat:number, crFallbackApplied:boolean}}}
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

  // See this module's own header comment ("WS-4 §0.7 defect fix (c)") --
  // only an entry with a genuinely EMPTY attacks list falls back to the CR
  // proxy; any real attack-derived contribution, however small, wins outright.
  let crDerivedThreat = 0;
  let crFallbackApplied = false;
  if (attacks.length === 0) {
    const crNum = crToNumber(rawFields.challengeRating);
    if (typeof crNum === "number" && crNum > 0) {
      crDerivedThreat = crNum * CR_THREAT_PER_POINT;
      crFallbackApplied = true;
    }
  }

  const score = baseAttacksPerRound + rechargeExpectedValue + legendaryActionValue + crDerivedThreat;

  return {
    score,
    breakdown: { baseAttacksPerRound, rechargeExpectedValue, legendaryActionValue, crDerivedThreat, crFallbackApplied }
  };
}
