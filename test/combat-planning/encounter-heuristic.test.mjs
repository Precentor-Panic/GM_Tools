import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * CONTRACT UNDER TEST — combat-planning/encounter-heuristic.mjs (Phase 18
 * task 18.5). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-18-tasks.md task 18.0. It is expected to fail
 * with "Cannot find module" until 18.5 lands.
 *
 * NO LLM CALL, NO IMPORT OF mutation-engine/llm-call.mjs (task 18.5's own
 * acceptance criterion: "a direct import-graph check (or simple grep,
 * documented in a comment) confirms encounter-heuristic.mjs has no
 * dependency on mutation-engine/llm-call.mjs"). The candidate pool this
 * module consumes is expected to ALREADY be thematically filtered before it
 * arrives here -- that filtering is combat-planning/thematic-filter.mjs's
 * job (its own, separate test file), a genuinely different module so the
 * deterministic core here stays LLM-free and independently testable without
 * mocking any client at all.
 *
 * Ties together 18.1-18.4: given a target difficulty and an
 * already-thematically-filtered candidate monster pool, suggests specific
 * combinations/quantities using the deterministic scoring from action-economy.mjs/
 * effect-impact.mjs (18.3) and burst-ceiling.mjs/snowball-delta.mjs/
 * pack-coefficient.mjs (18.4). Exposes the design record §2's knobs as plain
 * parameters, all deterministic, all instant.
 *
 * ASYMMETRIC-RISK FLAG NEVER BLENDED INTO expectedScore (task 18.0's own
 * hard requirement, design record §2's explicit "never blended into the
 * primary score" instruction): the returned expectedScore must be BIT-FOR-BIT
 * IDENTICAL whether or not the burst-ceiling threshold fires -- only a
 * separate `asymmetricRiskFlag` boolean field changes. A test below proves
 * this with two calls differing ONLY in the threshold knob.
 *
 * ---------------------------------------------------------------------------
 * suggestEncounter({ targetDifficulty, candidatePool, party, knobs })
 * ---------------------------------------------------------------------------
 * @param {object} args
 * @param {number} args.targetDifficulty        a caller-chosen difficulty target (arbitrary scale, same scale as the scoring functions' own output)
 * @param {Array<object>} args.candidatePool     bestiary entries (combat-planning/bestiary-store.mjs's BestiaryEntry shape, or at minimum {rawFields, derivedScore}) -- ALREADY thematically filtered
 * @param {Array<object>} args.party             combat-planning/party-roster-store.mjs's PartyMember.combatRelevant-shaped entries (or the full PartyMember; only combatRelevant fields are read)
 * @param {object} [args.knobs]
 * @param {boolean} [args.knobs.minionRules=false]
 * @param {boolean} [args.knobs.legendaryActions=true]
 * @param {number} [args.knobs.scalingSlider=1]              a multiplier on the target difficulty band
 * @param {number} [args.knobs.playerTacticsSlider=0.5]      0 = chaotic-spread, 1 = optimal-focus-fire, 0.5 = average (the tactical-DM review's top-requested lever, design record §2)
 * @param {number} [args.knobs.burstCeilingThresholdPct=0.5] fraction of party effective HP the burst ceiling must exceed to trip asymmetricRiskFlag -- lowering this makes the flag MORE likely to fire WITHOUT changing any damage/score input at all (this is exactly the lever the flag-independence test below uses)
 * @returns {{
 *   combination: Array<{entryId:string, count:number}>,
 *   expectedScore: number,
 *   burstCeiling: number,
 *   snowballDelta: {topDamageContributorId:string, topDamageContributorDelta:number, topEffectiveHpContributorId:string, topEffectiveHpContributorDelta:number},
 *   asymmetricRiskFlag: boolean
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

const CANDIDATE_POOL = [
  {
    entryId: "wolf-1",
    rawFields: {
      name: "Wolf",
      hp: 11,
      ac: 13,
      attacks: [{ name: "Bite", damageDice: "2d4+2" }]
    },
    derivedScore: { actionEconomyScore: 7 }
  },
  {
    entryId: "ogre-1",
    rawFields: {
      name: "Ogre",
      hp: 59,
      ac: 11,
      attacks: [{ name: "Greatclub", damageDice: "2d8+4" }],
      rechargeAbilities: [{ name: "Reckless Slam", rechargeOn: "5-6", damageDice: "6d8" }]
    },
    derivedScore: { actionEconomyScore: 22 }
  }
];

const PARTY = [
  { id: "pc-1", combatRelevant: { ac: 15, hp: 30, damagePerRoundEstimate: 12 } },
  { id: "pc-2", combatRelevant: { ac: 16, hp: 40, damagePerRoundEstimate: 8 } }
];

(async () => {
  const { suggestEncounter } = await import("../../combat-planning/encounter-heuristic.mjs");

  test("no dependency on mutation-engine/llm-call.mjs -- confirmed by reading the module's own source, matching scenes.mjs's no-Foundry-import test convention", () => {
    const src = readFileSync(new URL("../../combat-planning/encounter-heuristic.mjs", import.meta.url), "utf8");
    assert.ok(!/llm-call/.test(src), "encounter-heuristic.mjs must never import from mutation-engine/llm-call.mjs");
    assert.ok(!/Anthropic/.test(src), "encounter-heuristic.mjs must never reference the Anthropic SDK directly either");
  });

  test("suggestEncounter: returns a combination, an expectedScore, a burstCeiling, a snowballDelta with two candidate deltas, and an asymmetricRiskFlag", () => {
    const result = suggestEncounter({
      targetDifficulty: 20,
      candidatePool: CANDIDATE_POOL,
      party: PARTY,
      knobs: {}
    });
    assert.ok(Array.isArray(result.combination) && result.combination.length > 0);
    assert.equal(typeof result.expectedScore, "number");
    assert.equal(typeof result.burstCeiling, "number");
    assert.equal(typeof result.asymmetricRiskFlag, "boolean");
    assert.ok("topDamageContributorId" in result.snowballDelta);
    assert.ok("topEffectiveHpContributorId" in result.snowballDelta);
  });

  test("THE ASYMMETRIC-RISK-FLAG-NEVER-BLENDS TEST: expectedScore is BIT-FOR-BIT IDENTICAL whether or not the burst-ceiling threshold fires -- only the flag changes", () => {
    const baseArgs = { targetDifficulty: 20, candidatePool: CANDIDATE_POOL, party: PARTY };

    // Same candidate pool, same party, same target difficulty -- the ONLY
    // thing that differs between these two calls is the threshold knob
    // controlling when the SEPARATE flag trips. If expectedScore moved at
    // all, that would prove the risk bias leaked into the primary score.
    const flagLikelyOff = suggestEncounter({ ...baseArgs, knobs: { burstCeilingThresholdPct: 5.0 } });
    const flagLikelyOn = suggestEncounter({ ...baseArgs, knobs: { burstCeilingThresholdPct: 0.01 } });

    assert.equal(
      flagLikelyOff.expectedScore,
      flagLikelyOn.expectedScore,
      "expectedScore must be identical regardless of the burst-ceiling threshold knob -- only asymmetricRiskFlag may differ"
    );
    assert.equal(flagLikelyOff.burstCeiling, flagLikelyOn.burstCeiling, "the ceiling ITSELF is also threshold-independent -- only whether it TRIPS the flag differs");
    assert.notEqual(
      flagLikelyOff.asymmetricRiskFlag,
      flagLikelyOn.asymmetricRiskFlag,
      "the two threshold extremes in this fixture must actually produce different flag outcomes, or this test isn't proving anything"
    );
  });

  test("suggestEncounter: the playerTacticsSlider knob is accepted without throwing (0 = chaotic-spread, 1 = optimal-focus-fire)", () => {
    const chaotic = suggestEncounter({ targetDifficulty: 20, candidatePool: CANDIDATE_POOL, party: PARTY, knobs: { playerTacticsSlider: 0 } });
    const optimal = suggestEncounter({ targetDifficulty: 20, candidatePool: CANDIDATE_POOL, party: PARTY, knobs: { playerTacticsSlider: 1 } });
    assert.equal(typeof chaotic.expectedScore, "number");
    assert.equal(typeof optimal.expectedScore, "number");
  });

  test("suggestEncounter: is deterministic -- calling twice with identical inputs produces identical output (no simulation, no randomness anywhere per §7's explicit deferral)", () => {
    const args = { targetDifficulty: 20, candidatePool: CANDIDATE_POOL, party: PARTY, knobs: {} };
    const a = suggestEncounter(args);
    const b = suggestEncounter(args);
    assert.deepEqual(a, b);
  });

  console.log(`\n${passed} passed`);
})();
