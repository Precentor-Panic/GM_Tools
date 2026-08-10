import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-pull-ops.mjs's
 * pullFoundryActorsToStores(dataDir, world) (Phase 32 task 32.2, the
 * phase's PRIMARY deliverable). End-to-end against the 32.0 fixtures + real
 * (scratch-isolated) bestiary/party-roster stores on disk -- no live
 * Foundry, no mocking of the stores themselves (this is exactly the
 * composition the route/MCP tool call verbatim).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "foundry-bridge");

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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-pull-ops-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
// Phase 35 task 35.1 -- the four new store dirs the pull-mapper extension composes with.
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_TOKEN_DIR = join(scratchDir, "tokens");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
const dataDir = join(scratchDir, "foundrydata");

const { pullFoundryActorsToStores } = await import("../lib/foundry-pull-ops.mjs");
const { foundryIndexPath } = await import("../lib/snapshot.mjs");
const { listBestiaryEntries, acceptBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { listPartyMembers, acceptPartyMember } = await import("../../combat-planning/party-roster-store.mjs");
const { listItems, acceptItem } = await import("../../combat-planning/item-store.mjs");
const { listStagecraftAssets, markStagecraftAssetImported } = await import("../../session-planner/stagecraft-store.mjs");
const { listTokens } = await import("../../session-planner/token-store.mjs");

function writeIndexFixture(world, fixtureName) {
  const src = JSON.parse(readFileSync(join(FIXTURES_DIR, fixtureName), "utf8"));
  const dest = foundryIndexPath(dataDir, world);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(src), "utf8");
  return src;
}

const SAMPLE_WORLD = "pull-ops-sample-world";
const sampleFixture = writeIndexFixture(SAMPLE_WORLD, "foundry-index.sample.json");

test("pullFoundryActorsToStores: no index file yet -- indexFound:false, empty results, never throws", () => {
  const result = pullFoundryActorsToStores(dataDir, "never-indexed-world");
  assert.equal(result.indexFound, false);
  assert.deepEqual(result.bestiaryProposed, []);
  assert.deepEqual(result.partyProposed, []);
  // Phase 35 task 35.1, §6 -- strictly additive response shape.
  assert.deepEqual(result.itemsProposed, []);
  assert.deepEqual(result.stagecraftProposed, []);
  assert.deepEqual(result.tokensSynced, []);
  assert.deepEqual(result.alreadyLinked, { bestiary: [], party: [], items: [] });
});

test("pullFoundryActorsToStores: the sample fixture's 2 monsters land in bestiaryProposed, the 1 PC lands in partyProposed, all status:'proposed'", () => {
  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.equal(result.indexFound, true);
  assert.equal(result.bestiaryProposed.length, 2);
  assert.equal(result.partyProposed.length, 1);

  const names = result.bestiaryProposed.map((e) => e.rawFields.name).sort();
  assert.deepEqual(names, ["Goblin", "Goblin Boss"]);
  assert.ok(result.bestiaryProposed.every((e) => e.status === "proposed"));
  assert.ok(result.bestiaryProposed.every((e) => typeof e.foundryActorRef === "string" && e.foundryActorRef.startsWith("Actor.")));

  assert.equal(result.partyProposed[0].name, "Elowen Ashgrove");
  assert.equal(result.partyProposed[0].status, "proposed");
  assert.equal(result.partyProposed[0].foundryActorRef, "Actor.pc001elowen");
});

// -------------------------------------------------------------------------
// Phase 35 task 35.1, §6 -- itemsProposed/stagecraftProposed/tokensSynced.
// -------------------------------------------------------------------------

test("pullFoundryActorsToStores: the sample fixture's PC carries only class/weapon items (no genuine inventory) -- itemsProposed stays empty, never throws", () => {
  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.deepEqual(result.itemsProposed, [], "Elowen's own items are a Ranger class item + a Longbow -- both excluded (they already feed her own combat-relevant stat block)");
});

