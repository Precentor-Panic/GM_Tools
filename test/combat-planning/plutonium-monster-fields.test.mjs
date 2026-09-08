// Mapper tests for combat-planning/plutonium-monster-fields.mjs.
// Records here are SYNTHETIC (invented creatures, invented text) -- the IP
// rule covers fixtures, so never paste real 5etools stat-block text.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRAIT_SUMMARY_MAX_CHARS, MAX_TRAITS,
  parsePlutoniumProvenance, renderMonsterTagText, flattenMonsterEntries,
  firstSentence, capSummary, parseMultiattackCount, rawFieldsFromPlutoniumRecord
} from "../../combat-planning/plutonium-monster-fields.mjs";
import { RawBestiaryFields } from "../../combat-planning/bestiary-ingest.mjs";

const GRIT_WARDEN = {
  name: "Grit Warden",
  source: "SYN",
  page: 12,
  cr: "2",
  type: { type: "humanoid", tags: ["any race"] },
  size: ["M"],
  ac: [{ ac: 15, from: ["{@item scale mail|phb}"] }],
  hp: { average: 33, formula: "6d8 + 6" },
  trait: [
    { name: "Sand-Sure", entries: ["The warden ignores difficult terrain made of sand. It also has advantage on checks to keep its footing."] }
  ],
  action: [
    { name: "Multiattack", entries: ["The warden makes two Hook attacks."] },
    { name: "Hook", entries: ["{@atk mw} {@hit 5} to hit, reach 5 ft., one target. {@h}7 ({@damage 1d8 + 3}) slashing damage."] },
    { name: "Sling", entries: ["{@atk rw} {@hit 3} to hit, range 30/120 ft., one target. {@h}3 ({@damage 1d4 + 1}) bludgeoning damage."] },
    { name: "Dust Gout {@recharge 5}", entries: ["The warden spits grit in a 15-foot cone. Each creature there must succeed on a {@dc 12} Dexterity saving throw or take 9 ({@damage 2d8}) bludgeoning damage and be {@condition blinded} until the end of its next turn."] },
    { name: "Rally (Recharges after a Short or Long Rest)", entries: ["For 1 minute, allies within 30 feet of the warden that can hear it add a {@dice d4} to attack rolls. This ends if the warden is {@condition incapacitated}."] }
  ],
  bonus: [{ name: "Scuttle", entries: ["The warden takes the {@action Disengage} action."] }],
  reaction: [{ name: "Brace", entries: ["The warden adds 2 to its AC against one melee attack that would hit it."] }]
};

test("parsePlutoniumProvenance: with and without a page, null otherwise", () => {
  assert.equal(parsePlutoniumProvenance("MM p347 via Plutonium"), "MM");
  assert.equal(parsePlutoniumProvenance("MM via Plutonium"), "MM");
  assert.equal(parsePlutoniumProvenance("  xphb p12 via plutonium  "), "xphb");
  assert.equal(parsePlutoniumProvenance("hand-authored"), null);
  assert.equal(parsePlutoniumProvenance(null), null);
});

