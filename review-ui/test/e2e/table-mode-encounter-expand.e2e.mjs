// Phase 25 task 25.0, REQUIRED SCENARIO 9 -- "Encounter nested expand: a
// saved encounter's roster row expands to the real stored stat block
// (name/HP/AC visible unexpanded; attacks/traits behind the nested expand)
// -- assert against the actual saveEncounter-persisted snapshot shape, not
// a UI-only mock." Read table-mode-fixture.mjs's header FIRST (§5 is this
// file's own section). EXPECTED TO FAIL right now -- none of
// `table-encounter-roster-row`/`table-encounter-roster-detail` exists yet.
// That failure is the deliverable of this task, not a bug in this file.
//
// GROUNDING: saveEncounter's own `combination` field only ever stores
// `{entryId, count}` pairs (confirmed directly in combat-planning/
// saved-encounter.mjs / combat-planning-view.js's toManualCombination) --
// the real name/hp/ac/attacks stat block lives in the SEPARATE, real
// bestiary store (GET /api/combat-planning/bestiary, confirmed live),
// resolved by entryId. There is no `traits` field anywhere in this
// codebase's real bestiary shape (confirmed directly against
// combat-planning/bestiary-ingest.mjs's RawBestiaryFields zod schema) --
// this file uses the real "beyond attacks" field that actually exists,
// `rechargeAbilities`, instead of inventing a `traits` field the
// implementation would have nothing real to read.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoTableMode,
  DESKTOP_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-encexpand-");
const WORLD = "e2e-tablemode-encexpand-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmencexp-anchor", name: "Encounter Expand Anchor", type: "place", importance: 0.5 } }
]);

const rawFields = {
  name: "Nested Expand Ogre",
  type: "giant",
  challengeRating: "2",
  hp: 59,
  ac: 11,
  attacks: [
    { name: "Greatclub", toHitBonus: 6, damageDice: "2d8+4", damageType: "bludgeoning" }
  ],
  rechargeAbilities: [
    { name: "Rock Throw", rechargeOn: "5-6", damageDice: "2d10+4" }
  ]
};
const bestiaryEntry = saveBestiaryEntry({ rawFields, derivedScore: null });
acceptBestiaryEntry(bestiaryEntry.id);

let server, base, browser, page;
let scene, encounterId;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmencexp-anchor" });

  const encRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/encounters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: WORLD,
      name: "Ogre Ambush",
      combination: [{ entryId: bestiaryEntry.id, count: 1 }],
      knobs: {},
      scoreSnapshot: { expectedScore: 1, burstCeiling: 1, snowballDelta: {}, asymmetricRiskFlag: false }
    })
  });
  const encBody = await encRes.json();
  assert.equal(encRes.status, 200, `encounter setup itself must succeed -- broken test setup, not the thing under test (got ${encRes.status}: ${JSON.stringify(encBody)})`);
  encounterId = encBody.encounter.id;

  // Sanity: confirm the real, already-shipped route's own persisted shape
  // BEFORE testing the UI -- combination really is just {entryId, count},
  // never the full stat block, confirming this scenario's own grounding.
  const getRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/encounters?world=${WORLD}`);
  const getBody = await getRes.json();
  assert.equal(getBody.encounters[0].combination[0].entryId, bestiaryEntry.id);
  assert.equal(getBody.encounters[0].combination[0].name, undefined, "sanity: saveEncounter's combination entries never carry a name field directly -- the UI genuinely must resolve entryId against the real bestiary");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("the encounter roster row shows name/HP/AC unexpanded, resolved from the real bestiary entry", async () => {
  await gotoTableMode(page, base, scene.id);

  const encounterItem = page.locator(`[data-testid="table-notes-encounters-item"][data-item-type="encounter"][data-item-id="${encounterId}"]`);
  await encounterItem.waitFor({ state: "visible", timeout: 15000 });

  const rosterRow = encounterItem.locator('[data-testid="table-encounter-roster-row"]');
  await rosterRow.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await rosterRow.count(), 1);
  assert.equal(await rosterRow.getAttribute("data-entry-id"), bestiaryEntry.id);

  assert.match((await rosterRow.locator('[data-testid="table-encounter-roster-name"]').textContent()) ?? "", /Nested Expand Ogre/);
  assert.match((await rosterRow.locator('[data-testid="table-encounter-roster-hp"]').textContent()) ?? "", /59/);
  assert.match((await rosterRow.locator('[data-testid="table-encounter-roster-ac"]').textContent()) ?? "", /11/);

  // Attacks/recharge abilities must NOT be visible before the nested expand.
  assert.equal(await rosterRow.locator('[data-testid="table-encounter-roster-detail"]').isVisible().catch(() => false), false, "the nested detail (attacks/recharge abilities) must not be visible before its own expand is clicked");
});

test("expanding the roster row reveals the real attacks and rechargeAbilities from the snapshotted rawFields", async () => {
  await gotoTableMode(page, base, scene.id);

  const encounterItem = page.locator(`[data-testid="table-notes-encounters-item"][data-item-type="encounter"][data-item-id="${encounterId}"]`);
  const rosterRow = encounterItem.locator('[data-testid="table-encounter-roster-row"]');
  await rosterRow.waitFor({ state: "visible", timeout: 15000 });

  await rosterRow.locator('[data-testid="table-encounter-roster-expand-btn"]').click();

  const detail = rosterRow.locator('[data-testid="table-encounter-roster-detail"]');
  await detail.waitFor({ state: "visible", timeout: 10000 });

  const attackEls = detail.locator('[data-testid="table-encounter-roster-attack"]');
  await attackEls.first().waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await attackEls.count(), 1);
  assert.match((await attackEls.first().textContent()) ?? "", /Greatclub/);
  assert.match((await attackEls.first().textContent()) ?? "", /2d8\+4/);

  const rechargeEls = detail.locator('[data-testid="table-encounter-roster-recharge-ability"]');
  assert.equal(await rechargeEls.count(), 1);
  assert.match((await rechargeEls.first().textContent()) ?? "", /Rock Throw/);
});
