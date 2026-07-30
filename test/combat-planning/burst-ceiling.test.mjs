import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/burst-ceiling.mjs (Phase 18 task
 * 18.4). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.4 lands.
 *
 * PURE function, zero I/O, zero LLM calls (mutation-engine/propagate.mjs's
 * convention). Design record §2: "a separate worst-case number (max
 * recharge-ability damage, a synchronized-crit ceiling) -- answers 'what if
 * the monsters roll well' without simulating anything." NOT a Monte Carlo
 * roll of any kind -- this is a static max-plausible-damage sum over a
 * candidate list of burst components.
 *
 * THE SETUP-STEP GUARD (task 18.0's own hard requirement, "fantasy ceiling"
 * guard against an unreachable number DMs learn to ignore): "only count
 * burst components a monster can hit unconditionally or with <=1 free setup
 * step... or the number becomes unreachable in practice." A component
 * needing 2+ setup steps (a Sneak-Attack-style effect needing a prior ally
 * hit, e.g.) must be EXCLUDED from the ceiling total, not counted at full
 * value and not silently discounted by some fudge factor either -- the
 * design record's language is "excluded," and this module's contract
 * follows that literally: setupSteps >= 2 -> fully excluded.
 *
 * ---------------------------------------------------------------------------
 * computeBurstCeiling(components)
 * ---------------------------------------------------------------------------
 * @param {Array<{name:string, damage:number, setupSteps:number}>} components
 *   setupSteps: 0 = unconditional (always available), 1 = needs exactly one
 *   free setup action (still counted at FULL value per the design record's
 *   "<=1 free setup step" language), 2+ = needs a genuinely conditional
 *   setup (e.g. an ally must land a hit first) -- EXCLUDED from the ceiling.
 * @returns {{
 *   ceiling: number,                         // sum of damage over included components ONLY
 *   included: Array<{name:string, damage:number, setupSteps:number}>,
 *   excluded: Array<{name:string, damage:number, setupSteps:number}>
 * }}
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
  const { computeBurstCeiling } = await import("../../combat-planning/burst-ceiling.mjs");

  test("computeBurstCeiling: an unconditional (setupSteps:0) component is fully included", () => {
    const result = computeBurstCeiling([{ name: "Breath Weapon", damage: 40, setupSteps: 0 }]);
    assert.equal(result.ceiling, 40);
    assert.equal(result.included.length, 1);
    assert.equal(result.excluded.length, 0);
  });

  test("computeBurstCeiling: a <=1-free-setup-step component is included at FULL value, not discounted", () => {
    const result = computeBurstCeiling([{ name: "Pounce (needs 1 move first)", damage: 20, setupSteps: 1 }]);
    assert.equal(result.ceiling, 20, "a setupSteps:1 component must count at its full stated damage");
    assert.equal(result.included.length, 1);
  });

  test("THE FANTASY-CEILING GUARD: a component needing 2+ setup steps is EXCLUDED from the ceiling total entirely", () => {
    const result = computeBurstCeiling([
      { name: "Breath Weapon", damage: 40, setupSteps: 0 },
      { name: "Sneak Attack (needs a prior ally hit)", damage: 30, setupSteps: 2 }
    ]);
    assert.equal(result.ceiling, 40, "the 2-setup-step component must NOT contribute to the ceiling at all");
    assert.equal(result.included.length, 1);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].name, "Sneak Attack (needs a prior ally hit)");
  });

  test("computeBurstCeiling: a mix of included and excluded components sums only the included ones", () => {
    const result = computeBurstCeiling([
      { name: "Breath Weapon", damage: 40, setupSteps: 0 },
      { name: "Pounce", damage: 20, setupSteps: 1 },
      { name: "Coordinated Finisher", damage: 50, setupSteps: 3 }
    ]);
    assert.equal(result.ceiling, 60, "40 + 20, excluding the 3-setup-step 50-damage component");
  });

  test("computeBurstCeiling: an empty component list yields a ceiling of 0, not an error", () => {
    const result = computeBurstCeiling([]);
    assert.equal(result.ceiling, 0);
    assert.deepEqual(result.included, []);
    assert.deepEqual(result.excluded, []);
  });

  console.log(`\n${passed} passed`);
})();
