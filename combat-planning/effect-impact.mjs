/**
 * Effect-impact taxonomy — Phase 18 task 18.3. PURE, zero I/O, zero LLM
 * calls (mutation-engine/propagate.mjs's convention).
 *
 * THE SINGLE MOST LOAD-BEARING CORRECTNESS REQUIREMENT IN THIS ENTIRE PHASE
 * (plans/phase-18-review.md §2/§6): aggregation across axes for one effect
 * is DOMINANT-AXIS-PLUS-DECAY, NOT FLAT SUMMING — see aggregateAxisScores.
 *
 * Six-axis taxonomy (design record §2, researched across D&D 5e, Draw
 * Steel, Daggerheart, WoW DR categories, LoL hard/soft CC):
 *   axis1_actionEconomy       -- full turn/action-slot denial (Stun, Dazed)
 *   axis2_mobility             -- can't move but can still act (Restrained, Root)
 *   axis3_accuracySelf         -- degrades the TARGET's own effectiveness once it acts (Frightened, Weakened)
 *   axis4_survivabilityTarget  -- makes the target easier to hit/affected (Prone vs. melee, Vulnerable)
 *   axis5_resourceDrain        -- guaranteed HP/resource loss over time or on-condition (Poison-adjacent, Bleeding)
 *   axis6_forcedAction         -- compels a specific action rather than blocking one (Charmed, Taunt)
 *
 * AXIS 5 NEVER BLENDS INTO THE SHARED "IMPACT" POOL (explicit demotion per
 * the balance-designer review): it's a guaranteed HP delta, not a
 * probability/availability shift like axes 1-4/6. Always reported on its
 * own (scoreEffect's resourceDrainScore), never as a key inside the
 * axisScores object aggregateAxisScores consumes.
 *
 * UNSCORED EFFECT, NEVER A GUESSED DEFAULT: an effect name absent from
 * EFFECT_TAXONOMY returns `{scored:false, effectName, reason}` — never a
 * fabricated `{scored:true, ...}` with a zero/averaged score.
 */

// Raw per-axis scores are 0-10, curated by hand against each condition's
// real (D&D 5e, primarily) mechanical text -- a "reasonable v1 starting
// set," per task 18.3's own framing, extendable if an obvious gap surfaces.
// Deliberately mostly single-axis (only paralyzed is genuinely multi-axis
// here) so each entry's dominant axis is unambiguous and the axis-aware
// duration multiplier's effect on aggregatedImpactScore stays legible.
export const EFFECT_TAXONOMY = {
  // Full turn/action denial -- can't act, can still be moved/targeted.
  stunned: { axis1_actionEconomy: 10 },
  // Incapacitated + auto-fail Str/Dex saves + attacks against have
  // advantage -- both action-economy AND survivability, a genuine
  // real multi-axis effect (locked in by the design record's own worked
  // example: "a paralysis-equivalent hits both action-economy AND
  // survivability simultaneously").
  paralyzed: { axis1_actionEconomy: 10, axis4_survivabilityTarget: 8 },
  // Speed 0, can still act -- pure mobility denial.
  restrained: { axis2_mobility: 8 },
  // Speed 0, no other combat penalty (unlike restrained, no attack
  // disadvantage) -- pure, slightly lighter mobility denial.
  grappled: { axis2_mobility: 5 },
  // Disadvantage on the TARGET's own attacks/checks while a source of fear
  // is in sight -- degrades its own effectiveness once it acts.
  frightened: { axis3_accuracySelf: 7 },
  // "Prone vs. melee" (design record's own example): melee attacks against
  // the target have advantage, ranged attacks have disadvantage -- net
  // effect is "easier to hit," survivability-as-target.
  prone: { axis4_survivabilityTarget: 6 },
  // Disadvantage on the target's own attacks/checks, PLUS the "poison-
  // adjacent" guaranteed-damage-over-time reading the design record's own
  // example names -- a real (if modest) multi-axis effect, but its resource-
  // drain contribution is reported entirely separately (never blended).
  poisoned: { axis3_accuracySelf: 3, axis5_resourceDrain: 6 },
  // Auto-fail sight-based checks, own attacks have disadvantage, attacks
  // against have advantage -- both accuracy-self and survivability.
  blinded: { axis3_accuracySelf: 5, axis4_survivabilityTarget: 5 },
  // "Charmed, Taunt" (design record's own example): compels a specific
  // restriction on action rather than blocking action outright.
  charmed: { axis6_forcedAction: 8 },
  // Can't take actions or reactions, but (unlike stunned) movement/speech
  // are unaffected -- a real but slightly lighter action-economy hit.
  incapacitated: { axis1_actionEconomy: 7 },
  // Incapacitated, can't move/speak, unaware of surroundings, attacks
  // against have advantage, auto-fail Str/Dex saves -- as severe as
  // paralyzed on both axes (damage resistance is a mitigating factor this
  // taxonomy doesn't model, since it isn't a probability/availability
  // shift the way the other axes are).
  petrified: { axis1_actionEconomy: 10, axis4_survivabilityTarget: 9 },
  // Incapacitated, unaware, attacks against have advantage and auto-crit
  // within 5 feet -- the same severe action-economy + survivability shape
  // as paralyzed/petrified.
  unconscious: { axis1_actionEconomy: 10, axis4_survivabilityTarget: 9 },
  // Can't hear -- narrow, mostly-noncombat impact; a small accuracy-self
  // hit for hearing-gated checks only.
  deafened: { axis3_accuracySelf: 1 },
  // Multi-level, cumulative debuff (disadvantage on checks, speed
  // reduction, hp-max reduction, eventually death) -- modeled here as a
  // rough blended average across levels rather than per-level granularity,
  // which RawBestiaryFields/RawPartyMemberFields have no field for anyway.
  exhaustion: { axis2_mobility: 3, axis3_accuracySelf: 4, axis5_resourceDrain: 2 }
};