test("renderMonsterTagText renders the bestiary tags to plain text and no {@ survives", () => {
  assert.equal(renderMonsterTagText("{@atk mw} {@hit 5} to hit, reach 5 ft., one target. {@h}7 ({@damage 1d8 + 3}) slashing damage."),
    "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 7 (1d8 + 3) slashing damage.");
  assert.equal(renderMonsterTagText("{@atk mw,rw} {@hit -1} to hit"), "Melee or Ranged Weapon Attack: -1 to hit");
  assert.equal(renderMonsterTagText("{@atkr m} {@hit 4}, reach 5 ft. {@h}5 ({@damage 1d6+2}) piercing damage."),
    "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6+2) piercing damage.");
  assert.equal(renderMonsterTagText("{@actSave dex} {@dc 13}, each creature in a 15-foot cone. {@actSaveFail} 7 ({@damage 2d6}) fire damage. {@actSaveSuccess} Half damage."),
    "Dexterity Saving Throw: DC 13, each creature in a 15-foot cone. Failure: 7 (2d6) fire damage. Success: Half damage.");
  assert.equal(renderMonsterTagText("Dust Gout {@recharge 5}"), "Dust Gout (Recharge 5-6)");
  assert.equal(renderMonsterTagText("Gout {@recharge}"), "Gout (Recharge 6)");
  assert.equal(renderMonsterTagText("{@condition blinded} by {@item scale mail|phb} and {@spell fog cloud|xphb|Fog Cloud}"), "blinded by scale mail and fog cloud");
  assert.equal(renderMonsterTagText("{@actTrigger} A creature hits. {@actResponse d} The warden bites."), "Trigger: A creature hits. Response: The warden bites.");
  for (const s of ["{@hitYourSpellAttack}", "{@actSaveFail 2}", "{@actSaveSuccessOrFail}", "{@chance 50|||x}", "{@unknownTag foo|bar}", "{@hom}"]) {
    assert.ok(!renderMonsterTagText(s).includes("{@"), `leak in ${s}: ${renderMonsterTagText(s)}`);
  }
  assert.equal(renderMonsterTagText(""), "");
  assert.equal(renderMonsterTagText(null), "");
});

test("flattenMonsterEntries descends entries/list/items and prefixes named sub-entries", () => {
  const flat = flattenMonsterEntries([
    "Line one.",
    { type: "entries", name: "Sub", entries: ["Inner text."] },
    { type: "list", items: ["Item A", { type: "item", name: "Item B", entries: ["B text."] }] },
    { type: "table", rows: [["x"]] }
  ]);
  assert.deepEqual(flat, ["Line one.", "Sub. Inner text.", "Item A", "Item B. B text."]);
  assert.deepEqual(flattenMonsterEntries(undefined), []);
});

test("firstSentence / capSummary respect abbreviations and the cap", () => {
  assert.equal(firstSentence("Reach 5 ft., one target. Hit: 7 damage."), "Reach 5 ft., one target.");
  assert.equal(firstSentence("Only one sentence"), "Only one sentence");
  const long = "word ".repeat(60).trim();
  const capped = capSummary(long);
  assert.ok(capped.length <= TRAIT_SUMMARY_MAX_CHARS);
  assert.ok(capped.endsWith("…"));
  assert.equal(capSummary("short"), "short");
});

test("parseMultiattackCount reads word and digit counts", () => {
  assert.equal(parseMultiattackCount("The warden makes two Hook attacks."), 2);
  assert.equal(parseMultiattackCount("The thing makes three attacks: one with its bite and two with its claws."), 3);
  assert.equal(parseMultiattackCount("The brute attacks twice."), 2);
  assert.equal(parseMultiattackCount("It makes 4 Claw attacks."), 4);
  assert.equal(parseMultiattackCount("It uses Frighten if it can."), null);
});

test("rawFieldsFromPlutoniumRecord maps a full record into the ingest vocabulary and validates", () => {
  const rf = rawFieldsFromPlutoniumRecord(GRIT_WARDEN);
  assert.equal(rf.name, "Grit Warden");
  assert.equal(rf.type, "humanoid (any race)");
  assert.equal(rf.ac, 15);
  assert.equal(rf.hp, 33);
  assert.equal(rf.challengeRating, "2");
  assert.equal(rf.size, "M");
  assert.deepEqual(rf.attacks.map((a) => [a.name, a.toHitBonus, a.damageDice, a.damageType]), [
    ["Hook", 5, "1d8+3", "slashing"],
    ["Sling", 3, "1d4+1", "bludgeoning"]
  ]);
  assert.equal(rf.attacks[0].summary, "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 7 (1d8 + 3) slashing damage.");
  assert.deepEqual(rf.multiattack, { count: 2, attackNames: ["Hook"] });
  assert.equal(rf.rechargeAbilities.length, 1);
  assert.equal(rf.rechargeAbilities[0].name, "Dust Gout");
  assert.equal(rf.rechargeAbilities[0].rechargeOn, "5-6");
  assert.equal(rf.rechargeAbilities[0].damageDice, "2d8");
  assert.ok(rf.rechargeAbilities[0].summary.startsWith("The warden spits grit"));
  assert.deepEqual(rf.traits.map((t) => [t.name, t.kind]), [
    ["Sand-Sure", "trait"],
    ["Rally (Recharges after a Short or Long Rest)", "action"],
    ["Scuttle", "bonus"],
    ["Brace", "reaction"]
  ]);
  assert.equal(rf.traits[0].summary, "The warden ignores difficult terrain made of sand.");
  assert.equal(rf.traits[2].summary, "The warden takes the Disengage action.");
  assert.equal(rf.legendaryActions, undefined);
  assert.equal(rf.legendary, undefined);
  assert.ok(!JSON.stringify(rf).includes("{@"));
  // The shelf's own zod shape accepts the result (traits/summary are additive fields).
  const parsed = RawBestiaryFields.parse(rf);
  assert.equal(parsed.traits.length, 4);
  assert.equal(parsed.attacks[0].summary, rf.attacks[0].summary);
});

