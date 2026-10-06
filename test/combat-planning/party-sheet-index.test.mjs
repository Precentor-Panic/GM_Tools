/**
 * CONTRACT UNDER TEST — combat-planning/party-sheet-index.mjs, the pure
 * projection behind the Run view's party rail (2026-10-06).
 *
 * The assertions that matter most, and why each exists:
 *   - the MULE test pins the deliberate divergence from classifyActor, whose
 *     documented `type === "character"` fallback yields 14 "PCs" in the real
 *     aureus world where there are 7 seats;
 *   - the save-shape test pins the `{roll, value}` unwrap, i.e. the exact bug
 *     that put objects into combatRelevant.saveDCs where its own zod schema
 *     says numbers;
 *   - the all-18-skills test pins nulls-not-zeros for a skill a sheet omits.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PARTY_SHEETS_VERSION, SKILL_KEYS, ABILITY_KEYS,
  partySheetsFromIndex, mapActorToPartySheet, isEmptySheet,
  compactLabel, proficiencyBonusForLevel
} from "../../combat-planning/party-sheet-index.mjs";

const save = (v) => ({ roll: { min: null, max: null, mode: 0 }, value: v });
const sk = (value, proficient, passive) => ({ value, proficient, passive });

function indexFixture() {
  return {
    version: 1,
    worldId: "w",
    exportedAt: "2026-10-01T00:00:00.000Z",
    users: [
      { id: "u1", name: "Ada", characterUuid: "Actor.a" },
      { id: "u2", name: "Bo", characterUuid: "Actor.b" },
      { id: "u3", name: "Cy", characterUuid: "Actor.blank" },
      { id: "u4", name: "GM", characterUuid: null }
    ],
    actors: [
      {
        uuid: "Actor.a", name: "Alpha Keeneye & Friend", type: "character",
        items: [{ type: "class", name: "Fighter" }, { type: "weapon", name: "Axe" }],
        system: {
          level: 5, ac: 16, hp: { value: 20, max: 44 },
          abilities: {
            str: { value: 16, mod: 3, save: save(6) },
            dex: { value: 12, mod: 1, save: save(1) },
            con: { value: 14, mod: 2, save: save(5) },
            int: { value: 8, mod: -1, save: save(-1) },
            wis: { value: 10, mod: 0, save: save(0) },
            cha: { value: 10, mod: 0, save: save(0) }
          },
          skills: { prc: sk(3, 1, 13), ath: sk(6, 1, 16) }
        }
      },
      {
        uuid: "Actor.b", name: "Beta Hawk", type: "character",
        items: [{ type: "class", name: "Rogue" }],
        system: {
          level: 5, ac: 14,
          hp: { value: 18, max: 33 },
          abilities: { dex: { value: 18, mod: 4, save: save(7) } },
          // Expertise on Perception; a legacy BARE-NUMBER save on wis.
          skills: { prc: sk(9, 2, 19), ste: sk(9, 2, 19) },
          saves: { wis: 4 }
        }
      },
      // A claimed seat with nothing filled in.
      { uuid: "Actor.blank", name: "Benchwarmer", type: "character", items: [], system: { level: 0, skills: {}, abilities: {} } },
      // THE MULE: typed character, claimed by no user.
      { uuid: "Actor.mule", name: "Ada's Mule", type: "character", items: [], system: { level: 0 } },
      { uuid: "Actor.goblin", name: "Goblin", type: "npc", system: { ac: 15, hp: { max: 7 } } }
    ]
  };
}

test("only user-claimed actors come through — the mule and the npc are excluded", () => {
  const out = partySheetsFromIndex(indexFixture());
  assert.deepEqual(out.sheets.map((s) => s.name), ["Beta Hawk", "Alpha Keeneye & Friend"]);
  assert.ok(!out.sheets.some((s) => /Mule/.test(s.name)), "a type:character actor nobody claims is NOT a party member");
  assert.ok(!out.sheets.some((s) => s.name === "Goblin"));
});

test("a claimed seat with no sheet is excluded, and reported under `excluded`", () => {
  const out = partySheetsFromIndex(indexFixture());
  assert.ok(!out.sheets.some((s) => s.name === "Benchwarmer"), "not in the rail");
  assert.deepEqual(out.excluded, [{ actorUuid: "Actor.blank", name: "Benchwarmer", reason: "no sheet filled in" }],
    "the omission is inspectable, never silent");
});

test("sorted by passive Perception descending", () => {
  const out = partySheetsFromIndex(indexFixture());
  assert.deepEqual(out.sheets.map((s) => s.passive.prc), [19, 13]);
});

test("a sheet with no passive Perception sorts last, then by name", () => {
  const idx = indexFixture();
  idx.actors.push({
    uuid: "Actor.c", name: "Zeta", type: "character",
    items: [{ type: "class", name: "Bard" }], system: { level: 2, skills: {}, abilities: {} }
  });
  idx.users.push({ id: "u5", name: "Dee", characterUuid: "Actor.c" });
  const out = partySheetsFromIndex(idx);
  assert.equal(out.sheets.at(-1).name, "Zeta");
  assert.equal(out.sheets.at(-1).passive.prc, null);
});

test("all 18 skills are present in SKILL_KEYS order, absent ones null and never zero", () => {
  const out = partySheetsFromIndex(indexFixture());
  const alpha = out.sheets.find((s) => s.name.startsWith("Alpha"));
  assert.equal(alpha.skills.length, 18);
  assert.deepEqual(alpha.skills.map((s) => s.key), [...SKILL_KEYS]);
  const stealth = alpha.skills.find((s) => s.key === "ste");
  assert.equal(stealth.mod, null, "a skill the sheet omits is null, not 0 — 0 would read as a real modifier");
  assert.equal(stealth.passive, null);
  assert.equal(stealth.prof, 0);
});

test("the {roll,value} save object is unwrapped to a number, and a bare number still works", () => {
  const out = partySheetsFromIndex(indexFixture());
  const alpha = out.sheets.find((s) => s.name.startsWith("Alpha"));
  assert.deepEqual(alpha.saves.map((s) => s.key), [...ABILITY_KEYS]);
  assert.equal(alpha.saves.find((s) => s.key === "str").mod, 6, "unwrapped from {roll,value}");
  const beta = out.sheets.find((s) => s.name === "Beta Hawk");
  assert.equal(beta.saves.find((s) => s.key === "dex").mod, 7);
  assert.equal(beta.saves.find((s) => s.key === "wis").mod, 4, "a legacy bare-number save still reads");
  assert.equal(beta.saves.find((s) => s.key === "str").mod, null, "an absent save is null");
});

test("expertise is distinguishable from proficiency", () => {
  const out = partySheetsFromIndex(indexFixture());
  const beta = out.sheets.find((s) => s.name === "Beta Hawk");
  assert.equal(beta.skills.find((s) => s.key === "prc").prof, 2, "expertise kept as 2, not flattened to a boolean");
  const alpha = out.sheets.find((s) => s.name.startsWith("Alpha"));
  assert.equal(alpha.skills.find((s) => s.key === "prc").prof, 1);
});

test("HP max and current are both carried; the rail is the thing that only shows max", () => {
  const out = partySheetsFromIndex(indexFixture());
  const alpha = out.sheets.find((s) => s.name.startsWith("Alpha"));
  assert.equal(alpha.hpMax, 44);
  assert.equal(alpha.hpValue, 20);
});

test("compactLabel trims at the first &, ' and ' or comma", () => {
  assert.equal(compactLabel("Flint CinderLeaf & Comrade Kindle"), "Flint CinderLeaf");
  assert.equal(compactLabel("Rosa and Pip"), "Rosa");
  assert.equal(compactLabel("Vance, the Younger"), "Vance");
  assert.equal(compactLabel("Dio"), "Dio");
  assert.equal(compactLabel(null), "");
});

test("proficiency bonus is derived from level, and is null without one", () => {
  assert.equal(proficiencyBonusForLevel(1), 2);
  assert.equal(proficiencyBonusForLevel(4), 2);
  assert.equal(proficiencyBonusForLevel(5), 3);
  assert.equal(proficiencyBonusForLevel(17), 6);
  assert.equal(proficiencyBonusForLevel(25), 6, "clamped at 20");
  assert.equal(proficiencyBonusForLevel(0), null);
  assert.equal(proficiencyBonusForLevel(undefined), null, "never guessed as +2");
});

test("isEmptySheet needs all three signals absent", () => {
  assert.equal(isEmptySheet({ items: [], system: { level: 0, skills: {} } }), true);
  assert.equal(isEmptySheet({ items: [{ type: "class", name: "Bard" }], system: {} }), false, "has a class");
  assert.equal(isEmptySheet({ items: [], system: { level: 3 } }), false, "has a level");
  assert.equal(isEmptySheet({ items: [], system: { skills: { prc: sk(1, 1, 11) } } }), false, "has a proficiency");
  assert.equal(isEmptySheet(null), true, "a null actor is not a playable seat");
});

test("the roster join supplies curated fields, and a discarded row never wins", () => {
  const out = partySheetsFromIndex(indexFixture(), {
    rosterMembers: [
      { id: "pm-discarded", status: "discarded", foundryActorRef: "Actor.b", conditions: "WRONG" },
      { id: "pm-real", status: "accepted", foundryActorRef: "Actor.b", conditions: "prone" }
    ]
  });
  const beta = out.sheets.find((s) => s.name === "Beta Hawk");
  assert.equal(beta.rosterMemberId, "pm-real");
  assert.equal(beta.conditions, "prone");
  const alpha = out.sheets.find((s) => s.name.startsWith("Alpha"));
  assert.equal(alpha.rosterMemberId, null, "no roster row, no join");
});

test("a claimed actor that no longer exists in the world is skipped, not crashed on", () => {
  const idx = indexFixture();
  idx.users.push({ id: "u9", name: "Gone", characterUuid: "Actor.deleted" });
  const out = partySheetsFromIndex(idx);
  assert.equal(out.sheets.length, 2);
});

test("a duplicate claim on one actor yields one seat", () => {
  const idx = indexFixture();
  idx.users.push({ id: "u8", name: "Second claim", characterUuid: "Actor.a" });
  const out = partySheetsFromIndex(idx);
  assert.equal(out.sheets.filter((s) => s.actorUuid === "Actor.a").length, 1);
});

test("a null, empty or malformed index degrades to empty — never throws", () => {
  for (const bad of [null, undefined, {}, { actors: null, users: null }, { actors: [{}], users: [{}] }]) {
    const out = partySheetsFromIndex(bad);
    assert.deepEqual(out.sheets, [], `expected no sheets for ${JSON.stringify(bad)}`);
    assert.equal(out.version, PARTY_SHEETS_VERSION);
  }
  assert.equal(partySheetsFromIndex(null).exportedAt, null);
});

test("mapActorToPartySheet tolerates a system with nothing in it", () => {
  const row = mapActorToPartySheet({ uuid: "Actor.x", name: "Nobody" }, { userName: "Ada" });
  assert.equal(row.ac, null);
  assert.equal(row.hpMax, null);
  assert.equal(row.level, null);
  assert.equal(row.profBonus, null);
  assert.deepEqual(row.passive, { prc: null, ins: null, inv: null });
  assert.equal(row.skills.length, 18);
  assert.equal(row.saves.length, 6);
  assert.equal(row.userName, "Ada");
});