test("pullFoundryActorsToStores: the sample fixture's one scene (background+dims present) lands in stagecraftProposed as a status:'proposed' kind:'map' asset", () => {
  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.equal(result.stagecraftProposed.length, 1);
  const map = result.stagecraftProposed[0];
  assert.equal(map.kind, "map");
  assert.equal(map.name, "Goblin Ridge Camp");
  assert.equal(map.status, "proposed");
  assert.equal(map.foundryRef?.sceneUuid, "Scene.camp001");
  assert.match(map.meta ?? "", /4000/);
  assert.match(map.meta ?? "", /3000/);
  assert.match(map.meta ?? "", /grid 100\/5ft/);
  // Phase 36 task 36.2, §4 -- foundryRef.imagePath captured from
  // scenes[].background.src (previously discarded -- only sceneUuid was set).
  const sampleScene = sampleFixture.scenes.find((s) => s.uuid === "Scene.camp001");
  assert.equal(map.foundryRef?.imagePath, sampleScene.background.src);

  const onDisk = listStagecraftAssets(SAMPLE_WORLD);
  assert.equal(onDisk.length, 1, "the map asset landed in the REAL store too");
});

test("pullFoundryActorsToStores: the sample fixture's 3 scene tokens land in the token-index via a per-scene REPLACE (tokensSynced reports the post-replace count)", () => {
  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.deepEqual(result.tokensSynced, [{ sceneUuid: "Scene.camp001", count: 3 }]);
  assert.equal(listTokens(SAMPLE_WORLD, "Scene.camp001").length, 3);

  // Re-pull the SAME (unchanged) index -- must REPLACE, never accumulate.
  const second = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.deepEqual(second.tokensSynced, [{ sceneUuid: "Scene.camp001", count: 3 }]);
  assert.equal(listTokens(SAMPLE_WORLD, "Scene.camp001").length, 3, "a second pull of the same index must not double the token count");
});

// A purpose-built index (not one of the 32.0 fixtures) exercising a PC with
// GENUINE inventory items -- the 32.0 sample fixture's own PC (Elowen) only
// carries a class item + a weapon, neither of which is "inventory" per
// this task's own item-type filter (see foundry-pull-ops.mjs's own header
// comment for the full reasoning).
const ITEMS_WORLD = "pull-ops-items-world";
const itemsIndex = {
  version: 1,
  worldId: ITEMS_WORLD,
  exportedAt: "2026-08-08T00:00:00.000Z",
  actors: [
    {
      uuid: "Actor.itemsPcOne",
      name: "Tam Fletcher",
      type: "character",
      system: { hp: { value: 20, max: 20 }, ac: 13, level: 2 },
      items: [
        { uuid: "Item.tam-shortbow", name: "Shortbow", type: "weapon", system: { damage: { parts: [["1d6", "piercing"]] } } },
        {
          uuid: "Item.tam-potion",
          name: "Potion of Healing",
          type: "consumable",
          system: { quantity: 2, description: { value: "<p>Regains 2d4 + 2 hit points.</p>" } }
        },
        { uuid: "Item.tam-rope", name: "Rope", type: "loot", system: { quantity: 1, description: { value: "<p>Fifty feet of hempen rope.</p>" } } }
      ],
      effects: []
    }
  ],
  users: [{ id: "u1", name: "Player", role: 1, characterUuid: "Actor.itemsPcOne" }],
  scenes: [{ uuid: "Scene.noBackground", name: "Blank Scene", background: null, width: 100, height: 100 }],
  tokens: []
};
mkdirSync(dirname(foundryIndexPath(dataDir, ITEMS_WORLD)), { recursive: true });
writeFileSync(foundryIndexPath(dataDir, ITEMS_WORLD), JSON.stringify(itemsIndex), "utf8");

test("pullFoundryActorsToStores: a PC's genuine inventory items (excluding weapon/class) land in itemsProposed, owner-linked", () => {
  const result = pullFoundryActorsToStores(dataDir, ITEMS_WORLD);
  assert.equal(result.itemsProposed.length, 2, "Potion of Healing + Rope -- the Shortbow (weapon) is excluded");
  const names = result.itemsProposed.map((i) => i.name).sort();
  assert.deepEqual(names, ["Potion of Healing", "Rope"]);
  for (const item of result.itemsProposed) {
    assert.equal(item.status, "proposed");
    assert.equal(item.ownerFoundryActorUuid, "Actor.itemsPcOne");
    assert.equal(item.ownerPartyMemberId, result.partyProposed[0].id, "owner-linked against the SAME pass's own upsertPartyMember result");
  }
  const potion = result.itemsProposed.find((i) => i.name === "Potion of Healing");
  assert.equal(potion.quantity, 2);
  assert.match(potion.description ?? "", /Regains 2d4/);
});

