/**
 * Encounter heuristic orchestrator — Phase 18 task 18.5. Ties together
 * 18.1-18.4: given a target difficulty and an ALREADY-thematically-filtered
 * candidate monster pool, suggests a combination/quantity hitting that
 * target using the deterministic scoring from action-economy.mjs/
 * effect-impact.mjs (18.3) and burst-ceiling.mjs/snowball-delta.mjs/
 * pack-coefficient.mjs (18.4).
 *
 * NO LLM CALL, NO IMPORT OF the shared model-call plumbing module living at
 * mutation-engine/ under the name "llm(hyphen)call.mjs" (task 18.5's own
 * acceptance criterion, checked directly by this module's own test file via
 * a grep over this file's source, matching session-planner/scenes.mjs's
 * no-Foundry-import test convention -- this comment itself avoids spelling
 * that filename out verbatim so it doesn't trip the same grep). The
 * candidate pool this module
 * consumes is expected to ALREADY be thematically filtered before it
 * arrives here — that filtering is combat-planning/thematic-filter.mjs's
 * job (its own, separate, LLM-touching module), kept apart specifically so
 * this file's deterministic core stays independently testable without
 * mocking any client at all.
 *
 * ASYMMETRIC-RISK FLAG NEVER BLENDED INTO expectedScore (design record §2's
 * explicit "never blended into the primary score" instruction): expectedScore
 * and burstCeiling are computed with ZERO reference to
 * knobs.burstCeilingThresholdPct — only the separate asymmetricRiskFlag
 * boolean reads that knob, as the very last step.
 *
 * Knob formulas below (tactics-slider multiplier, minion-rules discount,
 * legendary-action-toggle subtraction, greedy combination-fill tolerance)
 * are real implementation-time decisions the design record explicitly left
 * open (§4: "real implementation-time decisions, not designed to that level
 * of precision here") — chosen to be simple, deterministic, and documented
 * in place, not implied to be precision-tuned.
 *
 * Phase 18 addendum (QA pass found during Phase 19 task 19.0's test-authoring
 * pass, see review-ui/test/e2e/combat-planning-fixture.mjs's header comment):
 * added `scoreCombination`, a small additive export alongside
 * `suggestEncounter` for scoring an EXPLICIT, already-chosen combination (a
 * DM's manual roster edit) instead of auto-building one from a
 * targetDifficulty -- both now share the same `scoreCombinationCore`
 * internal so burstCeiling/snowballDelta/asymmetricRiskFlag are computed
 * identically either way, never a second, drifting copy of that math.
 */
import { computeActionEconomyScore } from "./action-economy.mjs";
import { computeBurstCeiling } from "./burst-ceiling.mjs";
import { computeSnowballDelta } from "./snowball-delta.mjs";
import { applyPackCoefficient } from "./pack-coefficient.mjs";
import { diceAverage } from "./dice.mjs";

const DEFAULT_KNOBS = {
  minionRules: false,
  legendaryActions: true,
  scalingSlider: 1,
  playerTacticsSlider: 0.5,
  burstCeilingThresholdPct: 0.5
};

/** A candidate's per-unit threat score, honoring the legendaryActions/minionRules knobs. */
function candidateThreat(entry, knobs) {
  let threat = entry.derivedScore?.actionEconomyScore;
  if (typeof threat !== "number") {
    threat = computeActionEconomyScore(entry.rawFields ?? {}).score;
  }
  if (!knobs.legendaryActions) {
    const legendaryValue = entry.derivedScore?.breakdown?.legendaryActionValue ?? 0;
    threat = Math.max(0, threat - legendaryValue);
  }
  if (knobs.minionRules) {
    // Minion-rules encounters trade individual durability for numbers --
    // approximated here as a flat discount on each unit's own threat
    // contribution (not a simulation of the minion rule itself).
    threat *= 0.85;
  }
  return threat;
}

