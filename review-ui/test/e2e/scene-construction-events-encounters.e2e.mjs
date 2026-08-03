// Phase 23 task 23.0, REQUIRED SCENARIOS 7 + 8 -- "Add Event / Add
// Encounter, equal visual weight: a real bounding-box/prominence comparison
// ... proving neither is visually de-emphasized relative to the other" and
// "Add Encounter round-trips through the real addendum routes: saving an
// encounter to a scene, confirming it's listed via GET .../encounters,
// removing it via DELETE." Read scene-construction-fixture.mjs's header
// first (§6/§7 are this file's own sections).
//
// ***UPDATED by Phase 27 task 27.0*** (F11: `add-encounter-btn` no longer
// navigates to the Encounter Builder INSTANTLY -- it now opens a picker
// panel first, per phase27-fixture.mjs's header §4 and the new
// encounter-link-picker.e2e.mjs. The first test below (equal visual weight)
// is UNCHANGED -- add-encounter-btn still renders as a real, equal-weight
// sibling button; only the SECOND test's click-through is updated: it must
// now open `add-encounter-panel` first, then click the panel's own
// `add-encounter-open-builder-btn` to reach the SAME builder navigation the
// old instant-click used to do directly. EXPECTED TO FAIL right now:
// clicking add-encounter-btn still navigates instantly today (confirmed
// fresh against the real mountAddEncounterControl), so `add-encounter-
// panel` never appears and this test's own updated waitFor times out. That
// failure is the deliverable of this task, not a bug in this file.
//
// The bounding-box comparison follows this project's established real-
// measurement convention (combat-planning-confidence-format.e2e.mjs's own
// `.boundingBox()` use, cited in this suite's shared header) -- not a
// visual-impression assertion.
//
// Scenario 8's working roster is built via the REAL, deterministic,
// zero-LLM-call `[data-testid="difficulty-tier"][data-tier="medium"]`
// auto-fill path (combat-planning-view.js's own established themeText-blank
// convention, confirmed live -- see combat-planning-loading-scope.e2e.mjs's
// own identical use) -- no LLM mocking needed anywhere in this file, this
// scenario exercises only real, already-shipped routes end to end.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-evtenc-");
const WORLD = "e2e-scconstruct-evtenc-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../../combat-planning/party-roster-store.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "evtenc-anchor", name: "Event Encounter Anchor", type: "place", importance: 0.5 } }
]);

const entry = saveBestiaryEntry({
  rawFields: {
    name: "Scene-Construction Goblin",
    type: "humanoid",
    challengeRating: "1/4",
    hp: 7,
    ac: 15,
    attacks: [{ name: "Scimitar", toHitBonus: 4, damageDice: "1d6+2", damageType: "slashing" }]
  },
  derivedScore: null
});
acceptBestiaryEntry(entry.id);
savePartyMember(WORLD, {
  name: "Scene-Construction PC",
  combatRelevant: { class: "Fighter", level: 5, ac: 16, hp: 40, damagePerRoundEstimate: 16 },
  buildRelevant: {}
});