test("pullFoundryActorsToStores: a scene with background:null is SKIPPED from stagecraftProposed entirely", () => {
  const result = pullFoundryActorsToStores(dataDir, ITEMS_WORLD);
  assert.deepEqual(result.stagecraftProposed, [], "a null background has nothing findable, per README §H");
});

test("pullFoundryActorsToStores: re-running the SAME pull UPDATES the still-proposed item candidates in place -- no duplicates", () => {
  const before = listItems(ITEMS_WORLD).length;
  const result = pullFoundryActorsToStores(dataDir, ITEMS_WORLD);
  assert.equal(result.itemsProposed.length, 2);
  assert.equal(listItems(ITEMS_WORLD).length, before, "re-ingest must update the existing proposed items, never create new ones");
});

test("pullFoundryActorsToStores: accepting an item, then re-pulling, NEVER touches it -- reported under alreadyLinked.items instead", () => {
  const potionBefore = listItems(ITEMS_WORLD).find((i) => i.name === "Potion of Healing");
  const accepted = acceptItem(ITEMS_WORLD, potionBefore.id);
  assert.equal(accepted.status, "accepted");

  const result = pullFoundryActorsToStores(dataDir, ITEMS_WORLD);
  assert.equal(result.itemsProposed.length, 1, "only Rope is still proposed");
  assert.deepEqual(result.alreadyLinked.items, ["Item.tam-potion"]);

  const potionAfter = listItems(ITEMS_WORLD).find((i) => i.name === "Potion of Healing");
  assert.equal(potionAfter.status, "accepted");
  assert.equal(potionAfter.quantity, 2, "the accepted item's fields were never overwritten by the re-pull");
});

test("pullFoundryActorsToStores: everything landed in the REAL stores too, not just the returned result (listBestiaryEntries/listPartyMembers agree)", () => {
  const entries = listBestiaryEntries().filter((e) => e.foundryActorRef?.startsWith("Actor.gob"));
  assert.equal(entries.length, 2);
  const members = listPartyMembers(SAMPLE_WORLD);
  assert.equal(members.length, 1);
  assert.equal(members[0].foundryActorRef, "Actor.pc001elowen");
});

test("pullFoundryActorsToStores: re-running the SAME pull UPDATES the still-proposed candidates in place -- no duplicates created", () => {
  const before = listBestiaryEntries().length;
  const beforeMembers = listPartyMembers(SAMPLE_WORLD).length;

  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.equal(result.bestiaryProposed.length, 2);
  assert.equal(result.partyProposed.length, 1);

  const after = listBestiaryEntries().length;
  const afterMembers = listPartyMembers(SAMPLE_WORLD).length;
  assert.equal(after, before, "re-ingest must UPDATE the existing proposed entries, never create new ones");
  assert.equal(afterMembers, beforeMembers, "same for party-roster members");
});

test("pullFoundryActorsToStores: accepting a candidate, then re-pulling, NEVER touches the accepted entry -- reported under alreadyLinked instead", () => {
  const bossEntryBefore = listBestiaryEntries().find((e) => e.foundryActorRef === "Actor.gob001boss");
  const accepted = acceptBestiaryEntry(bossEntryBefore.id);
  assert.equal(accepted.status, "accepted");

  const elowenBefore = listPartyMembers(SAMPLE_WORLD).find((m) => m.foundryActorRef === "Actor.pc001elowen");
  const acceptedMember = acceptPartyMember(SAMPLE_WORLD, elowenBefore.id);
  assert.equal(acceptedMember.status, "accepted");

  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);

  // The accepted bestiary entry is no longer in bestiaryProposed (only the
  // still-proposed Goblin grunt is) and is reported under alreadyLinked.
  assert.equal(result.bestiaryProposed.length, 1);
  assert.equal(result.bestiaryProposed[0].rawFields.name, "Goblin");
  assert.deepEqual(result.alreadyLinked.bestiary, ["Actor.gob001boss"]);

  // The accepted party member: no longer in partyProposed, reported under alreadyLinked.
  assert.deepEqual(result.partyProposed, []);
  assert.deepEqual(result.alreadyLinked.party, ["Actor.pc001elowen"]);

  // And the accepted records themselves are provably untouched -- re-read from the store.
  const bossEntryAfter = listBestiaryEntries().find((e) => e.foundryActorRef === "Actor.gob001boss");
  assert.equal(bossEntryAfter.status, "accepted");
  assert.equal(bossEntryAfter.rawFields.hp, 21, "the accepted entry's rawFields were never overwritten by the re-pull");

  const elowenAfter = listPartyMembers(SAMPLE_WORLD).find((m) => m.foundryActorRef === "Actor.pc001elowen");
  assert.equal(elowenAfter.status, "accepted");
});

