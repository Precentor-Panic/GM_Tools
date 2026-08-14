import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/snowball-delta.mjs (Phase 18 task
 * 18.4). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.4 lands.
 *
 * PURE function, zero I/O, zero LLM calls. Design record §2: "the same
 * scoring function run twice -- once with the full party, once with a
 * single PC removed -- reporting the swing. Run against TWO candidates, not
 * one 'most critical' PC: the top damage contributor... and the top
 * effective-HP/mitigation contributor... a single 'most critical' pick
 * answers the wrong question for half of all encounter types." THIS IS A
 * HARD REQUIREMENT (task 18.0): the function must return TWO deltas, never
 * collapse to a single "most critical" figure.
 *
 * Deliberately takes the scoring function as an INJECTED PARAMETER
 * (`computeEncounterScore`) rather than importing combat-planning/
 * encounter-heuristic.mjs or effect-impact.mjs itself -- keeps this module
 * genuinely pure/standalone and independently testable with a trivial stub
 * scoring function, matching mutation-engine/propagate.mjs's "plain
 * functions over data" convention. The REAL encounter-heuristic orchestrator
 * (18.5) is the one that supplies a real scoring function when it calls this.
 *
 * ---------------------------------------------------------------------------
 * computeSnowballDelta(partyMembers, computeEncounterScore)
 * ---------------------------------------------------------------------------
 * @param {Array<{id:string, damagePerRoundEstimate:number, effectiveHp:number}>} partyMembers
 *   at least 2 members required (a delta against an empty remaining party is
 *   degenerate and not this module's concern to special-case beyond not
 *   crashing).
 * @param {(party: Array) => number} computeEncounterScore
 *   given a party array (a SUBSET of partyMembers), returns a single
 *   numeric encounter-difficulty score. Called exactly twice per candidate
 *   (full party, party minus that one candidate) -- FOUR total calls for
 *   the two candidates unless the same member happens to be both the top
 *   damage AND top effective-HP contributor, in which case that candidate's
 *   pair of calls may be reused/deduped (an implementation detail; the
 *   RETURNED deltas must still both be present and correct either way).
 * @returns {{
 *   topDamageContributorId: string,
 *   topDamageContributorDelta: number,        // computeEncounterScore(full) - computeEncounterScore(full minus top-damage member)
 *   topEffectiveHpContributorId: string,
 *   topEffectiveHpContributorDelta: number    // computeEncounterScore(full) - computeEncounterScore(full minus top-eHP member)
 * }}
 *   Candidate selection: topDamageContributorId is the partyMembers entry
 *   with the highest damagePerRoundEstimate; topEffectiveHpContributorId is
 *   the entry with the highest effectiveHp. These may be the SAME member
 *   (in which case both delta fields are still independently present, even
 *   if numerically identical) or DIFFERENT members.
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

// FIXTURE ARITHMETIC MATTERS (Friction Wave 1 final-sweep fix of a
// pre-existing failure): stubScore below is LINEAR (2*damage + eHP), so
// removing a member changes the score by exactly that member's own weighted
// contribution. The original fixture had burst-mage at {40 dmg, 30 eHP} and
// tank at {10 dmg, 90 eHP} -- 2*40+30 = 2*10+90 = 110, so the "genuinely
// DIFFERENT numbers" test below failed BY CONSTRUCTION (the module was
// correct; the fixture accidentally engineered the exact coincidence the
// assertion forbids). burst-mage's eHP is 20 here so the two deltas are
// 100 vs 110; candidate identities are unchanged (burst-mage still top
// damage 40>15>10, tank still top eHP 90>50>20).
const PARTY = [
  { id: "burst-mage", damagePerRoundEstimate: 40, effectiveHp: 20 },
  { id: "tank", damagePerRoundEstimate: 10, effectiveHp: 90 },
  { id: "support", damagePerRoundEstimate: 15, effectiveHp: 50 }
];

// A stub scoring function whose result depends on who's IN the party, so
// removing different members produces genuinely different scores -- proves
// the two deltas are independently computed, not the same number twice.
function stubScore(party) {
  const totalDamage = party.reduce((sum, m) => sum + m.damagePerRoundEstimate, 0);
  const totalEHp = party.reduce((sum, m) => sum + m.effectiveHp, 0);
  return totalDamage * 2 + totalEHp; // arbitrary but deterministic, weights damage more than eHP
}

(async () => {
  const { computeSnowballDelta } = await import("../../combat-planning/snowball-delta.mjs");

  test("THE TWO-CANDIDATE TEST: returns TWO distinct delta fields, not a single 'most critical' figure", () => {
    const result = computeSnowballDelta(PARTY, stubScore);
    assert.ok("topDamageContributorId" in result);
    assert.ok("topDamageContributorDelta" in result);
    assert.ok("topEffectiveHpContributorId" in result);
    assert.ok("topEffectiveHpContributorDelta" in result);
  });

  test("identifies the correct top-damage contributor (burst-mage, damagePerRoundEstimate:40)", () => {
    const result = computeSnowballDelta(PARTY, stubScore);
    assert.equal(result.topDamageContributorId, "burst-mage");
  });

  test("identifies the correct top-effective-HP contributor (tank, effectiveHp:90) -- a DIFFERENT member from the top-damage one", () => {
    const result = computeSnowballDelta(PARTY, stubScore);
    assert.equal(result.topEffectiveHpContributorId, "tank");
    assert.notEqual(
      result.topEffectiveHpContributorId,
      result.topDamageContributorId,
      "this fixture is deliberately constructed so the two candidates differ -- a single-figure implementation would silently collapse this"
    );
  });

  test("the two deltas are genuinely DIFFERENT numbers for this fixture (removing burst-mage vs. removing tank changes the stub score by different amounts)", () => {
    const result = computeSnowballDelta(PARTY, stubScore);
    assert.notEqual(
      result.topDamageContributorDelta,
      result.topEffectiveHpContributorDelta,
      "removing a 40-damage/30-eHP member vs. a 10-damage/90-eHP member must not coincidentally yield the same delta under stubScore's weighting"
    );
  });

  test("delta values are correct against the stub scoring function directly", () => {
    const result = computeSnowballDelta(PARTY, stubScore);
    const full = stubScore(PARTY);
    const withoutBurstMage = stubScore(PARTY.filter((m) => m.id !== "burst-mage"));
    const withoutTank = stubScore(PARTY.filter((m) => m.id !== "tank"));
    assert.equal(result.topDamageContributorDelta, full - withoutBurstMage);
    assert.equal(result.topEffectiveHpContributorDelta, full - withoutTank);
  });

  test("degenerate case: the same member is BOTH top-damage and top-eHP contributor -- both fields still independently present", () => {
    const soloStandout = [
      { id: "everything", damagePerRoundEstimate: 50, effectiveHp: 100 },
      { id: "minor", damagePerRoundEstimate: 5, effectiveHp: 10 }
    ];
    const result = computeSnowballDelta(soloStandout, stubScore);
    assert.equal(result.topDamageContributorId, "everything");
    assert.equal(result.topEffectiveHpContributorId, "everything");
    assert.equal(result.topDamageContributorDelta, result.topEffectiveHpContributorDelta);
  });

  console.log(`\n${passed} passed`);
})();