/**
 * Greedily fills a combination toward `target`, highest-threat candidate
 * first (ties broken by entryId for determinism), stopping a candidate type
 * once one more copy would overshoot the target by more than 20% and moving
 * to the next-best type. Always returns at least one combatant if the pool
 * is non-empty. Deterministic: a stable sort plus a fixed tie-break means
 * identical input always produces the identical combination.
 */
function buildCombination(candidatePool, target, knobs) {
  const scored = candidatePool
    .map((entry) => ({ entryId: entry.entryId, entry, perUnitThreat: candidateThreat(entry, knobs) }))
    .filter((c) => c.perUnitThreat > 0)
    .sort((a, b) => b.perUnitThreat - a.perUnitThreat || a.entryId.localeCompare(b.entryId));

  const counts = new Map();
  let running = 0;
  const overshootCeiling = target * 1.2;

  for (const candidate of scored) {
    while (running + candidate.perUnitThreat <= overshootCeiling) {
      counts.set(candidate.entryId, (counts.get(candidate.entryId) ?? 0) + 1);
      running += candidate.perUnitThreat;
      if (running >= target) break;
    }
    if (running >= target) break;
  }

  if (counts.size === 0 && scored.length > 0) {
    counts.set(scored[0].entryId, 1);
  }

  return [...counts.entries()].map(([entryId, count]) => ({ entryId, count }));
}

/** Sum of a combination's threat, pack-coefficient-adjusted per entry, tactics-slider-adjusted overall. */
function computeCombinationExpectedScore(combination, candidateByEntryId, knobs) {
  // 0 = chaotic-spread, 1 = optimal-focus-fire, 0.5 = average -- a linear
  // +/-20% swing around the average case (the tactical-DM review's
  // top-requested lever, design record §2), not simulated in any way.
  const tacticsMultiplier = 0.8 + 0.4 * (knobs.playerTacticsSlider ?? 0.5);

  const total = combination.reduce((sum, { entryId, count }) => {
    const entry = candidateByEntryId.get(entryId);
    const perUnit = candidateThreat(entry, knobs);
    const hasFocusFireTrait = Boolean(entry.rawFields?.hasFocusFireTrait);
    return sum + applyPackCoefficient(perUnit, count, hasFocusFireTrait);
  }, 0);

  return total * tacticsMultiplier;
}

/** Burst components across a combination: each entry's recharge abilities, times how many copies are present (a "synchronized" burst -- design record §2). Recharge abilities need no external setup (setupSteps:0) -- the guard only ever excludes something described as needing 2+ setup steps, which nothing derivable from RawBestiaryFields today claims. */
function collectBurstComponents(combination, candidateByEntryId) {
  const components = [];
  for (const { entryId, count } of combination) {
    const entry = candidateByEntryId.get(entryId);
    for (const ability of entry?.rawFields?.rechargeAbilities ?? []) {
      const avg = diceAverage(ability.damageDice) ?? 0;
      if (avg <= 0) continue;
      components.push({ name: `${ability.name} × ${count}`, damage: avg * count, setupSteps: 0 });
    }
  }
  return components;
}

/** A crude "how much can this party absorb/return" proxy for one candidate's removal, when no combat-system profile is available -- see design record §2's "degrades to a cruder power-score comparison" allowance. */
function partyCapacity(party) {
  return party.reduce((sum, m) => sum + (m.damagePerRoundEstimate ?? 0) + (m.effectiveHp ?? 0), 0);
}

/**
 * Shared scoring core for a FINAL combination (already built, either by
 * buildCombination's own auto-fill or handed in verbatim by a caller that
 * already knows exactly what it wants) -- expectedScore/burstCeiling/
 * snowballDelta/asymmetricRiskFlag are computed identically regardless of
 * where `combination` came from. `combination` is returned as-is (the same
 * reference/array a caller passed in), so a caller that hands in its own
 * explicit combination gets it echoed back exactly, not rebuilt.
 */