test("pullFoundryActorsToStores: the minimal fixture's single sparse monster is ingested without throwing (hp present, ac null, no attacks)", () => {
  const MINIMAL_WORLD = "pull-ops-minimal-world";
  writeIndexFixture(MINIMAL_WORLD, "foundry-index.minimal.json");

  const result = pullFoundryActorsToStores(dataDir, MINIMAL_WORLD);
  assert.equal(result.indexFound, true);
  assert.equal(result.bestiaryProposed.length, 1);
  assert.equal(result.partyProposed.length, 0);
  assert.equal(result.bestiaryProposed[0].rawFields.hp, 9);
  assert.equal(result.bestiaryProposed[0].rawFields.ac, null);
  assert.deepEqual(result.skippedActors, []);
});

// ---------------------------------------------------------------------------
// Phase 38 task 38.2, §2/§3/§7 -- worldItems[] -> Reliquary unowned
// proposals, compendia[] Scene entries -> Stagecraft browse rows, and the
// early-return guard fix (actors:[] must not also skip scenes/worldItems/
// compendia). Mirrors review-ui/test/e2e/phase38-fixture.mjs's own
// writeFoundryIndexV3Fixture shape, hand-authored here for a fast
// unit-level pass (the e2e file covers the same contract at the route
// level).
// ---------------------------------------------------------------------------
const V3_WORLD = "pull-ops-v3-world";
const v3Index = {
  version: 1,
  worldId: V3_WORLD,
  exportedAt: "2026-08-10T12:00:00.000Z",
  actors: [],
  users: [],
  scenes: [],
  tokens: [],
  worldItems: [
    {
      uuid: "Item.worldPotion",
      name: "Potion of Fire Breath",
      type: "consumable",
      system: { quantity: 4, description: { value: "<p>Breathe fire for 1 minute.</p>" } }
    },
    {
      uuid: "Item.worldLongsword",
      name: "Longsword +1",
      type: "weapon",
      system: { quantity: 1, description: { value: "<p>A finely balanced blade.</p>" } }
    }
  ],
  compendia: [
    {
      packId: "czepeku-taverns.scenes",
      label: "Czepeku Taverns — Scenes",
      documentType: "Scene",
      count: 3,
      entries: [
        { id: "scnEntryTavernA", name: "The Drowned Anchor", thumb: "modules/czepeku-taverns/thumbs/tavern-a.webp" },
        { id: "scnEntryTavernB", name: "The Gilded Cask", thumb: "modules/czepeku-taverns/thumbs/tavern-b.webp" },
        { id: "scnEntryTavernC", name: "The Salt & Smoke", thumb: null }
      ]
    },
    { packId: "plutonium-next.items", label: "Plutonium — Items", documentType: "Item", count: 5417 }
  ]
};
mkdirSync(dirname(foundryIndexPath(dataDir, V3_WORLD)), { recursive: true });
writeFileSync(foundryIndexPath(dataDir, V3_WORLD), JSON.stringify(v3Index), "utf8");

test("pullFoundryActorsToStores: an index with actors:[] but worldItems/compendia present -- indexFound:true, and BOTH new arrays are still processed (the early-return guard no longer conflates 'zero actors' with 'no index')", () => {
  const result = pullFoundryActorsToStores(dataDir, V3_WORLD);
  assert.equal(result.indexFound, true);
  assert.deepEqual(result.bestiaryProposed, []);
  assert.deepEqual(result.partyProposed, []);
  assert.equal(result.itemsProposed.length, 2, "both worldItems[] entries land in itemsProposed");
  assert.equal(result.stagecraftProposed.length, 3, "all 3 Scene-pack entries land in stagecraftProposed");
});

