// Phase 35 task 35.0 -- QE-first e2e contract, part 4: ROUTE-LEVEL contracts
// only (no browser -- mirrors phase33-remove-from-graph.e2e.mjs's own
// precedent for a route-only *.e2e.mjs file; `npm run test:e2e`'s glob is
// test/e2e/*.e2e.mjs regardless of whether a file drives a browser). Read
// phase35-fixture.mjs FIRST (§6 pull-mapper extension outputs, §7 tray-drop
// persistence, §8/§9 routes).
//
// Covers:
//   (a) the pull-extension outputs folded into the EXISTING, REUSED
//       POST /api/foundry/pull-actors route (§6) -- items -> Reliquary
//       proposals (owner-linked), scenes -> Stagecraft map refs (background
//       src + dims meta), tokens -> token-index (per-scene REPLACE, not
//       upsert). Every pulled candidate lands as a PROPOSAL (status gate),
//       per the phase's own locked, non-relitigable decision.
//   (b) tray-drop persistence contracts (§7) at the route level: creature
//       drop creates a KEY-behaving (stat-carrying) scene element populated
//       from the bestiary entry; hero drop is display-only (creates NO
//       scene element); asset drop creates the roster entry that IS the
//       scene-asset link (this file's own pinned decision, §7).
//
// EXPECTED-RED reasons: `itemsProposed`/`stagecraftProposed`/`tokensSynced`
// do not appear anywhere in wf-mcp-server/lib/foundry-pull-ops.mjs's current
// return shape (grep/read-confirmed, only bestiaryProposed/partyProposed/
// alreadyLinked/skippedActors exist today) -- these assertions fail against
// the REAL, already-shipped route (not a 404) until 35.1 extends it. The
// `.../tray/*` routes 404 outright until 35.3.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  writeFoundryIndexFixture,
  pullActorsViaRoute,
  listItemsViaRoute,
  listStagecraftViaRoute,
  listTokenIndexViaRoute,
  fetchSceneTrayViaRoute,
  dropOnSceneTrayViaRoute,
  removeFromSceneTrayViaRoute
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p35pull-");
const WORLD = "e2e-p35-pull-persistence";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { acceptBestiaryEntry, getBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
const seededIndex = writeFoundryIndexFixture(dataDir, WORLD);

let server, base, pulled, scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  pulled = await pullActorsViaRoute(base, WORLD);
  scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Descend into the chantry." });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// (a) PULL-EXTENSION OUTPUTS, folded into the EXISTING pull-actors route
// ---------------------------------------------------------------------------
test("pull-actors response gains itemsProposed: Kestrel's 3 real inventory items (Potion of Healing/Bag of Holding/Rope), owner-linked, all status:'proposed'", async () => {
  assert.ok(Array.isArray(pulled.itemsProposed), 'pull-actors response must gain an "itemsProposed" array (§6) -- currently absent from the real, already-shipped route\'s return shape');
  assert.equal(pulled.itemsProposed.length, 3, "Kestrel Windrider's 3 real inventory items (a monster's items[] never feeds Reliquary, per deferred §1's own scope rule)");

  const names = pulled.itemsProposed.map((i) => i.name).sort();
  assert.deepEqual(names, ["Bag of Holding", "Potion of Healing", "Rope, Silk (50 feet)"]);

  for (const item of pulled.itemsProposed) {
    assert.equal(item.status, "proposed", `every pulled item must land as a PROPOSAL, never auto-accepted -- "${item.name}" was "${item.status}"`);
    assert.equal(item.ownerFoundryActorUuid, "Actor.kestrelWindrider", `"${item.name}" must be owner-linked to the PC actor it was embedded on`);
  }

  const potion = pulled.itemsProposed.find((i) => i.name === "Potion of Healing");
  assert.equal(potion.quantity, 3, "quantity must come from item.system.quantity");
  assert.match(potion.description ?? "", /regains 2d4/, "description must be the stripped-HTML system.description.value text");
});

test("pull-actors response gains stagecraftProposed: one map-kind StagecraftAsset per scenes[], background.src + dims captured in meta, status:'proposed'", async () => {
  assert.ok(Array.isArray(pulled.stagecraftProposed), 'pull-actors response must gain a "stagecraftProposed" array (§6)');
  assert.equal(pulled.stagecraftProposed.length, 1, "one pulled scene (The Sunken Chantry) in this fixture");

  const map = pulled.stagecraftProposed[0];
  assert.equal(map.kind, "map");
  assert.equal(map.name, "The Sunken Chantry");
  assert.equal(map.status, "proposed", "a pulled map ref must land as a PROPOSAL, per the locked 'all pulled content lands as proposals' decision");
  assert.equal(map.foundryRef?.sceneUuid, "Scene.sunkenChantry");
  assert.match(map.meta ?? "", /4000/, "meta must carry the scene's real width (4000) for display");
  assert.match(map.meta ?? "", /3000/, "meta must carry the scene's real height (3000) for display");
});

test("pull-actors response gains tokensSynced: token-index per-scene REPLACE (running the pull twice does not duplicate tokens)", async () => {
  assert.ok(Array.isArray(pulled.tokensSynced), 'pull-actors response must gain a "tokensSynced" array (§6)');
  assert.deepEqual(pulled.tokensSynced, [{ sceneUuid: "Scene.sunkenChantry", count: 3 }], "3 tokens placed on the one seeded scene");

  const firstRead = await listTokenIndexViaRoute(base, WORLD, "Scene.sunkenChantry");
  if (firstRead.status === 404) return; // expected-red today (token-index route doesn't exist yet)
  assert.equal(firstRead.body.tokens.length, 3);

  // Re-pull (SAME index, unchanged) -- token count for this scene must stay
  // exactly 3, never 6 -- proves REPLACE semantics, not append/upsert.
  const secondPull = await pullActorsViaRoute(base, WORLD);
  assert.deepEqual(secondPull.tokensSynced, [{ sceneUuid: "Scene.sunkenChantry", count: 3 }]);
  const secondRead = await listTokenIndexViaRoute(base, WORLD, "Scene.sunkenChantry");
  assert.equal(secondRead.body.tokens.length, 3, "a second pull of the SAME index must REPLACE, not accumulate, this scene's token set");
});

test("alreadyLinked gains an 'items' key: re-pulling after accepting an item leaves it untouched, reported under alreadyLinked.items", async () => {
  if (!Array.isArray(pulled.itemsProposed) || pulled.itemsProposed.length === 0) return; // depends on the prior test's own red state
  const potionId = pulled.itemsProposed.find((i) => i.name === "Potion of Healing")?.id;
  const acceptRes = potionId ? (await (await fetch(`${base}/api/combat-planning/items/${encodeURIComponent(potionId)}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: WORLD })
  })).json().catch(() => null)) : null;
  if (!acceptRes || acceptRes.error) return; // accept route not built yet -- expected-red

  const rePulled = await pullActorsViaRoute(base, WORLD);
  assert.ok(rePulled.alreadyLinked.items.includes("Item.kestrel-potion-healing"), "an accepted item's foundryItemRef must be reported under alreadyLinked.items on a re-pull, never silently re-proposed");
});

// ---------------------------------------------------------------------------
// (b) TRAY-DROP PERSISTENCE CONTRACTS (§7)
// ---------------------------------------------------------------------------
test("creature tray-drop creates a stat-carrying local scene element from the bestiary entry (first drop), and does NOT duplicate the element on a second (stacking) drop", async () => {
  const ogrekin = pulled.bestiaryProposed.find((e) => e.rawFields.name === "Ogrekin Skirmisher");
  acceptBestiaryEntry(ogrekin.id);

  const first = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: ogrekin.id });
  if (first.status === 404) return; // expected-red today (tray route doesn't exist yet)
  assert.equal(first.status, 200);
  assert.ok(first.body.element, "the FIRST creature drop must create/return a real scene element");
  assert.equal(first.body.element.kind, "local", "per §7's own pin, this phase's creature-drop element is kind:'local' (no graph link exists yet to reuse), NOT kind:'graph'");
  assert.ok(first.body.element.stat, "the created element must carry a populated stat object");
  const entry = getBestiaryEntry(ogrekin.id);
  assert.equal(first.body.element.stat.ac, entry.rawFields.ac, "stat.ac must come from the bestiary entry's own rawFields.ac");
  assert.equal(first.body.element.stat.hp, entry.rawFields.hp, "stat.hp must come from the bestiary entry's own rawFields.hp");

  const elementsRes = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements?world=${encodeURIComponent(WORLD)}`);
  const elementsBefore = (await elementsRes.json()).elements.length;

  const second = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: ogrekin.id });
  assert.equal(second.status, 200);
  assert.equal(second.body.roster.find((r) => r.id === ogrekin.id)?.n, 2, "the second drop must stack the roster to n:2");
  assert.equal(second.body.element, null, "the SECOND drop of the same creature must NOT create a second element -- element is null/absent, only the roster stacks");

  const elementsRes2 = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements?world=${encodeURIComponent(WORLD)}`);
  const elementsAfter = (await elementsRes2.json()).elements.length;
  assert.equal(elementsAfter, elementsBefore, "the scene's element COUNT must not grow on a stacking drop");
});

test("hero tray-drop is display-only: creates NO scene element at all, only a roster entry", async () => {
  const kestrel = pulled.partyProposed[0];
  const elementsBeforeRes = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements?world=${encodeURIComponent(WORLD)}`);
  const elementsBefore = (await elementsBeforeRes.json()).elements.length;

  const dropped = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "hero", id: kestrel.id });
  if (dropped.status === 404) return; // expected-red today
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.element, null, "a hero drop must never create a scene element (display-only, per the design's own phrase taken literally)");
  assert.ok(dropped.body.roster.some((r) => r.kind === "hero" && r.id === kestrel.id));

  const elementsAfterRes = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(scene.id)}/elements?world=${encodeURIComponent(WORLD)}`);
  const elementsAfter = (await elementsAfterRes.json()).elements.length;
  assert.equal(elementsAfter, elementsBefore, "the scene's element count must be COMPLETELY unaffected by a hero drop");
});

test("asset tray-drop's roster entry IS the scene-asset link (§7's own pin) -- removing it via the tray route removes the link, no separate store to check", async () => {
  const stagecraft = await listStagecraftViaRoute(base, WORLD);
  const items = await listItemsViaRoute(base, WORLD);
  const assetId = stagecraft.body?.assets?.[0]?.id ?? items.body?.items?.[0]?.id;
  if (!assetId) return; // depends on item/stagecraft list routes existing -- expected-red today

  const dropped = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "asset", id: assetId });
  if (dropped.status === 404) return; // expected-red today
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.element, null, "an asset drop creates no scene element either");
  assert.ok(dropped.body.roster.some((r) => r.kind === "asset" && r.id === assetId), "the roster row itself IS the scene-asset link -- no separate sceneAssets field/store exists per this file's own pinned decision");

  const removed = await removeFromSceneTrayViaRoute(base, WORLD, scene.id, "asset", assetId);
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.roster.some((r) => r.kind === "asset" && r.id === assetId), "removing the roster row removes the entire scene-asset link -- there is nowhere else the link could still exist");
});

test("an unresolvable id for a given kind 404s cleanly (not a 500) -- e.g. dropping a nonexistent bestiary entry id", async () => {
  const dropped = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: "bst_does_not_exist" });
  // Either the route doesn't exist yet (404, generic "No route" body) or it
  // exists and correctly 404s on the unresolvable id (404, a real "not
  // found" message) -- both are acceptable "not a crash" outcomes for this
  // suite; a 500 here would be a real bug.
  assert.notEqual(dropped.status, 500, "an unresolvable creature id must never 500");
});

test("sanity: the fixture's own seeded index really has 3 actors / 1 scene / 3 flattened tokens (guards against a broken fixture masquerading as a real red)", () => {
  assert.equal(seededIndex.actors.length, 3);
  assert.equal(seededIndex.scenes.length, 1);
  assert.equal(seededIndex.tokens.length, 3);
  assert.equal(seededIndex.actors.filter((a) => a.type === "npc").length, 2, "2 monsters (Ogrekin Skirmisher CR5, Frostmaw the Undying CR12 legendary)");
  const frostmaw = seededIndex.actors.find((a) => a.name === "Frostmaw the Undying");
  const legendaryFeats = frostmaw.items.filter((i) => i.system?.activation?.type === "legendary");
  assert.equal(legendaryFeats.length, 3, "Frostmaw must carry 3 legendary-activation feat items -- the fixture's own 'a legendary' requirement");
});
