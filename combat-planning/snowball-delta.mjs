/**
 * Snowball delta — Phase 18 task 18.4. PURE function, zero I/O, zero LLM
 * calls. Design record §2: "the same scoring function run twice -- once
 * with the full party, once with a single PC removed -- reporting the
 * swing. Run against TWO candidates, not one 'most critical' PC: the top
 * damage contributor... and the top effective-HP/mitigation contributor...
 * a single 'most critical' pick answers the wrong question for half of all
 * encounter types."
 *
 * Deliberately takes the scoring function as an INJECTED PARAMETER rather
 * than importing combat-planning/encounter-heuristic.mjs or
 * effect-impact.mjs itself -- keeps this module genuinely
 * pure/standalone, matching mutation-engine/propagate.mjs's "plain
 * functions over data" convention. The real encounter-heuristic
 * orchestrator (18.5) supplies a real scoring function when it calls this.
 */

/**
 * @param {Array<{id:string, damagePerRoundEstimate:number, effectiveHp:number}>} partyMembers   at least 2 members required
 * @param {(party: Array) => number} computeEncounterScore
 * @returns {{
 *   topDamageContributorId: string,
 *   topDamageContributorDelta: number,
 *   topEffectiveHpContributorId: string,
 *   topEffectiveHpContributorDelta: number
 * }}
 */
export function computeSnowballDelta(partyMembers, computeEncounterScore) {
  const topDamage = partyMembers.reduce((best, m) =>
    (m.damagePerRoundEstimate ?? 0) > (best.damagePerRoundEstimate ?? 0) ? m : best
  );
  const topEffectiveHp = partyMembers.reduce((best, m) =>
    (m.effectiveHp ?? 0) > (best.effectiveHp ?? 0) ? m : best
  );

  const fullScore = computeEncounterScore(partyMembers);
  const withoutTopDamage = computeEncounterScore(partyMembers.filter((m) => m.id !== topDamage.id));
  const withoutTopEffectiveHp =
    topEffectiveHp.id === topDamage.id
      ? withoutTopDamage
      : computeEncounterScore(partyMembers.filter((m) => m.id !== topEffectiveHp.id));

  return {
    topDamageContributorId: topDamage.id,
    topDamageContributorDelta: fullScore - withoutTopDamage,
    topEffectiveHpContributorId: topEffectiveHp.id,
    topEffectiveHpContributorDelta: fullScore - withoutTopEffectiveHp
  };
}