test("pullFoundryActorsToStores: worldItems[] land UNOWNED (both owner fields null) with world-items sourceText, status:'proposed' -- NO type filter (a weapon-typed world item is still included)", () => {
  const items = listItems(V3_WORLD);
  const potion = items.find((i) => i.foundryItemRef === "Item.worldPotion");
  assert.ok(potion);
  assert.equal(potion.name, "Potion of Fire Breath");
  assert.equal(potion.quantity, 4);
  assert.equal(potion.ownerFoundryActorUuid, null);
  assert.equal(potion.ownerPartyMemberId, null);
  assert.match(potion.sourceText ?? "", /world items/i);
  assert.equal(potion.status, "proposed");

  const sword = items.find((i) => i.foundryItemRef === "Item.worldLongsword");
  assert.ok(sword, "a weapon-typed world item is NOT excluded (unlike an actor's own items[])");
  assert.equal(sword.type, "weapon");
});

test("pullFoundryActorsToStores: compendia[] Scene entries land as Stagecraft kind:'map' browse rows (compendiumRef, foundryRef:null, import meta, thumb carried through); the non-Scene pack contributes nothing", () => {
  const assets = listStagecraftAssets(V3_WORLD, "map");
  const browseRows = assets.filter((a) => a.compendiumRef);
  assert.equal(browseRows.length, 3);

  const tavernA = browseRows.find((a) => a.compendiumRef.entryId === "scnEntryTavernA");
  assert.equal(tavernA.compendiumRef.packId, "czepeku-taverns.scenes");
  assert.equal(tavernA.name, "The Drowned Anchor");
  assert.equal(tavernA.foundryRef, null);
  assert.match(tavernA.meta ?? "", /in compendium.*import to stage/i);
  assert.equal(tavernA.status, "proposed");
  assert.equal(tavernA.thumb, "modules/czepeku-taverns/thumbs/tavern-a.webp");

  const tavernC = browseRows.find((a) => a.compendiumRef.entryId === "scnEntryTavernC");
  assert.equal(tavernC.thumb, null, "a null pack-entry thumb is carried through as null, never fabricated");

  const fromNonScenePack = browseRows.filter((a) => a.compendiumRef.packId === "plutonium-next.items");
  assert.equal(fromNonScenePack.length, 0);
});

test("pullFoundryActorsToStores: re-pulling upserts on foundryItemRef / packId+entryId -- no duplicate rows on a second pull", () => {
  const itemsBefore = listItems(V3_WORLD).length;
  const stagecraftBefore = listStagecraftAssets(V3_WORLD, "map").length;

  const result = pullFoundryActorsToStores(dataDir, V3_WORLD);
  assert.equal(result.itemsProposed.length, 2, "still-proposed candidates are UPDATED in place");
  assert.equal(result.stagecraftProposed.length, 3);
  assert.equal(listItems(V3_WORLD).length, itemsBefore, "no new item rows created");
  assert.equal(listStagecraftAssets(V3_WORLD, "map").length, stagecraftBefore, "no new stagecraft rows created");
});

test("pullFoundryActorsToStores: an ACCEPTED compendium browse row is left untouched by a re-pull, reported via the SAME 'not in stagecraftProposed' convention as upsertStagecraftMap's own accepted-match branch", () => {
  const tavernBefore = listStagecraftAssets(V3_WORLD, "map").find((a) => a.compendiumRef?.entryId === "scnEntryTavernB");
  // Simulate a completed import (this is exactly what markStagecraftAssetImported does, exercised directly here for a pure pull-ops-level pin).
  markStagecraftAssetImported(V3_WORLD, tavernBefore.id, "Scene.gildedCaskImported");

  const result = pullFoundryActorsToStores(dataDir, V3_WORLD);
  const stillProposedTaverns = result.stagecraftProposed.filter((a) => a.compendiumRef?.packId === "czepeku-taverns.scenes");
  assert.equal(stillProposedTaverns.length, 2, "only the two still-proposed browse rows are reported -- the accepted/imported one is left untouched, not re-proposed");

  const tavernAfter = listStagecraftAssets(V3_WORLD, "map").find((a) => a.id === tavernBefore.id);
  assert.equal(tavernAfter.status, "accepted");
  assert.deepEqual(tavernAfter.foundryRef, { sceneUuid: "Scene.gildedCaskImported" }, "the accepted/imported row's foundryRef survives the re-pull untouched");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
