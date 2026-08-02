// Phase 25 task 25.0, REQUIRED SCENARIOS 10 + 11 -- "Bottom actions bar
// equal weight: real boundingBox() comparison, matching this project's
// established measurement convention (Phase 15/23's own precedent) -- Add
// Event and Add Encounter stay equal-weight in Table Mode too, not just in
// the construction view" and "Responsive: a viewport-sized test confirming
// the top strip AND the nav zone (adjacent-scenes strip + search) both stay
// reachable without scrolling on a phone-sized viewport, per §3a's
// requirement that navigation never becomes a scroll-and-hunt fallback."
// Read table-mode-fixture.mjs's header FIRST (§6/§7 are this file's own
// sections). EXPECTED TO FAIL right now -- none of `table-actions-bar`/
// `table-add-event-btn`/`table-add-encounter-btn`/`table-top-strip`/
// `table-nav-zone` exists yet. That failure is the deliverable of this
// task, not a bug in this file.
//
// The bounding-box comparison follows the SAME real-measurement convention
// scene-construction-events-encounters.e2e.mjs's own equal-weight test
// already established (itself citing combat-planning-confidence-format
// .e2e.mjs's `.boundingBox()` use) -- not a visual-impression assertion.
//
// FIXTURE (shared by both scenarios): an anchor with 2 satellites (roster
// content), one note, and one saved encounter with a real bestiary entry --
// enough real content that the phone-viewport page genuinely exceeds the
// 844px viewport height (confirmed by this file's own assertion that the
// page's scrollHeight is greater than its clientHeight), so scenario 11's
// "reachable without scrolling" claim is meaningful rather than trivially
// true on an already-short page.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoTableMode,
  tableModeHash,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-actionsresp-");
const WORLD = "e2e-tablemode-actionsresp-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmar-anchor", name: "Actions Responsive Anchor", type: "place", importance: 0.5, description: "Anchor description text long enough to take real vertical space in the roster row.", summary: "Anchor summary text." } },
  { op: "upsert_entity", data: { id: "tmar-sat1", name: "Actions Responsive Satellite One", type: "person", importance: 0.5, description: "Satellite one description text, also real content, not a stub.", summary: "Satellite one summary." } },
  { op: "upsert_entity", data: { id: "tmar-sat2", name: "Actions Responsive Satellite Two", type: "person", importance: 0.5, description: "Satellite two description text, also real content, not a stub.", summary: "Satellite two summary." } },
  { op: "upsert_edge", data: { id: "tmar-e0", sourceId: "tmar-anchor", targetId: "tmar-sat1", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "tmar-e1", sourceId: "tmar-anchor", targetId: "tmar-sat2", relationshipType: "unspecified" } }
]);

const bestiaryEntry = saveBestiaryEntry({
  rawFields: { name: "Responsive Fixture Bandit", type: "humanoid", hp: 11, ac: 12, attacks: [{ name: "Scimitar", toHitBonus: 3, damageDice: "1d6+1", damageType: "slashing" }] },
  derivedScore: null
});
acceptBestiaryEntry(bestiaryEntry.id);

