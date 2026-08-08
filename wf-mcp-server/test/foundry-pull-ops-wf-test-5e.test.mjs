import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-pull-ops.mjs's
 * pullFoundryActorsToStores, exercised against a SANITIZED SNAPSHOT of the
 * REAL `wf-test-5e` world's own `world-fabric-foundry-index.json` (Phase 35
 * task 35.1's own instruction: "if a world-fabric-foundry-index.json with
 * real content exists there, snapshot a sanitized copy as a test fixture
 * and test the pull mapping against it" -- 35.pre's provisioning finished
 * DURING this task's own execution window, so this fixture was captured
 * once real content existed, rather than being skipped/deferred to 35.4).
 *
 * `foundry-index.wf-test-5e-sample.json` is a TRIMMED (3 of the real
 * world's 18 actors, 1 of its 3 scenes) but otherwise VERBATIM copy of real
 * `wf-test-5e` data captured 2026-08-08 -- no field values were altered.
 * "Sanitized" here means trimmed-for-size, not redacted: the real content
 * (dnd5e 2014 SRD monster/PC stat blocks, "Player One"/"Gamemaster" generic
 * user names) carries no real personal data to redact in the first place --
 * confirmed by direct read of the full real file before this fixture was
 * captured. Picked actors: "Goblin" (CR 1/4, the cheap/simple case),
 * "Adult Red Dragon" (CR 17, legendary-class, 11 items), "Krusk (Half-Orc
 * Paladin)" (a PC with 22 real items spanning weapon/class/feat/race/
 * background AND genuine inventory -- equipment/loot/consumable/container/
 * tool -- the real-world case this task's own item-type filter is tested
 * against). Picked scene: "Dragon's Lair" (real background/dims/grid, 4
 * real placed tokens).
 *
 * Two REAL, CONFIRMED findings surfaced by testing against this real data
 * (neither is a 35.1 bug -- both are flagged here, not silently fixed,
 * since fixing either would mean editing pre-existing Phase 32 mapper logic
 * or the separate foundry_worldFabric repo, both out of this task's scope):
 *   1. The real wf-test-5e export never sets `item.system.activation.type`
 *      on ANY item (confirmed by direct inspection) -- deriveLegendaryActions
 *      (combat-planning/foundry-actor-mapper.mjs, Phase 32, untouched by
 *      this task) therefore finds ZERO legendary actions on the Adult Red
 *      Dragon despite it obviously being a legendary monster with feat
 *      items literally named "Legendary Actions"/"Detect"/etc. This is a
 *      real gap between that heuristic's assumption and this actual
 *      Foundry-module export's shape, not something this fixture can (or
 *      should) paper over -- asserted here as OBSERVED behavior, not
 *      "correct" behavior.
 *   2. Real placed-token `actorUuid` values in this export are NOT the bare
 *      `Actor.<id>` shape the bridge contract documents and this project's
 *      token-store.mjs's own doc comment assumes for the "a reader joins
 *      live against bestiary/party-roster's own foundryActorRef" design --
 *      they're a compound `Scene.<id>.Token.<id>.Actor.<id>` string. This
 *      project's own token-store.mjs never validates/parses actorUuid
 *      (typeof-guarded pass-through only), so nothing here BREAKS, but the
 *      documented "reader joins live" design would silently fail to match
 *      anything against this real data as-is. Flagged for 35.4/a future
 *      task, not fixed here (fixing it would mean either editing the
 *      separate foundry_worldFabric repo's own token-flattening code or
 *      adding a new parsing heuristic neither this task's contract nor any
 *      task plan asked for).
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-pull-ops-wf-test-5e-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_TOKEN_DIR = join(scratchDir, "tokens");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
const dataDir = join(scratchDir, "foundrydata");

const { pullFoundryActorsToStores } = await import("../lib/foundry-pull-ops.mjs");
const { foundryIndexPath } = await import("../lib/snapshot.mjs");
const { classifyActor, mapActorToBestiary } = await import("../../combat-planning/foundry-actor-mapper.mjs");
const { listTokens } = await import("../../session-planner/token-store.mjs");

const WORLD = "wf-test-5e-sanitized";
const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.wf-test-5e-sample.json"), "utf8"));
const dest = foundryIndexPath(dataDir, WORLD);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(fixture), "utf8");

const goblin = fixture.actors.find((a) => a.name === "Goblin");
const dragon = fixture.actors.find((a) => a.name === "Adult Red Dragon");
const krusk = fixture.actors.find((a) => a.name.startsWith("Krusk"));
const scene = fixture.scenes[0];

test("sanity: the sanitized fixture really carries real wf-test-5e data (3 actors, 1 scene, real hp/ac/cr)", () => {
  assert.equal(fixture.actors.length, 3);
  assert.equal(fixture.scenes.length, 1);
  assert.equal(dragon.system.cr, 17);
  assert.equal(dragon.system.hp.value, 256);
  assert.equal(krusk.type, "character");
});