function scoreCombinationCore(combination, candidateByEntryId, party, k) {
  // expectedScore/burstCeiling are computed with ZERO reference to
  // burstCeilingThresholdPct -- see this module's own top-of-file note.
  const expectedScore = computeCombinationExpectedScore(combination, candidateByEntryId, k);
  const burstComponents = collectBurstComponents(combination, candidateByEntryId);
  const burstCeiling = computeBurstCeiling(burstComponents).ceiling;

  const partyForDelta = party.map((p) => ({
    id: p.id,
    damagePerRoundEstimate: p.combatRelevant?.damagePerRoundEstimate ?? 0,
    effectiveHp: p.combatRelevant?.hp ?? 0
  }));
  const scoreAgainstPartySubset = (subset) => {
    const capacity = partyCapacity(subset);
    return capacity > 0 ? expectedScore / capacity : expectedScore;
  };
  const snowballDelta = computeSnowballDelta(partyForDelta, scoreAgainstPartySubset);

  // The ONLY place knobs.burstCeilingThresholdPct is ever read -- a
  // threshold on the ceiling number, never on expectedScore itself, per
  // the design record's explicit "implement it as a threshold on the
  // burst-ceiling number ... not as a skew baked into the average score."
  const partyEffectiveHpTotal = partyForDelta.reduce((sum, m) => sum + m.effectiveHp, 0);
  const asymmetricRiskFlag =
    partyEffectiveHpTotal > 0 && burstCeiling > partyEffectiveHpTotal * (k.burstCeilingThresholdPct ?? 0.5);

  return { combination, expectedScore, burstCeiling, snowballDelta, asymmetricRiskFlag };
}

/**
 * @param {object} args
 * @param {number} args.targetDifficulty
 * @param {Array<object>} args.candidatePool   already thematically filtered -- {entryId, rawFields, derivedScore}
 * @param {Array<object>} args.party            {id, combatRelevant:{hp, damagePerRoundEstimate, ...}}
 * @param {object} [args.knobs]
 * @returns {{combination:Array, expectedScore:number, burstCeiling:number, snowballDelta:object, asymmetricRiskFlag:boolean}}
 */
export function suggestEncounter({ targetDifficulty, candidatePool, party, knobs = {} }) {
  const k = { ...DEFAULT_KNOBS, ...knobs };
  const target = targetDifficulty * (k.scalingSlider ?? 1);

  const candidateByEntryId = new Map(candidatePool.map((c) => [c.entryId, c]));
  const combination = buildCombination(candidatePool, target, k);

  return scoreCombinationCore(combination, candidateByEntryId, party, k);
}

/**
 * Scores an EXPLICIT, already-chosen combination (e.g. a DM manually
 * assembling/editing the roster in the UI) instead of auto-building one from
 * a targetDifficulty -- reuses the exact same scoreCombinationCore math
 * suggestEncounter's own auto-fill path uses (task 18.5-addendum's explicit
 * "reuse the existing scoring internals, don't duplicate them" requirement),
 * only the buildCombination auto-fill step is skipped. The returned
 * `combination` is the same array/objects passed in, unmodified -- callers
 * that need to echo the input back exactly (review-ui/server.mjs's
 * encounter-suggest route) get that for free, not as a separate step.
 * @param {object} args
 * @param {Array<{entryId:string, count:number}>} args.combination
 * @param {Array<object>} args.candidatePool   {entryId, rawFields, derivedScore} -- used ONLY to look up each combination entry's own fields, not to constrain which entries may appear (unlike suggestEncounter's pool, this is not itself auto-filled from)
 * @param {Array<object>} args.party            {id, combatRelevant:{hp, damagePerRoundEstimate, ...}}
 * @param {object} [args.knobs]
 * @returns {{combination:Array, expectedScore:number, burstCeiling:number, snowballDelta:object, asymmetricRiskFlag:boolean}}
 */
export function scoreCombination({ combination, candidatePool, party, knobs = {} }) {
  const k = { ...DEFAULT_KNOBS, ...knobs };
  const candidateByEntryId = new Map(candidatePool.map((c) => [c.entryId, c]));
  return scoreCombinationCore(combination, candidateByEntryId, party, k);
}