let server, base, browser, page;
let scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "evtenc-anchor" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("Add Event and Add Encounter carry genuinely equal visual weight -- same bounding-box size, same parent, both reachable with zero extra clicks", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const actionsBar = page.locator(`[data-testid="scene-actions-bar"][data-scene-id="${scene.id}"]`);
  await actionsBar.waitFor({ state: "visible", timeout: 15000 });

  const addEventBtn = actionsBar.locator('[data-testid="add-event-btn"]');
  const addEncounterBtn = actionsBar.locator('[data-testid="add-encounter-btn"]');
  await addEventBtn.waitFor({ state: "visible", timeout: 5000 });
  await addEncounterBtn.waitFor({ state: "visible", timeout: 5000 });

  // Same parent -- neither is nested inside a disclosure/accordion the
  // other isn't also inside.
  const [eventParentHandle, encounterParentHandle] = await Promise.all([
    addEventBtn.evaluateHandle((el) => el.parentElement),
    addEncounterBtn.evaluateHandle((el) => el.parentElement)
  ]);
  assert.equal(await page.evaluate(([a, b]) => a === b, [eventParentHandle, encounterParentHandle]), true, "Add Event and Add Encounter must be DOM siblings under the same parent -- neither may be tucked behind an extra disclosure level the other isn't also behind");

  const [eventBox, encounterBox] = await Promise.all([addEventBtn.boundingBox(), addEncounterBtn.boundingBox()]);
  assert.ok(eventBox, "Add Event must have a real, measurable bounding box (not display:none/collapsed)");
  assert.ok(encounterBox, "Add Encounter must have a real, measurable bounding box (not display:none/collapsed)");

  assert.ok(
    Math.abs(eventBox.width - encounterBox.width) <= 2,
    `Add Event (width ${eventBox.width}) and Add Encounter (width ${encounterBox.width}) must render at equal width (within 2px) -- neither may be visually de-emphasized`
  );
  assert.ok(
    Math.abs(eventBox.height - encounterBox.height) <= 2,
    `Add Event (height ${eventBox.height}) and Add Encounter (height ${encounterBox.height}) must render at equal height (within 2px)`
  );

  // Same font-size/styling tier -- a real computed-style comparison, not
  // just "both exist."
  const [eventFontSize, encounterFontSize] = await Promise.all([
    addEventBtn.evaluate((el) => getComputedStyle(el).fontSize),
    addEncounterBtn.evaluate((el) => getComputedStyle(el).fontSize)
  ]);
  assert.equal(eventFontSize, encounterFontSize, "Add Event and Add Encounter must share the same computed font-size -- no visual de-emphasis via smaller text");
});

test("Add Encounter round-trips through the real addendum routes: save, list, remove", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const addEncounterBtn = page.locator(`[data-testid="scene-actions-bar"][data-scene-id="${scene.id}"] [data-testid="add-encounter-btn"]`);
  await addEncounterBtn.waitFor({ state: "visible", timeout: 15000 });
  await addEncounterBtn.click();

  // Phase 27 (F11): clicking add-encounter-btn now opens a picker panel
  // first (offering an existing-encounter picker OR "open builder") --
  // the open-builder button preserves the OLD instant-navigate behavior.
  const panel = page.locator(`[data-testid="add-encounter-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="add-encounter-open-builder-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#combat-planning/${expected}`,
      scene.id,
      { timeout: 5000 }
    );
  }, "the open-builder button must navigate to #combat-planning/<sceneId>, a return-context-aware Encounter Builder");
  await page.locator("#view-combat-planning.active").waitFor({ state: "attached", timeout: 5000 });

  const saveBtn = page.locator('[data-testid="save-encounter-to-scene-btn"]');
  await saveBtn.waitFor({ state: "visible", timeout: 10000 });

  // Build a real, deterministic (zero-LLM-call) working roster via the
  // difficulty-tier auto-fill path.
  await page.locator('[data-testid="score-band"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="difficulty-tier"][data-tier="medium"]').click();
  await page.locator('[data-testid="working-combatant-row"]').first().waitFor({ state: "visible", timeout: 10000 });

  await saveBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}`,
      scene.id,
      { timeout: 10000 }
    );
  }, "saving an encounter must navigate back to #session-planner/<sceneId>");

  const savedList = page.locator(`[data-testid="saved-encounters-list"][data-scene-id="${scene.id}"]`);
  await savedList.waitFor({ state: "visible", timeout: 10000 });
  const savedItem = savedList.locator('[data-testid="saved-encounter-item"]');
  await savedItem.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await savedItem.count(), 1);
  const encounterId = await savedItem.getAttribute("data-encounter-id");
  assert.ok(encounterId, "the saved encounter item must carry a real data-encounter-id");

  // Confirm via the real GET route too, not just UI state.
  const listRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/encounters?world=${WORLD}`);
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(listBody.encounters.length, 1, "the real GET .../encounters route must list exactly the one saved encounter");
  assert.equal(listBody.encounters[0].id, encounterId);
  assert.ok(listBody.encounters[0].combination.length > 0, "the saved encounter must carry a real, non-empty combination snapshot");

  // Remove it via the UI, wired to the real DELETE route.
  await savedItem.locator('[data-testid="saved-encounter-remove-btn"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      '[data-testid="saved-encounter-item"]',
      { timeout: 10000 }
    );
  }, "removing the saved encounter must clear it from the list");

  const listRes2 = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/encounters?world=${WORLD}`);
  const listBody2 = await listRes2.json();
  assert.equal(listBody2.encounters.length, 0, "the real GET .../encounters route must confirm zero remaining encounters after the DELETE round trip");
});
