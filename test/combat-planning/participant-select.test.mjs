import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * CONTRACT UNDER TEST — combat-planning/participant-select.mjs (WS-4,
 * opforce-plan-2026-09-12.md §3). PURE, no I/O, no LLM call -- this file
 * greps the module's own source directly, matching encounter-heuristic.
 * mjs's/its own test file's established no-llm-call convention.
 *
 * All fixture names below are INVENTED (no campaign names) per WS-4's own
 * hard rule.
 */

const { selectParticipants, classifyArchetype } = await import("../../combat-planning/participant-select.mjs");

test("no dependency on mutation-engine/llm-call.mjs or the Anthropic SDK", () => {
  const src = readFileSync(new URL("../../combat-planning/participant-select.mjs", import.meta.url), "utf8");
  assert.ok(!/llm-call/.test(src), "participant-select.mjs must never import from mutation-engine/llm-call.mjs");
  assert.ok(!/Anthropic/.test(src), "participant-select.mjs must never reference the Anthropic SDK directly either");
});

// An invented 4-PC party -- no campaign names.
const PARTY = [
  { id: "pc-1", combatRelevant: { class: "Fighter", ac: 17, hp: 44, damagePerRoundEstimate: 14 } },
  { id: "pc-2", combatRelevant: { class: "Rogue", ac: 15, hp: 30, damagePerRoundEstimate: 18 } },
  { id: "pc-3", combatRelevant: { class: "Cleric", ac: 16, hp: 36, damagePerRoundEstimate: 9 } },
  { id: "pc-4", combatRelevant: { class: "Wizard", ac: 13, hp: 26, damagePerRoundEstimate: 12 } }
];

function entry(entryId, name, hp, ac, attacks, challengeRating, extra = {}) {
  return { entryId, rawFields: { name, hp, ac, attacks, challengeRating, type: "humanoid", ...extra }, derivedScore: null };
}

// ~15 invented bestiary entries, including several ATTACKLESS ones (the
// 26/82-attackless-real-entries scenario WS-4's defect fix (c) targets).
const POOL = [
  entry("gob-1", "Sprocket Goblin", 7, 13, [{ name: "Scimitar", damageDice: "1d6+1" }], "1/4"),
  entry("gob-2", "Sprocket Goblin Archer", 7, 13, [{ name: "Shortbow", damageDice: "1d6+1" }], "1/4"),
  entry("wolf-1", "Ashen Wolf", 11, 13, [{ name: "Bite", damageDice: "2d4+2" }], "1/4", {
    traits: [{ name: "Pack Tactics" }]
  }),
  entry("orc-1", "Rustplate Orc", 15, 13, [{ name: "Axe", damageDice: "1d12+3" }], "1/2"),
  entry("ogre-1", "Bog Ogre", 59, 11, [{ name: "Greatclub", damageDice: "2d8+4" }], "2"),
  entry("bear-1", "Cinder Bear", 42, 13, [{ name: "Claw", damageDice: "2d6+4" }], "2"),
  entry("troll-1", "Marsh Troll", 84, 15, [{ name: "Claw", damageDice: "2d6+4" }], "5"),
  entry("wraith-1", "Hollow Wraith", 67, 13, [{ name: "Life Drain", damageDice: "4d8+3" }], "5"),
  entry("dragon-1", "Statless Wyrm", 256, 19, [], "17"), // attackless
  entry("golem-1", "Nameless Golem", 178, 17, [], "10"), // attackless
  entry("hag-1", "Fen Hag", 82, 17, [{ name: "Claws", damageDice: "2d8+4" }], "5"),
  entry("giant-1", "Frost Giant", 138, 15, [{ name: "Greataxe", damageDice: "3d12+7" }], "8"),
  entry("spider-1", "Cave Spider Swarm", 22, 12, [{ name: "Bite", damageDice: "1d6+1" }], "1"),
  entry("skeleton-1", "Rattling Skeleton", 13, 13, [{ name: "Shortsword", damageDice: "1d6+1" }], "1/4"),
  entry("lich-1", "Statless Lich", 135, 17, [], "21") // attackless
];

// A "hard" target for this invented 4-PC party on encounter-heuristic.mjs's
// own arbitrary scale (not literal D&D XP -- see participant-select.mjs's
// own header comment on `xpBudget`).
const HARD_TARGET = 60;

test("classifyArchetype: pure function of shape alone", () => {
  assert.equal(classifyArchetype([{ entryId: "a", count: 1 }]), "solo");
  assert.equal(classifyArchetype([{ entryId: "a", count: 2 }]), "duo");
  assert.equal(classifyArchetype([{ entryId: "a", count: 1 }, { entryId: "b", count: 1 }]), "duo");
  assert.equal(classifyArchetype([{ entryId: "a", count: 3 }]), "swarm");
  assert.equal(classifyArchetype([{ entryId: "a", count: 1 }, { entryId: "b", count: 2 }]), "mixed");
});

