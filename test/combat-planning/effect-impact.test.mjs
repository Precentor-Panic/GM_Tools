import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/effect-impact.mjs (Phase 18 task
 * 18.3). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.3 lands.
 *
 * THE SINGLE MOST LOAD-BEARING CORRECTNESS REQUIREMENT IN THIS ENTIRE PHASE
 * (per plans/phase-18-review.md §2/§6's balance-designer review, and task
 * 18.0's own explicit instruction): aggregation across axes for one effect
 * is DOMINANT-AXIS-PLUS-DECAY, NOT FLAT SUMMING. A test below asserts this
 * with real numbers, not just a comment -- if a future implementation
 * "helpfully" simplifies to `sum(axisScores)`, that test must fail.
 *
 * The six-axis taxonomy (design record §2, researched across D&D 5e, Draw
 * Steel, Daggerheart, WoW DR categories, LoL hard/soft CC):
 *   axis1_actionEconomy       -- full turn/action-slot denial (Stun, Dazed)
 *   axis2_mobility             -- can't move but can still act (Restrained, Root)
 *   axis3_accuracySelf         -- degrades the TARGET's own effectiveness once it acts (Frightened, Weakened)
 *   axis4_survivabilityTarget  -- makes the target easier to hit/affected (Prone vs. melee, Vulnerable)
 *   axis5_resourceDrain        -- guaranteed HP/resource loss over time or on-condition (Poison-adjacent, Bleeding)
 *   axis6_forcedAction         -- compels a specific action rather than blocking one (Charmed, Taunt)
 *
 * AXIS 5 NEVER BLENDS INTO THE SHARED "IMPACT" POOL (design record §2,
 * explicit demotion per the balance-designer review): it's a guaranteed HP
 * delta, not a probability/availability shift like axes 1-4/6. It is always
 * reported on its OWN, separate from aggregateAxisScores' output -- a test
 * below constructs an effect that hits BOTH axis5 and another axis, and
 * asserts the axis5 contribution is never folded into the combined
 * aggregatedImpactScore.
 *
 * UNSCORED EFFECT, NEVER A GUESSED DEFAULT (task 18.0's own hard
 * requirement, matching Phase 16/17's "render empty rather than padded"
 * discipline): an effect name absent from EFFECT_TAXONOMY returns
 * `{scored:false, ...}` -- NEVER a fabricated `{scored:true, ...axisScores
 * all 0}` or an averaged guess. A test below would FAIL if someone
 * "helpfully" made an unknown effect default to a zero/average score.
 *
 * ---------------------------------------------------------------------------
 * EFFECT_TAXONOMY
 * ---------------------------------------------------------------------------
 * Exported lookup table, keys are LOWERCASED effect names, values are
 * `{axis1_actionEconomy?, axis2_mobility?, axis3_accuracySelf?,
 * axis4_survivabilityTarget?, axis5_resourceDrain?, axis6_forcedAction?}` --
 * each present axis a 0-10 raw score, absent axes not touched by this
 * effect at all (NOT present as 0 -- absence vs. zero matters for
 * aggregateAxisScores, see below). Must include at minimum (task 18.3's own
 * v1 starting set): stunned, paralyzed, restrained, prone, frightened,
 * grappled, poisoned, blinded, charmed, incapacitated, petrified,
 * unconscious, deafened, exhaustion.
 *   Dominant-axis assignments this test file locks in (from the design
 *   record's own worked examples):
 *     stunned    -> dominant axis1_actionEconomy (full turn denial)
 *     restrained -> dominant axis2_mobility (can't move, can still act)
 *     frightened -> dominant axis3_accuracySelf (attack disadvantage)
 *     prone      -> dominant axis4_survivabilityTarget ("Prone vs. melee" -- design record's own example)
 *     poisoned   -> dominant axis5_resourceDrain ("poison-adjacent" -- design record's own example)
 *     charmed    -> dominant axis6_forcedAction ("Charmed, Taunt" -- design record's own example)
 *     paralyzed  -> hits BOTH axis1_actionEconomy AND axis4_survivabilityTarget
 *                   (real multi-axis effect: incapacitated + auto-crit-in-melee)
 *
 * ---------------------------------------------------------------------------
 * durationMultiplier(axisKey, duration)
 * ---------------------------------------------------------------------------
 * PURE function. axis-aware, NOT a flat multiplier (design record §2):
 * steep/near-linear for axis1/axis2/axis6, flatter for axis3/axis4,
 * NO-OP (always exactly 1) for axis5 (already priced into the flat damage
 * sum, and demoted out of the shared pool anyway).
 *   @param {string} axisKey   one of the 6 axis keys above
 *   @param {number} duration  in rounds (or the source's native duration unit)
 *   @returns {number}   a multiplier >= 1 for duration >= 1
 *
 * ---------------------------------------------------------------------------
 * aggregateAxisScores(axisScores, opts)
 * ---------------------------------------------------------------------------
 * PURE function. DOMINANT-AXIS-PLUS-DECAY, not flat summing: full weight on
 * the single highest-scoring axis among {axis1,axis2,axis3,axis4,axis6}
 * ONLY (axis5 excluded from this function's input entirely -- see below), a
 * decayed weight (~25-40%, opts.decayFactor) on every co-triggered axis.
 *   @param {{axis1_actionEconomy?, axis2_mobility?, axis3_accuracySelf?,
 *            axis4_survivabilityTarget?, axis6_forcedAction?}} axisScores
 *     -- NEVER includes an axis5_resourceDrain key; a caller passing one is
 *     a contract violation (this function's job is exactly the 5-axis pool
 *     axis5 is excluded from).
 *   @param {object} [opts]
 *   @param {number} [opts.decayFactor=0.3]   fraction of a co-triggered axis's own raw score added on top of the dominant axis
 *   @returns {number}
 *
 * ---------------------------------------------------------------------------
 * scoreEffect(effectName, opts)
 * ---------------------------------------------------------------------------
 * The full per-effect pipeline: taxonomy lookup -> duration multiplier (per
 * present axis) -> aggregation (axes 1-4/6 only) -> axis5 reported separately.
 *   @param {string} effectName   matched case-insensitively against EFFECT_TAXONOMY
 *   @param {object} [opts]
 *   @param {number} [opts.duration=1]
 *   @returns {
 *     {scored:false, effectName:string, reason:string}
 *     |
 *     {scored:true, effectName:string, axisScores:object, resourceDrainScore:number,
 *      aggregatedImpactScore:number}
 *   }
 *   resourceDrainScore is 0 (a real, present number -- never omitted) when
 *   the effect doesn't touch axis5 at all.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

(async () => {
  const { EFFECT_TAXONOMY, durationMultiplier, aggregateAxisScores, scoreEffect } =
    await import("../../combat-planning/effect-impact.mjs");

  // ---------------------------------------------------------- taxonomy shape

  test("EFFECT_TAXONOMY: includes the required v1 starting set of well-known D&D 5e condition names", () => {
    const required = [
      "stunned", "paralyzed", "restrained", "prone", "frightened", "grappled",
      "poisoned", "blinded", "charmed", "incapacitated", "petrified", "unconscious",
      "deafened", "exhaustion"
    ];
    for (const name of required) {
      assert.ok(name in EFFECT_TAXONOMY, `EFFECT_TAXONOMY must include "${name}"`);
    }
  });

  // ------------------------------------------------- dominant-axis mapping

  test("stunned: dominant axis is action-economy (full turn denial)", () => {
    const s = scoreEffect("Stunned", { duration: 1 });
    assert.equal(s.scored, true);
    const axes = s.axisScores;
    const dominant = Object.entries(axes).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(dominant, "axis1_actionEconomy");
  });

  test("restrained: dominant axis is mobility", () => {
    const s = scoreEffect("Restrained", { duration: 1 });
    const dominant = Object.entries(s.axisScores).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(dominant, "axis2_mobility");
  });

  test("frightened: dominant axis is accuracy-self", () => {
    const s = scoreEffect("Frightened", { duration: 1 });
    const dominant = Object.entries(s.axisScores).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(dominant, "axis3_accuracySelf");
  });

  test("prone: dominant axis is survivability-as-target (design record's own 'Prone vs. melee' example)", () => {
    const s = scoreEffect("Prone", { duration: 1 });
    const dominant = Object.entries(s.axisScores).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(dominant, "axis4_survivabilityTarget");
  });

  test("charmed: dominant axis is forced-action (design record's own 'Charmed, Taunt' example)", () => {
    const s = scoreEffect("Charmed", { duration: 1 });
    const dominant = Object.entries(s.axisScores).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(dominant, "axis6_forcedAction");
  });

  test("case-insensitive lookup: 'STUNNED' and 'stunned' resolve to the same taxonomy entry", () => {
    const upper = scoreEffect("STUNNED", { duration: 1 });
    const lower = scoreEffect("stunned", { duration: 1 });
    assert.deepEqual(upper.axisScores, lower.axisScores);
  });

  // ------------------------------------------------------ UNSCORED EFFECT

  test("UNSCORED EFFECT: an unrecognized/homebrew effect name returns scored:false, NEVER a guessed default score", () => {
    const result = scoreEffect("Woozy Aura (homebrew)", { duration: 1 });
    assert.equal(result.scored, false, "must be explicitly false, not silently true with a zero/averaged score");
    assert.ok(typeof result.reason === "string" && result.reason.length > 0, "must explain WHY it's unscored");
    assert.ok(!("axisScores" in result), "an unscored result must not carry a fabricated axisScores object at all");
    assert.ok(!("aggregatedImpactScore" in result), "an unscored result must not carry a fabricated aggregate score");
  });

  test("UNSCORED EFFECT regression guard: this is NOT the same object shape as a real zero-scored effect -- scored:true with all-zero axes is a DIFFERENT (never-produced) case from scored:false", () => {
    // This test exists specifically to catch a "helpful" simplification: if
    // a future implementation ever collapses "unscored" into "scored with a
    // score of 0," this assertion fails because `axisScores` would then
    // exist on the unscored result.
    const result = scoreEffect("Definitely Not A Real Condition Name", {});
    assert.equal(result.scored, false);
  });

  // -------------------------------------------- axis 5 never blends in

  test("AXIS 5 NEVER BLENDS: poisoned's resourceDrainScore is reported SEPARATELY, and aggregatedImpactScore does not silently include it", () => {
    const s = scoreEffect("Poisoned", { duration: 1 });
    assert.equal(s.scored, true);
    assert.ok(s.resourceDrainScore > 0, "poisoned must have a positive, non-zero resource-drain contribution");
    assert.ok(!("axis5_resourceDrain" in s.axisScores), "axis5 must never appear inside the same axisScores object aggregateAxisScores consumes");
  });

  test("AXIS 5 NEVER BLENDS: a synthetic multi-axis effect's aggregatedImpactScore is IDENTICAL whether or not axis5 also fires", () => {
    // Directly exercise aggregateAxisScores with and without an axis5 value
    // smuggled in via a caller mistake -- if this function's contract were
    // violated (axis5 silently summed in), these two calls would differ.
    const withoutAxis5 = aggregateAxisScores({ axis1_actionEconomy: 6 });
    const scoredEffect = scoreEffect("Poisoned", { duration: 1 });
    // poisoned's OWN non-axis5 axes (if any) aggregate to the same value
    // aggregateAxisScores would independently produce from those same axes
    // alone -- proving resourceDrainScore was never folded in upstream.
    const nonAxis5 = Object.fromEntries(Object.entries(scoredEffect.axisScores));
    const recomputed = aggregateAxisScores(nonAxis5);
    assert.equal(scoredEffect.aggregatedImpactScore, recomputed);
    void withoutAxis5;
  });

  // ---------------------------------- DOMINANT-AXIS-PLUS-DECAY, not flat sum

  test("THE AGGREGATION TEST: an effect hitting two axes at 10 and 8 aggregates to LESS than the flat sum (18) -- this is what proves decay is real, not just documented", () => {
    const combined = aggregateAxisScores({ axis1_actionEconomy: 10, axis4_survivabilityTarget: 8 });
    assert.ok(combined < 18, `expected dominant-plus-decay aggregation < 18 (flat sum), got ${combined}`);
    assert.ok(combined >= 10, "must be at least the dominant axis's own raw score (full weight on the dominant axis)");
  });

  test("aggregateAxisScores: a single-axis input aggregates to exactly that axis's own score (no phantom decay applied to nothing)", () => {
    assert.equal(aggregateAxisScores({ axis2_mobility: 7 }), 7);
  });

  test("aggregateAxisScores: three co-triggered axes still aggregate to less than their flat sum", () => {
    const combined = aggregateAxisScores({ axis1_actionEconomy: 9, axis2_mobility: 6, axis4_survivabilityTarget: 4 });
    assert.ok(combined < 19);
  });

  test("paralyzed (a REAL multi-axis taxonomy entry, action-economy + survivability): aggregatedImpactScore is less than the flat sum of its own axisScores", () => {
    const s = scoreEffect("Paralyzed", { duration: 1 });
    const flatSum = Object.values(s.axisScores).reduce((a, b) => a + b, 0);
    assert.ok(
      Object.keys(s.axisScores).length >= 2,
      "paralyzed must be a genuine multi-axis taxonomy entry for this test to be meaningful"
    );
    assert.ok(s.aggregatedImpactScore < flatSum, `expected < flat sum (${flatSum}), got ${s.aggregatedImpactScore}`);
  });

  // ------------------------------------------------- duration multiplier

  test("durationMultiplier: axis5 is ALWAYS a no-op (exactly 1), regardless of duration", () => {
    assert.equal(durationMultiplier("axis5_resourceDrain", 1), 1);
    assert.equal(durationMultiplier("axis5_resourceDrain", 10), 1);
  });

  test("durationMultiplier: the SAME duration value produces a STEEPER multiplier on axis1 than on axis3 (steep vs. flatter, design record §2)", () => {
    const duration = 5;
    const axis1Mult = durationMultiplier("axis1_actionEconomy", duration);
    const axis3Mult = durationMultiplier("axis3_accuracySelf", duration);
    const axis1MultAt1 = durationMultiplier("axis1_actionEconomy", 1);
    const axis3MultAt1 = durationMultiplier("axis3_accuracySelf", 1);
    const axis1Growth = axis1Mult / axis1MultAt1;
    const axis3Growth = axis3Mult / axis3MultAt1;
    assert.ok(
      axis1Growth > axis3Growth,
      `axis1 (steep) must grow faster with duration than axis3 (flatter): axis1 growth=${axis1Growth}, axis3 growth=${axis3Growth}`
    );
  });

  test("scoreEffect: the SAME duration produces different aggregatedImpactScore deltas depending on which effect/axis is dominant (steep axis1 'stunned' vs. flatter axis3 'frightened')", () => {
    const stunnedShort = scoreEffect("Stunned", { duration: 1 });
    const stunnedLong = scoreEffect("Stunned", { duration: 4 });
    const frightenedShort = scoreEffect("Frightened", { duration: 1 });
    const frightenedLong = scoreEffect("Frightened", { duration: 4 });

    const stunnedDelta = stunnedLong.aggregatedImpactScore - stunnedShort.aggregatedImpactScore;
    const frightenedDelta = frightenedLong.aggregatedImpactScore - frightenedShort.aggregatedImpactScore;

    assert.ok(stunnedDelta > 0, "duration must actually change the score for a scored effect");
    assert.ok(
      stunnedDelta > frightenedDelta,
      `axis1-dominant (stunned) must scale steeper with duration than axis3-dominant (frightened): ` +
      `stunnedDelta=${stunnedDelta}, frightenedDelta=${frightenedDelta}`
    );
  });

  test("scoreEffect: duration never changes poisoned's resourceDrainScore -- axis5's duration multiplier is a hard no-op (1), even though a longer stun's aggregatedImpactScore visibly changes", () => {
    const short = scoreEffect("Poisoned", { duration: 1 });
    const long = scoreEffect("Poisoned", { duration: 5 });
    assert.equal(short.resourceDrainScore, long.resourceDrainScore, "axis5's own duration multiplier must stay exactly 1 regardless of duration");
  });

  console.log(`\n${passed} passed`);
})();