let server, base, browser, page;
let scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmar-anchor" });

  await fetch(`${base}/api/session-planner/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, text: "A real note attached to this scene for the responsive/actions fixture.", anchorEntityId: "tmar-anchor", sceneId: scene.id })
  });
  await fetch(`${base}/api/scene-planning/scenes/${scene.id}/encounters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: WORLD, name: "Responsive Fixture Encounter",
      combination: [{ entryId: bestiaryEntry.id, count: 1 }], knobs: {},
      scoreSnapshot: { expectedScore: 1, burstCeiling: 1, snowballDelta: {}, asymmetricRiskFlag: false }
    })
  });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("Add Event and Add Encounter carry genuinely equal visual weight in Table Mode's bottom actions bar", async () => {
  await gotoTableMode(page, base, scene.id);

  const actionsBar = page.locator(`[data-testid="table-actions-bar"][data-scene-id="${scene.id}"]`);
  await actionsBar.waitFor({ state: "visible", timeout: 15000 });

  const addEventBtn = actionsBar.locator('[data-testid="table-add-event-btn"]');
  const addEncounterBtn = actionsBar.locator('[data-testid="table-add-encounter-btn"]');
  await addEventBtn.waitFor({ state: "visible", timeout: 5000 });
  await addEncounterBtn.waitFor({ state: "visible", timeout: 5000 });

  const [eventParentHandle, encounterParentHandle] = await Promise.all([
    addEventBtn.evaluateHandle((el) => el.parentElement),
    addEncounterBtn.evaluateHandle((el) => el.parentElement)
  ]);
  assert.equal(
    await page.evaluate(([a, b]) => a === b, [eventParentHandle, encounterParentHandle]),
    true,
    "Add Event and Add Encounter must be DOM siblings under the same parent in Table Mode too -- neither may be tucked behind an extra disclosure level the other isn't also behind"
  );

  const [eventBox, encounterBox] = await Promise.all([addEventBtn.boundingBox(), addEncounterBtn.boundingBox()]);
  assert.ok(eventBox, "Add Event must have a real, measurable bounding box (not display:none/collapsed)");
  assert.ok(encounterBox, "Add Encounter must have a real, measurable bounding box (not display:none/collapsed)");

  assert.ok(
    Math.abs(eventBox.width - encounterBox.width) <= 2,
    `Add Event (width ${eventBox.width}) and Add Encounter (width ${encounterBox.width}) must render at equal width (within 2px) in Table Mode`
  );
  assert.ok(
    Math.abs(eventBox.height - encounterBox.height) <= 2,
    `Add Event (height ${eventBox.height}) and Add Encounter (height ${encounterBox.height}) must render at equal height (within 2px) in Table Mode`
  );

  const [eventFontSize, encounterFontSize] = await Promise.all([
    addEventBtn.evaluate((el) => getComputedStyle(el).fontSize),
    addEncounterBtn.evaluate((el) => getComputedStyle(el).fontSize)
  ]);
  assert.equal(eventFontSize, encounterFontSize, "Add Event and Add Encounter must share the same computed font-size in Table Mode -- no visual de-emphasis via smaller text");
});

test("on a phone-sized viewport, the top strip and the nav zone (adjacent strip + search) are both reachable with zero scrolling", async () => {
  const context = await browser.newContext({ viewport: IPHONE_13_VIEWPORT });
  const mobilePage = await context.newPage();
  await mobilePage.goto(`${base}/#queue`);
  await mobilePage.evaluate((w) => localStorage.setItem("gmReview.world", w), WORLD);

  await mobilePage.goto(`${base}/#${tableModeHash(scene.id)}`);

  const topStrip = mobilePage.locator('[data-testid="table-top-strip"]');
  const searchInput = mobilePage.locator('[data-testid="table-nav-search-input"]');
  const adjacentStrip = mobilePage.locator('[data-testid="table-adjacent-strip"]');
  await topStrip.waitFor({ state: "visible", timeout: 15000 });
  await searchInput.waitFor({ state: "visible", timeout: 10000 });
  await adjacentStrip.waitFor({ state: "visible", timeout: 10000 });

  // Confirm this fixture's page genuinely needs scrolling for its LOWER
  // content -- otherwise "reachable without scrolling" would be trivially
  // true on an already-short page and this test would prove nothing.
  const needsScroll = await mobilePage.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);
  assert.equal(needsScroll, true, "sanity: this fixture's Table Mode page must be genuinely taller than the phone viewport, or the 'no scrolling needed' assertion below is meaningless");

  const scrollYAtLoad = await mobilePage.evaluate(() => window.scrollY);
  assert.equal(scrollYAtLoad, 0, "sanity: page must load at scroll position 0 for this assertion to mean 'without scrolling'");

  for (const [name, locator] of [["table-top-strip", topStrip], ["table-nav-search-input", searchInput], ["table-adjacent-strip", adjacentStrip]]) {
    const box = await locator.boundingBox();
    assert.ok(box, `${name} must have a real, measurable bounding box on the phone viewport`);
    assert.ok(box.y >= 0, `${name}'s top edge (y=${box.y}) must be at or below the top of the viewport`);
    assert.ok(box.y + box.height <= IPHONE_13_VIEWPORT.height, `${name}'s bottom edge (${box.y + box.height}) must be within the ${IPHONE_13_VIEWPORT.height}px-tall viewport -- reachable with zero scrolling`);
  }

  await context.close();
});