test("selectParticipants: returns k (3) DIVERSE archetypes at 'hard' for the fixture party/pool, each with units/score/xpBudget/notes", () => {
  const result = selectParticipants({ party: PARTY, candidatePool: POOL, targetDifficulty: HARD_TARGET, knobs: {}, k: 3 });
  assert.equal(result.length, 3);
  const archetypes = result.map((c) => c.archetype);
  assert.equal(new Set(archetypes).size, 3, `at k<=4 every composition must be a DIFFERENT archetype, got ${archetypes}`);
  for (const composition of result) {
    assert.ok(["solo", "duo", "swarm", "mixed"].includes(composition.archetype));
    assert.ok(Array.isArray(composition.units) && composition.units.length > 0);
    for (const unit of composition.units) {
      assert.equal(typeof unit.entryId, "string");
      assert.ok(Number.isInteger(unit.count) && unit.count > 0);
    }
    assert.equal(typeof composition.score, "number");
    assert.equal(composition.xpBudget, HARD_TARGET);
    assert.ok(Array.isArray(composition.notes) && composition.notes.length > 0);
  }
});

test("selectParticipants: is deterministic -- identical inputs produce byte-identical output", () => {
  const args = { party: PARTY, candidatePool: POOL, targetDifficulty: HARD_TARGET, knobs: {}, k: 3 };
  const a = selectParticipants(args);
  const b = selectParticipants(args);
  assert.deepEqual(a, b);
});

test("selectParticipants: respects knobs.maxMonsters -- no returned composition's total unit count ever exceeds it", () => {
  const result = selectParticipants({ party: PARTY, candidatePool: POOL, targetDifficulty: 200, knobs: { maxMonsters: 3 }, k: 4 });
  assert.ok(result.length > 0);
  for (const composition of result) {
    const total = composition.units.reduce((sum, u) => sum + u.count, 0);
    assert.ok(total <= 3, `composition exceeded maxMonsters:3 (got ${total}): ${JSON.stringify(composition)}`);
  }
});

test("selectParticipants: knobs.allowSolo:false never returns a solo composition", () => {
  const result = selectParticipants({ party: PARTY, candidatePool: POOL, targetDifficulty: HARD_TARGET, knobs: { allowSolo: false }, k: 4 });
  assert.ok(result.length > 0);
  assert.ok(result.every((c) => c.archetype !== "solo"));
});

test("selectParticipants: k > 4 (the archetype count) still returns exactly k compositions, cycling through archetypes again", () => {
  const result = selectParticipants({ party: PARTY, candidatePool: POOL, targetDifficulty: HARD_TARGET, knobs: {}, k: 6 });
  assert.equal(result.length, 6);
  // Every returned composition must be a genuinely distinct combination --
  // no duplicate units[] shape, even once archetypes repeat.
  const keys = result.map((c) => c.units.map((u) => `${u.entryId}x${u.count}`).sort().join("|"));
  assert.equal(new Set(keys).size, keys.length, "no two returned compositions may be the identical combination");
});

test("selectParticipants: an attackless (CR-derived) entry IS selectable and is annotated in notes", () => {
  const onlyAttackless = [entry("dragon-solo", "Statless Wyrm", 256, 19, [], "17")];
  const result = selectParticipants({ party: PARTY, candidatePool: onlyAttackless, targetDifficulty: HARD_TARGET, knobs: {}, k: 1 });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].units, [{ entryId: "dragon-solo", count: 1 }]);
  assert.ok(result[0].notes.some((n) => /CR-derived/i.test(n)), `expected a CR-derived note, got ${JSON.stringify(result[0].notes)}`);
});

test("selectParticipants: tags prefilter (filterByTagsAnd, AND semantics) excludes non-matching candidates deterministically", () => {
  const tagged = [
    { ...entry("undead-1", "Grave Wight", 45, 14, [{ name: "Claw", damageDice: "1d6+2" }], "3"), tags: ["undead"] },
    { ...entry("beast-1", "Moor Boar", 11, 11, [{ name: "Tusk", damageDice: "1d6+1" }], "1/4"), tags: ["beast"] }
  ];
  const result = selectParticipants({ party: PARTY, candidatePool: tagged, targetDifficulty: 10, tags: ["undead"], knobs: {}, k: 4 });
  assert.ok(result.length > 0);
  for (const composition of result) {
    assert.ok(composition.units.every((u) => u.entryId === "undead-1"), "only the tag-matching entry may appear in any returned composition");
  }
});

test("selectParticipants: an empty candidatePool (e.g. every entry filtered out by tags) returns [] rather than throwing", () => {
  assert.deepEqual(selectParticipants({ party: PARTY, candidatePool: POOL, targetDifficulty: HARD_TARGET, tags: ["no-such-tag"], knobs: {}, k: 3 }), []);
});
