import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — combat-planning/foundry-actor-mapper.mjs (Phase 32
 * task 32.2, the phase's PRIMARY deliverable). classifyActor/
 * mapActorToBestiary/mapActorToPartyMember are PURE (plain-object in, plain-
 * object out, no store/fs access) -- driven entirely by the 32.0 fixtures
 * (wf-mcp-server/test/fixtures/foundry-bridge/), no live Foundry needed.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "wf-mcp-server", "test", "fixtures", "foundry-bridge");

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

const { classifyActor, mapActorToBestiary, mapActorToPartyMember, mapActorItemsToInventory, stripHtml } =
  await import("../../combat-planning/foundry-actor-mapper.mjs");

const sample = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.sample.json"), "utf8"));
const minimal = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.minimal.json"), "utf8"));

const goblinBoss = sample.actors.find((a) => a.uuid === "Actor.gob001boss");
const goblinGrunt = sample.actors.find((a) => a.uuid === "Actor.gob002grunt");
const elowen = sample.actors.find((a) => a.uuid === "Actor.pc001elowen");
const sparseSpirit = minimal.actors[0];

// --------------------------------------------------------------- classifyActor

test("classifyActor: an actor referenced by users[].characterUuid is 'pc' (the authoritative signal)", () => {
  assert.equal(classifyActor(elowen, sample.users), "pc");
});

test("classifyActor: an npc-typed actor NOT referenced by any user is 'monster'", () => {
  assert.equal(classifyActor(goblinBoss, sample.users), "monster");
  assert.equal(classifyActor(goblinGrunt, sample.users), "monster");
});

test("classifyActor: falls back to type==='character' only when no user claims the actor", () => {
  assert.equal(classifyActor(elowen, []), "pc", "no users at all -- falls back to type");
  assert.equal(classifyActor(elowen, [{ characterUuid: null }]), "pc", "a user with no assigned character -- still falls back to type");
});

test("classifyActor: type='npc' with an empty/absent users array is 'monster' (minimal fixture, no users at all)", () => {
  assert.equal(classifyActor(sparseSpirit, minimal.users), "monster");
  assert.equal(classifyActor(sparseSpirit, undefined), "monster");
});

test("classifyActor: never throws on a malformed actor/users shape", () => {
  assert.doesNotThrow(() => classifyActor(null, sample.users));
  assert.doesNotThrow(() => classifyActor({}, null));
  assert.doesNotThrow(() => classifyActor({ uuid: "Actor.x" }, [{ characterUuid: undefined }]));
});

// --------------------------------------------------------------- mapActorToBestiary (monsters)

test("mapActorToBestiary: Goblin Boss -- hp/ac/cr pulled straight from system, name/type from the envelope", () => {
  const raw = mapActorToBestiary(goblinBoss);
  assert.equal(raw.name, "Goblin Boss");
  assert.equal(raw.type, "npc");
  assert.equal(raw.hp, 21);
  assert.equal(raw.ac, 17);
  assert.equal(raw.challengeRating, 1);
});

test("mapActorToBestiary: Goblin (fractional CR as a string) -- cr passed through as-is, not coerced to a number", () => {
  const raw = mapActorToBestiary(goblinGrunt);
  assert.equal(raw.hp, 7);
  assert.equal(raw.ac, 15);
  assert.equal(raw.challengeRating, "1/4");
});

test("mapActorToBestiary: attacks[] derived from weapon-type items (damage dice + type + toHitBonus)", () => {
  const raw = mapActorToBestiary(goblinBoss);
  assert.equal(raw.attacks.length, 1);
  assert.deepEqual(raw.attacks[0], { name: "Scimitar", toHitBonus: 4, damageDice: "1d6 + 2", damageType: "slashing" });
});

test("mapActorToBestiary: multiattack derived from a feat item literally named 'Multiattack', count parsed from its description text", () => {
  const raw = mapActorToBestiary(goblinBoss);
  assert.ok(raw.multiattack);
  assert.equal(raw.multiattack.count, 2, "'makes two scimitar attacks' -- the word 'two' parses to 2");
  assert.deepEqual(raw.multiattack.attackNames, ["Scimitar"], "the description mentions the derived Scimitar attack by name");
});

test("mapActorToBestiary: no Multiattack feat item -- multiattack is omitted (undefined), not fabricated", () => {
  const raw = mapActorToBestiary(goblinGrunt);
  assert.equal(raw.multiattack, undefined);
});

