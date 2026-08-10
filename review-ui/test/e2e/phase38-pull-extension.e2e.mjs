// Phase 38 task 38.0 -- pull-extension route contracts (phase38-fixture.mjs
// §2/§3): `worldItems[]` -> Reliquary, `compendia[]` Scene entries ->
// Stagecraft browse rows. Read phase38-fixture.mjs's header FIRST.
//
// EXPECTED RED, ALL THREE TESTS: today's `pullFoundryActorsToStores`
// (wf-mcp-server/lib/foundry-pull-ops.mjs) reads ONLY `index.actors[]` and
// `index.scenes[]` -- it has no loop over `index.worldItems[]` or
// `index.compendia[]` at all (confirmed by direct read before writing this
// file). Every assertion below that expects a non-empty Reliquary/Stagecraft
// result is therefore asserting against a route that currently returns
// EMPTY for these two new index keys, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  pullActorsViaRoute,
  listItemsViaRoute,
  listStagecraftViaRoute,
  writeFoundryIndexV3Fixture
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-p38-pull-");
const WORLD = "e2e-p38-pull-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
writeFoundryIndexV3Fixture(dataDir, WORLD);

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("ROUTE LEVEL: worldItems[] land in Reliquary as unowned proposals (foundryItemRef, sourceText, null owner fields)", async () => {
  const result = await pullActorsViaRoute(base, WORLD);
  assert.ok(result, "pull-actors must still succeed as a route (200)");

  const { status, body } = await listItemsViaRoute(base, WORLD);
  assert.equal(status, 200, `GET /api/combat-planning/items must be a real, live route, got ${status}: ${JSON.stringify(body)}`);

  const potion = (body.items || []).find((i) => i.foundryItemRef === "Item.worldPotion");
  assert.ok(potion, "the fixture's worldItems[] Potion of Fire Breath must land as an ItemRecord (foundryItemRef=\"Item.worldPotion\") -- got none, worldItems[] is being ignored by pullFoundryActorsToStores today");
  assert.equal(potion?.name, "Potion of Fire Breath");
  assert.equal(potion?.ownerFoundryActorUuid, null, "a world item has no owning actor");
  assert.equal(potion?.ownerPartyMemberId, null, "a world item has no owning party member");
  assert.match(potion?.sourceText || "", /world items/i, "sourceText must identify this as pulled from Foundry world items, not an actor");
  assert.equal(potion?.status, "proposed", "every pulled candidate lands as proposed, never auto-accepted");

  // §2's resolved ambiguity: a "weapon"-typed world item is NOT excluded the
  // way an actor-embedded weapon item would be (that exclusion exists only
  // to avoid duplicating a PC's own combat stat block -- no such actor
  // exists for a loose world item).
  const sword = (body.items || []).find((i) => i.foundryItemRef === "Item.worldLongsword");
  assert.ok(sword, "a \"weapon\"-typed worldItems[] entry must still land in Reliquary (no actor-inventory type filter applies to loose world items)");
});

test("ROUTE LEVEL: compendia[] Scene-pack entries land in Stagecraft as browse rows (compendiumRef, foundryRef:null, import meta); non-Scene pack contributes nothing", async () => {
  await pullActorsViaRoute(base, WORLD);

  const { status, body } = await listStagecraftViaRoute(base, WORLD, "map");
  assert.equal(status, 200, `GET /api/session-planner/stagecraft must be a real, live route, got ${status}: ${JSON.stringify(body)}`);

  const browseRows = (body.assets || []).filter((a) => a.compendiumRef);
  assert.equal(
    browseRows.length,
    3,
    `all 3 Scene-pack entries (czepeku-taverns.scenes) must land as browse rows, got ${browseRows.length} -- compendia[] is being ignored by pullFoundryActorsToStores today`
  );

  const tavernA = browseRows.find((a) => a.compendiumRef?.entryId === "scnEntryTavernA");
  assert.ok(tavernA, "The Drowned Anchor must land keyed on compendiumRef.entryId");
  assert.equal(tavernA?.compendiumRef?.packId, "czepeku-taverns.scenes");
  assert.equal(tavernA?.name, "The Drowned Anchor");
  assert.equal(tavernA?.foundryRef, null, "a not-yet-imported browse row must have foundryRef:null");
  assert.match(tavernA?.meta || "", /in compendium.*import to stage/i, 'meta must read "in compendium — import to stage"');
  assert.equal(tavernA?.status, "proposed");

  // The non-Scene pack (plutonium-next.items, documentType:"Item", no
  // `entries` key) must contribute ZERO Stagecraft rows -- browsable entries
  // are a Scene-only concept per the bridge contract's own §1.7 reasoning.
  const fromNonScenePack = browseRows.filter((a) => a.compendiumRef?.packId === "plutonium-next.items");
  assert.equal(fromNonScenePack.length, 0, "a non-Scene compendium pack must never produce a Stagecraft browse row");
});

test("ROUTE LEVEL: re-pulling upserts on packId+entryId (and foundryItemRef) -- no duplicate rows on a second pull", async () => {
  await pullActorsViaRoute(base, WORLD);
  await pullActorsViaRoute(base, WORLD); // second pull, identical index

  const { body: itemsBody } = await listItemsViaRoute(base, WORLD);
  const potions = (itemsBody?.items || []).filter((i) => i.foundryItemRef === "Item.worldPotion");
  assert.equal(potions.length, 1, `a re-pull must UPDATE the still-proposed worldItems[] candidate in place, never duplicate it, got ${potions.length} rows`);

  const { body: stagecraftBody } = await listStagecraftViaRoute(base, WORLD, "map");
  const tavernRows = (stagecraftBody?.assets || []).filter((a) => a.compendiumRef?.entryId === "scnEntryTavernA");
  assert.equal(tavernRows.length, 1, `a re-pull must UPDATE the still-proposed compendium browse row in place (packId+entryId dedup), never duplicate it, got ${tavernRows.length} rows`);
});