test("rawFieldsFromPlutoniumRecord: legendary block, numeric legendaryActions, spellcasting, trait cap, flat damage", () => {
  const rec = {
    name: "Synthetic Tyrant", source: "SYN", cr: "10", type: "aberration", size: ["L"], ac: [17], hp: { average: 120 },
    legendaryActions: 2,
    legendary: [{ name: "Glance", entries: ["The tyrant looks at one creature."] }, { name: "Slam (Costs 2 Actions)", entries: ["The tyrant slams."] }],
    spellcasting: [{ name: "Innate Spellcasting", headerEntries: ["The tyrant's innate spellcasting ability is Charisma (spell save {@dc 16}). It can innately cast the following spells:"], will: ["{@spell detect magic}"] }],
    action: [{ name: "Pebble", entries: ["{@atk rw} {@hit 6} to hit, range 20 ft., one target. {@h}1 bludgeoning damage."] }],
    trait: Array.from({ length: 20 }, (_, i) => ({ name: `Quirk ${i + 1}`, entries: [`Quirk number ${i + 1}.`] }))
  };
  const rf = rawFieldsFromPlutoniumRecord(rec);
  assert.deepEqual(rf.legendaryActions, { count: 2 });
  assert.equal(rf.legendary, true);
  assert.deepEqual(rf.attacks, [{ name: "Pebble", toHitBonus: 6, damageDice: "1", damageType: "bludgeoning", summary: "Ranged Weapon Attack: +6 to hit, range 20 ft., one target. Hit: 1 bludgeoning damage." }]);
  assert.equal(rf.traits.length, MAX_TRAITS);
  assert.ok(rf.traits.every((t) => t.kind === "trait"), "the cap truncates in emission order, so the 20 traits crowd out later kinds");
  const uncapped = rawFieldsFromPlutoniumRecord({ ...rec, trait: rec.trait.slice(0, 2) });
  assert.deepEqual(uncapped.traits.map((t) => t.kind), ["trait", "trait", "legendary", "legendary", "spellcasting"]);
  const sc = uncapped.traits.find((t) => t.kind === "spellcasting");
  assert.equal(sc.name, "Innate Spellcasting");
  assert.ok(sc.summary.includes("DC 16"));
  assert.ok(sc.summary.length <= TRAIT_SUMMARY_MAX_CHARS);
  RawBestiaryFields.parse(uncapped);
});

test("rawFieldsFromPlutoniumRecord omits empty keys and throws on a _copy shell", () => {
  const rf = rawFieldsFromPlutoniumRecord({ name: "Plain Lump", source: "SYN", cr: "0", type: "ooze", ac: [8], hp: { average: 5 } });
  assert.deepEqual(rf, { name: "Plain Lump", type: "ooze", ac: 8, hp: 5, challengeRating: "0" });
  assert.throws(() => rawFieldsFromPlutoniumRecord({ name: "Reprint", source: "SYN", _copy: { name: "Plain Lump", source: "SYN" } }), /reprint shell/);
  assert.throws(() => rawFieldsFromPlutoniumRecord(null), /not a usable/);
});