test("mapActorToBestiary: rechargeAbilities derived from a feat item's system.recharge sub-field", () => {
  const raw = mapActorToBestiary(goblinBoss);
  assert.equal(raw.rechargeAbilities.length, 1);
  assert.equal(raw.rechargeAbilities[0].name, "Redcap Fury");
  assert.equal(raw.rechargeAbilities[0].rechargeOn, "5+");
});

test("mapActorToBestiary: appliedEffects + auraEffects derived from actor.effects[] (name pass-through, aura = name mentions 'aura')", () => {
  const raw = mapActorToBestiary(goblinBoss);
  assert.deepEqual(raw.appliedEffects, ["Frightful Presence Aura"]);
  assert.deepEqual(raw.auraEffects, ["Frightful Presence Aura"]);
});

test("mapActorToBestiary: an actor with zero effects[] gets undefined appliedEffects/auraEffects, not an empty-but-present array", () => {
  const raw = mapActorToBestiary(goblinGrunt);
  assert.equal(raw.appliedEffects, undefined);
  assert.equal(raw.auraEffects, undefined);
});

test("mapActorToBestiary: legendaryActions/lairEffects are omitted (undefined) when no items carry that activation type -- a real, documented gap the fixtures don't exercise", () => {
  const raw = mapActorToBestiary(goblinBoss);
  assert.equal(raw.legendaryActions, undefined);
  assert.equal(raw.lairEffects, undefined);
});

test("mapActorToBestiary: NEVER THROWS on the minimal fixture's sparse actor -- null system.ac stays null (not coerced to 0), no items -> empty attacks[]", () => {
  const raw = mapActorToBestiary(sparseSpirit);
  assert.equal(raw.name, "Wandering Spirit");
  assert.equal(raw.hp, 9);
  assert.equal(raw.ac, null, "absent ac must surface as null, never a fabricated 0");
  assert.deepEqual(raw.attacks, []);
  assert.equal(raw.multiattack, undefined);
  assert.equal(raw.rechargeAbilities, undefined);
  assert.equal(raw.appliedEffects, undefined);
});

test("mapActorToBestiary: never throws on a totally empty/null actor object", () => {
  assert.doesNotThrow(() => mapActorToBestiary({}));
  assert.doesNotThrow(() => mapActorToBestiary({ system: null, items: null, effects: null }));
});

// --------------------------------------------------------------- mapActorToPartyMember (PCs)

test("mapActorToPartyMember: Elowen -- combatRelevant.class/level/ac/hp pulled from the class item + system", () => {
  const raw = mapActorToPartyMember(elowen);
  assert.equal(raw.name, "Elowen Ashgrove");
  assert.equal(raw.combatRelevant.class, "Ranger");
  assert.equal(raw.combatRelevant.level, 4);
  assert.equal(raw.combatRelevant.ac, 15);
  assert.equal(raw.combatRelevant.hp, 27);
});

test("mapActorToPartyMember: attackBonus is the HIGHEST toHitBonus among derived weapon attacks; damagePerRoundEstimate sums dice averages", () => {
  const raw = mapActorToPartyMember(elowen);
  assert.equal(raw.combatRelevant.attackBonus, 6, "Longbow's attackBonus (6)");
  assert.equal(raw.combatRelevant.damagePerRoundEstimate, 7.5, "1d8+3 dice average (4.5) + 3 = 7.5");
});

test("mapActorToPartyMember: saveDCs is system.saves passed through directly, no reshaping (per the contract's own explicit design decision)", () => {
  const raw = mapActorToPartyMember(elowen);
  assert.deepEqual(raw.combatRelevant.saveDCs, { str: 0, dex: 3, con: 2, int: 1, wis: 4, cha: 0 });
});

test("mapActorToPartyMember: buildRelevant.skills includes every proficient>=1 skill; expertise only proficient===2", () => {
  const raw = mapActorToPartyMember(elowen);
  assert.deepEqual(new Set(raw.buildRelevant.skills), new Set(["prc", "sur", "ste"]));
  assert.deepEqual(raw.buildRelevant.expertise, ["prc"]);
});

test("mapActorToPartyMember: buildRelevant.notableTraits is a plain HTML-stripped pass-through of the biography (per the contract's explicit allowance)", () => {
  const raw = mapActorToPartyMember(elowen);
  assert.deepEqual(raw.buildRelevant.notableTraits, [
    "A ranger raised on the edge of the Ashwood, tracking a warband that raided her home village."
  ]);
});