test("classifyActor against real data: Krusk (a PC not directly referenced by any user's characterUuid in this trimmed fixture) still classifies 'pc' via the type==='character' fallback", () => {
  assert.equal(classifyActor(krusk, fixture.users), "pc");
});

test("classifyActor against real data: Goblin/Adult Red Dragon (type:'npc') classify 'monster'", () => {
  assert.equal(classifyActor(goblin, fixture.users), "monster");
  assert.equal(classifyActor(dragon, fixture.users), "monster");
});

test("mapActorToBestiary against real data: hp/ac/cr pulled straight from the real system block, never throws on 22/11-item real actors", () => {
  const mapped = mapActorToBestiary(dragon);
  assert.equal(mapped.hp, 256);
  assert.equal(mapped.ac, 19);
  assert.equal(mapped.challengeRating, 17);
});

test("REAL-DATA FINDING (documented, not fixed): the real export never sets item.system.activation.type -- deriveLegendaryActions finds 0 legendary actions on a genuinely legendary dragon", () => {
  const mapped = mapActorToBestiary(dragon);
  assert.equal(mapped.legendaryActions, undefined, "observed real-data gap -- see this file's own header comment finding #1");
  assert.ok(
    dragon.items.some((i) => i.name === "Legendary Actions"),
    "the dragon DOES carry a feat literally named 'Legendary Actions' -- the gap is in activation.type never being set, not in the fixture missing the content"
  );
});

test("pullFoundryActorsToStores against real data: the sanitized index round-trips through the full pull (bestiary + party + items + stagecraft + tokens), never throws", () => {
  const result = pullFoundryActorsToStores(dataDir, WORLD);
  assert.equal(result.indexFound, true);
  assert.deepEqual(result.skippedActors, []);
  assert.equal(result.bestiaryProposed.length, 2, "Goblin + Adult Red Dragon");
  assert.equal(result.partyProposed.length, 1, "Krusk");
});

test("pullFoundryActorsToStores against real data: Krusk's real 22 items filter down to exactly the 13 genuine-inventory ones (equipment/loot/consumable/container/tool), excluding class/subclass/weapon/feat/race/background", () => {
  const result = pullFoundryActorsToStores(dataDir, WORLD);
  assert.equal(result.itemsProposed.length, 13);
  const names = result.itemsProposed.map((i) => i.name).sort();
  assert.deepEqual(names, [
    "Amulet (Holy Symbol)",
    "Backpack",
    "Bedroll",
    "Chain Mail",
    "Hempen Rope (50 ft.)",
    "Love Letter",
    "Mess Kit",
    "Rations",
    "Shield",
    "Smith's Tools",
    "Tinderbox",
    "Torch",
    "Waterskin"
  ]);
  const torch = result.itemsProposed.find((i) => i.name === "Torch");
  assert.equal(torch.quantity, 10, "real quantity from the actual system.quantity field");
  assert.equal(torch.ownerFoundryActorUuid, krusk.uuid);
  assert.ok(result.itemsProposed.every((i) => i.status === "proposed"));

  // Real-data confirmation of the excluded set (Longsword/Javelin are
  // type:"weapon" -- excluded even though Javelin (qty 5) is genuinely
  // expendable inventory; a known, documented filter limitation, not a bug
  // -- see combat-planning/foundry-actor-mapper.mjs's own header comment).
  assert.ok(!names.includes("Longsword"));
  assert.ok(!names.includes("Javelin"));
  assert.ok(!names.includes("Paladin"), "class item excluded");
});

test("pullFoundryActorsToStores against real data: the real 'Dragon's Lair' scene lands in stagecraftProposed with real background/dims meta", () => {
  const result = pullFoundryActorsToStores(dataDir, WORLD);
  assert.equal(result.stagecraftProposed.length, 1);
  const map = result.stagecraftProposed[0];
  assert.equal(map.name, "Dragon's Lair");
  assert.equal(map.kind, "map");
  assert.equal(map.foundryRef.sceneUuid, scene.uuid);
  assert.match(map.meta ?? "", /3000/);
  assert.match(map.meta ?? "", /2000/);
  assert.match(map.meta ?? "", /grid 100\/5ft/);
});

test("pullFoundryActorsToStores against real data: the real scene's 4 placed tokens (Bugbear/Ogre/Owlbear/Knight) land in the token-index via a per-scene replace", () => {
  const result = pullFoundryActorsToStores(dataDir, WORLD);
  assert.deepEqual(result.tokensSynced, [{ sceneUuid: scene.uuid, count: 4 }]);
  const tokens = listTokens(WORLD, scene.uuid);
  assert.equal(tokens.length, 4);
  assert.deepEqual(tokens.map((t) => t.name).sort(), ["Bugbear", "Knight", "Ogre", "Owlbear"]);
  // REAL-DATA FINDING #2 (documented, not fixed) -- these real actorUuid
  // values are NOT the bare "Actor.<id>" shape the bridge contract
  // documents; pass-through only, never parsed/validated by this store.
  assert.ok(tokens.every((t) => typeof t.actorUuid === "string" && t.actorUuid.includes(".Actor.")));
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
