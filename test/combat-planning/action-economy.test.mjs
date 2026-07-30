import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/action-economy.mjs (Phase 18 task
 * 18.3). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.3 lands.
 *
 * PURE function, zero I/O, zero LLM calls -- matches mutation-engine/
 * propagate.mjs's convention exactly (task 18.3's own acceptance criterion:
 * "No LLM involvement"). Consumes combat-planning/bestiary-ingest.mjs's
 * RawBestiaryFields (attacks, multiattack, rechargeAbilities,
 * legendaryActions) and computes a deterministic action-economy score --
 * this is the OTHER half of the extraction/scoring split (18.1's LLM call
 * never computes this itself).
 *
 * Recharge-ability EXPECTED VALUE, not full-value credit (design record
 * §1a's stated concern operationalized as a scoring requirement, not just an
 * extraction one): "an LLM silently mis-weighting a recharge-5-6 ability as
 * 'always available'... would poison a score." This pure function must
 * therefore weight a recharge ability by its actual per-round trigger
 * probability (a d6 recharge roll: "5-6" = 2/6 chance per round, "6" = 1/6),
 * NOT credit its full damage every round.
 *
 * ---------------------------------------------------------------------------
 * computeActionEconomyScore(rawFields)
 * ---------------------------------------------------------------------------
 * @param {object} rawFields   a RawBestiaryFields-shaped object (or any
 *   subset of {attacks, multiattack, rechargeAbilities, legendaryActions} --
 *   every one of these is optional/absent-tolerant, since not every source
 *   creature has legendary actions, etc.)
 * @returns {{
 *   score: number,
 *   breakdown: {
 *     baseAttacksPerRound: number,        // sum of per-attack expected damage (dice average), times multiattack count if present
 *     rechargeExpectedValue: number,      // sum over rechargeAbilities of damage-average * (trigger chance per round)
 *     legendaryActionValue: number        // legendaryActions.count * a per-action value estimate
 *   }
 * }}
 *
 * Determinism: same input -> byte-identical output, always (no Math.random,
 * no Date.now anywhere in this module).
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
  const { computeActionEconomyScore } = await import("../../combat-planning/action-economy.mjs");

  test("computeActionEconomyScore: a single plain attack contributes its dice-average damage", () => {
    const result = computeActionEconomyScore({
      attacks: [{ name: "Bite", toHitBonus: 5, damageDice: "2d6+3" }]
    });
    // 2d6+3 averages to 10 -- exact average-of-dice-string computation is an
    // implementation detail; what's contractually required is that it's
    // POSITIVE and roughly in that neighborhood, and that the breakdown
    // field exists and is used to derive the total.
    assert.ok(result.score > 0);
    assert.ok(result.breakdown.baseAttacksPerRound > 0);
    assert.equal(result.breakdown.rechargeExpectedValue, 0, "no recharge abilities present -- must be exactly 0, not undefined");
  });

  test("computeActionEconomyScore: a recharge-5-6 ability contributes LESS than its full stated damage (expected value, never full credit)", () => {
    const noRecharge = computeActionEconomyScore({ attacks: [{ name: "Bite", damageDice: "1d4" }] });
    const withRecharge = computeActionEconomyScore({
      attacks: [{ name: "Bite", damageDice: "1d4" }],
      rechargeAbilities: [{ name: "Fire Breath", rechargeOn: "5-6", damageDice: "20d6" }]
    });
    // 20d6 averages to 70 -- if this were credited at full value every
    // round, withRecharge.score would be ~noRecharge.score + 70. It must
    // instead be credited at roughly (2/6) * 70 ≈ 23.3 -- a real, testable
    // fraction, not "always available."
    const rechargeContribution = withRecharge.score - noRecharge.score;
    assert.ok(rechargeContribution > 0, "a recharge ability must contribute SOMETHING, not be silently dropped");
    assert.ok(
      rechargeContribution < 70 * 0.5,
      `recharge-5-6 contribution (${rechargeContribution}) must be well under full value (70) -- expected roughly 70*(2/6)≈23.3`
    );
  });

  test("computeActionEconomyScore: a recharge-'6' (1/6 chance) ability contributes less than an otherwise-identical recharge-'5-6' (2/6 chance) ability", () => {
    const rechargeOn6 = computeActionEconomyScore({
      rechargeAbilities: [{ name: "Big Blast", rechargeOn: "6", damageDice: "10d6" }]
    });
    const rechargeOn56 = computeActionEconomyScore({
      rechargeAbilities: [{ name: "Big Blast", rechargeOn: "5-6", damageDice: "10d6" }]
    });
    assert.ok(
      rechargeOn6.breakdown.rechargeExpectedValue < rechargeOn56.breakdown.rechargeExpectedValue,
      "a narrower recharge window must contribute strictly less expected value"
    );
  });

  test("computeActionEconomyScore: multiattack multiplies the per-attack contribution", () => {
    const single = computeActionEconomyScore({ attacks: [{ name: "Claw", damageDice: "1d6+2" }] });
    const multi = computeActionEconomyScore({
      attacks: [{ name: "Claw", damageDice: "1d6+2" }],
      multiattack: { count: 3 }
    });
    assert.ok(multi.breakdown.baseAttacksPerRound > single.breakdown.baseAttacksPerRound * 2,
      "3 attacks via multiattack must contribute meaningfully more than 1"
    );
  });

  test("computeActionEconomyScore: legendary actions contribute a positive, non-zero amount when present", () => {
    const withoutLegendary = computeActionEconomyScore({ attacks: [{ name: "Bite", damageDice: "1d6" }] });
    const withLegendary = computeActionEconomyScore({
      attacks: [{ name: "Bite", damageDice: "1d6" }],
      legendaryActions: { count: 3, costPerAction: 1 }
    });
    assert.ok(withLegendary.breakdown.legendaryActionValue > 0);
    assert.ok(withLegendary.score > withoutLegendary.score);
  });

  test("computeActionEconomyScore: is deterministic -- same input twice, byte-identical output", () => {
    const input = {
      attacks: [{ name: "Bite", damageDice: "2d6+3" }],
      rechargeAbilities: [{ name: "Fire Breath", rechargeOn: "5-6", damageDice: "20d6" }],
      legendaryActions: { count: 2 }
    };
    const a = computeActionEconomyScore(input);
    const b = computeActionEconomyScore(input);
    assert.deepEqual(a, b);
  });

  test("computeActionEconomyScore: handles a minimal creature with no attacks/recharge/legendary at all, without throwing", () => {
    const result = computeActionEconomyScore({});
    assert.equal(typeof result.score, "number");
    assert.equal(result.breakdown.baseAttacksPerRound, 0);
    assert.equal(result.breakdown.rechargeExpectedValue, 0);
    assert.equal(result.breakdown.legendaryActionValue, 0);
  });

  console.log(`\n${passed} passed`);
})();