test("mapActorToPartyMember: backstoryHooks is left undefined -- a documented gap (LLM-territory, no signal in raw stats)", () => {
  const raw = mapActorToPartyMember(elowen);
  assert.equal(raw.buildRelevant.backstoryHooks, undefined);
});

test("mapActorToPartyMember: never throws on a minimal/empty actor -- every combatRelevant/buildRelevant field is individually optional", () => {
  const raw = mapActorToPartyMember({});
  assert.equal(raw.name, "Unnamed Character");
  assert.deepEqual(raw.combatRelevant, {
    class: undefined,
    level: undefined,
    ac: undefined,
    hp: undefined,
    attackBonus: undefined,
    damagePerRoundEstimate: undefined,
    saveDCs: undefined,
    notableAbilities: undefined
  });
  assert.deepEqual(raw.buildRelevant, { skills: undefined, expertise: undefined, notableTraits: undefined, backstoryHooks: undefined });
});

// ------------------------------------------------------- stripHtml (now exported)

test("stripHtml: EXPORTED as of Phase 35 task 35.1 -- strips tags, collapses whitespace, null for empty/non-string", () => {
  assert.equal(stripHtml("<p>Hello   <b>world</b>.</p>"), "Hello world .");
  assert.equal(stripHtml(""), null);
  assert.equal(stripHtml(null), null);
  assert.equal(stripHtml(42), null);
});

// ------------------------------------------------------- mapActorItemsToInventory (Phase 35 task 35.1)

test("mapActorItemsToInventory: the sample fixture's PC (Elowen) has only a class item + a weapon -- BOTH excluded, [] returned", () => {
  assert.deepEqual(mapActorItemsToInventory(elowen), [], "class/weapon items already feed this PC's own combat-relevant stat block, never re-surfaced as Reliquary rows");
});

test("mapActorItemsToInventory: a monster's items[] (weapons/feats) are ALSO excluded by the same type filter -- this function is never called for a monster in practice (foundry-pull-ops.mjs's own scope rule), but is itself just a pure type filter with no actor-role awareness", () => {
  assert.deepEqual(mapActorItemsToInventory(goblinBoss), [], "Scimitar (weapon) + Multiattack/Redcap Fury (feat) are all excluded item TYPES, regardless of whose actor they're on");
});

test("mapActorItemsToInventory: a genuine inventory item (consumable/equipment/loot) is included, with quantity/description/foundryItemRef mapped", () => {
  const actor = {
    uuid: "Actor.invTest",
    name: "Inventory Test PC",
    items: [
      { uuid: "Item.potion", name: "Potion of Healing", type: "consumable", system: { quantity: 3, description: { value: "<p>Regains 2d4 + 2 hit points.</p>" } } },
      { uuid: "Item.bag", name: "Bag of Holding", type: "equipment", system: { quantity: 1 } },
      { uuid: "Item.class", name: "Fighter", type: "class", system: { levels: 3 } },
      { uuid: "Item.sword", name: "Longsword", type: "weapon", system: { damage: { parts: [["1d8", "slashing"]] } } }
    ]
  };
  const mapped = mapActorItemsToInventory(actor);
  const names = mapped.map((i) => i.name).sort();
  assert.deepEqual(names, ["Bag of Holding", "Potion of Healing"], "class + weapon excluded, consumable + equipment included");

  const potion = mapped.find((i) => i.name === "Potion of Healing");
  assert.equal(potion.type, "consumable");
  assert.equal(potion.quantity, 3);
  assert.equal(potion.description, "Regains 2d4 + 2 hit points.");
  assert.equal(potion.foundryItemRef, "Item.potion");

  const bag = mapped.find((i) => i.name === "Bag of Holding");
  assert.equal(bag.quantity, 1);
  assert.equal(bag.description, null, "no description.value present -- null, not a fabricated default");
});

test("mapActorItemsToInventory: fail-soft -- no items[]/malformed actor never throws, quantity defaults to null when non-numeric/absent", () => {
  assert.deepEqual(mapActorItemsToInventory({}), []);
  assert.deepEqual(mapActorItemsToInventory(null), []);
  const mapped = mapActorItemsToInventory({ items: [{ uuid: "Item.x", name: "Loose Loot", type: "loot", system: {} }] });
  assert.equal(mapped[0].quantity, null);
  assert.equal(mapped[0].description, null);
});

console.log(`\n${passed} passed`);