const AXIS_POOL = [
  "axis1_actionEconomy",
  "axis2_mobility",
  "axis3_accuracySelf",
  "axis4_survivabilityTarget",
  "axis6_forcedAction"
];

// Duration-growth rates (design record §2): steep/near-linear for axes
// 1/2/6 (turns denied scales roughly linearly in danger), flatter
// (sub-linear, sqrt-shaped) for axes 3/4 (the marginal terror of a 3rd
// round of disadvantage drops off). axis5 is a hard no-op (always exactly
// 1) -- handled as a special case below, not via these rate tables, since
// it's demoted out of the shared pool entirely and already priced into the
// flat damage sum.
const STEEP_AXES = new Set(["axis1_actionEconomy", "axis2_mobility", "axis6_forcedAction"]);
const FLAT_AXES = new Set(["axis3_accuracySelf", "axis4_survivabilityTarget"]);
const STEEP_RATE = 0.5; // +50% of the base score per extra round, roughly linear
const FLAT_RATE = 0.25; // sqrt-shaped -- diminishing per additional round

/**
 * PURE function. axis-aware, NOT a flat multiplier.
 * @param {string} axisKey
 * @param {number} duration   in rounds (or the source's native duration unit)
 * @returns {number}   a multiplier >= 1 for duration >= 1
 */
export function durationMultiplier(axisKey, duration) {
  if (axisKey === "axis5_resourceDrain") return 1;
  const clamped = Math.max(1, Number(duration) || 1);
  const extraRounds = clamped - 1;
  if (STEEP_AXES.has(axisKey)) return 1 + extraRounds * STEEP_RATE;
  if (FLAT_AXES.has(axisKey)) return 1 + Math.sqrt(extraRounds) * FLAT_RATE;
  // An unrecognized axis key: no-op rather than guessing a growth shape.
  return 1;
}

/**
 * PURE function. DOMINANT-AXIS-PLUS-DECAY, not flat summing: full weight on
 * the single highest-scoring axis among {axis1,axis2,axis3,axis4,axis6}
 * ONLY (axis5 is never read from `axisScores` even if a caller mistakenly
 * includes it -- filtered out below rather than trusted).
 * @param {object} [axisScores]
 * @param {object} [opts]
 * @param {number} [opts.decayFactor=0.3]
 * @returns {number}
 */
export function aggregateAxisScores(axisScores = {}, opts = {}) {
  const decayFactor = opts.decayFactor ?? 0.3;
  const entries = AXIS_POOL
    .filter((key) => typeof axisScores[key] === "number")
    .map((key) => axisScores[key])
    .sort((a, b) => b - a);

  if (entries.length === 0) return 0;

  const [dominant, ...rest] = entries;
  const decaySum = rest.reduce((sum, score) => sum + score * decayFactor, 0);
  return dominant + decaySum;
}

/**
 * The full per-effect pipeline: taxonomy lookup -> duration multiplier (per
 * present axis) -> aggregation (axes 1-4/6 only) -> axis5 reported
 * separately.
 * @param {string} effectName   matched case-insensitively against EFFECT_TAXONOMY
 * @param {object} [opts]
 * @param {number} [opts.duration=1]
 * @returns {{scored:false, effectName:string, reason:string} | {scored:true, effectName:string, axisScores:object, resourceDrainScore:number, aggregatedImpactScore:number}}
 */
export function scoreEffect(effectName, opts = {}) {
  if (typeof effectName !== "string" || !effectName.trim()) {
    return { scored: false, effectName, reason: "No effect name given." };
  }

  const key = effectName.trim().toLowerCase();
  const taxonomyEntry = EFFECT_TAXONOMY[key];
  if (!taxonomyEntry) {
    return {
      scored: false,
      effectName,
      reason:
        `"${effectName}" is not in EFFECT_TAXONOMY -- an unrecognized/homebrew effect name is never given a ` +
        `guessed default score. Add it to the taxonomy, or tag it manually, to score it.`
    };
  }

  const duration = opts.duration ?? 1;
  const axisScores = {};
  let resourceDrainScore = 0;

  for (const [axisKey, rawScore] of Object.entries(taxonomyEntry)) {
    const scaled = rawScore * durationMultiplier(axisKey, duration);
    if (axisKey === "axis5_resourceDrain") {
      resourceDrainScore = scaled;
    } else {
      axisScores[axisKey] = scaled;
    }
  }

  return {
    scored: true,
    effectName,
    axisScores,
    resourceDrainScore,
    aggregatedImpactScore: aggregateAxisScores(axisScores)
  };
}
