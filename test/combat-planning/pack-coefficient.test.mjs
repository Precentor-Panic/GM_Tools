import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/pack-coefficient.mjs (Phase 18 task
 * 18.4). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.4 lands.
 *
 * PURE function, zero I/O, zero LLM calls. Design record §2: "a one-line
 * static multiplier, effective_threat x f(mob_count, has_focus_fire_trait)...
 * Six identical wolves are not six independent threat units summed." No
 * target-selection AI attempted (correctly out of scope) -- this is a static
 * knob, not a simulation.
 *
 * ---------------------------------------------------------------------------
 * computePackCoefficient(mobCount, hasFocusFireTrait)
 * ---------------------------------------------------------------------------
 * @param {number} mobCount
 * @param {boolean} hasFocusFireTrait   e.g. Pack Tactics, a shared-target buff
 * @returns {number}   a multiplier. MUST be exactly 1 when hasFocusFireTrait
 *   is false, for any mobCount (independent copies really are just an
 *   independent sum, no silent baseline boost) -- MUST be > 1 when
 *   hasFocusFireTrait is true and mobCount > 1 (mobCount === 1 with the
 *   trait is degenerate -- a single monster can't focus-fire with itself,
 *   so the trait should have no effect at mobCount 1: coefficient must still
 *   be exactly 1 there too).
 *
 * ---------------------------------------------------------------------------
 * applyPackCoefficient(perMonsterThreat, mobCount, hasFocusFireTrait)
 * ---------------------------------------------------------------------------
 * @param {number} perMonsterThreat   a single monster's own threat/score figure
 * @param {number} mobCount
 * @param {boolean} hasFocusFireTrait
 * @returns {number}   perMonsterThreat * mobCount * computePackCoefficient(mobCount, hasFocusFireTrait)
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
  const { computePackCoefficient, applyPackCoefficient } = await import("../../combat-planning/pack-coefficient.mjs");

  test("computePackCoefficient: no focus-fire trait -> coefficient is exactly 1, for any mob count (a real independent-sum sanity check, not silently pre-boosted)", () => {
    assert.equal(computePackCoefficient(1, false), 1);
    assert.equal(computePackCoefficient(4, false), 1);
    assert.equal(computePackCoefficient(10, false), 1);
  });

  test("computePackCoefficient: mobCount 1 with the trait is degenerate -- coefficient is still exactly 1 (a single monster can't focus-fire with itself)", () => {
    assert.equal(computePackCoefficient(1, true), 1);
  });

  test("THE PACK TEST: N identical monsters WITH a focus-fire trait score higher than N independent copies WITHOUT one", () => {
    const perMonsterThreat = 10;
    const mobCount = 4;
    const withTrait = applyPackCoefficient(perMonsterThreat, mobCount, true);
    const withoutTrait = applyPackCoefficient(perMonsterThreat, mobCount, false);
    assert.ok(withTrait > withoutTrait, `expected focus-fire pack (${withTrait}) > independent copies (${withoutTrait})`);
  });

  test("applyPackCoefficient: without the trait, the result is EXACTLY the flat independent sum (perMonsterThreat * mobCount)", () => {
    assert.equal(applyPackCoefficient(10, 4, false), 40);
  });

  test("computePackCoefficient: coefficient grows (or at minimum never shrinks) as mobCount increases, holding the trait fixed", () => {
    const at2 = computePackCoefficient(2, true);
    const at6 = computePackCoefficient(6, true);
    assert.ok(at6 >= at2, `expected coefficient at mobCount=6 (${at6}) >= at mobCount=2 (${at2})`);
  });

  console.log(`\n${passed} passed`);
})();
