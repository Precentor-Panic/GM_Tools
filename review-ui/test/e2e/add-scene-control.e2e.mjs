// Phase 26 task 26.0, REQUIRED SCENARIO 3 -- "'+Scene' renders at the
// bottom of every scene box in both views; insert-scene-control/insert-
// scene-picker no longer exist anywhere in either view (a real DOM-absence
// assertion, not just 'not tested')." Read phase26-fixture.mjs's header
// FIRST (§5 is this file's own section). EXPECTED TO FAIL right now --
// `add-scene-btn` doesn't exist yet, AND the absence assertions below will
// currently FAIL too (`insert-scene-control` is still very much present in
// the current, not-yet-reworked UI) -- both are the deliverable of this
// task, not a bug in this file. See scene-construction-insert-between
// .e2e.mjs's own updated header for why THAT file's old presence-asserting
// contract was rewritten rather than left silently contradictory.
//
// FIXTURE: a 3-scene straight-line chain (so this file can assert
// "+Scene" renders on EVERY box, not just one), matching scene-construction
// -chain-display.e2e.mjs's own established chain-fixture shape.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-addscene-");
const WORLD = "e2e-addscene-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "addscene-a", name: "Add-Scene Chain A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "addscene-b", name: "Add-Scene Chain B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "addscene-c", name: "Add-Scene Chain C", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "addscene-e0", sourceId: "addscene-a", targetId: "addscene-b", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "addscene-e1", sourceId: "addscene-b", targetId: "addscene-c", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "addscene-a" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "addscene-b" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "addscene-c" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("CONSTRUCTION VIEW: 'insert-scene-control'/'insert-scene-picker' are DOM-absent entirely, and 'add-scene-btn' is DOM-absent nowhere -- i.e. present for every expanded scene box", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 3, { timeout: 15000 });

  // Expand every scene so their bodies (and thus their own add-scene-btn)
  // are actually mounted, matching this suite's own established
  // lazy-body-load convention (buildChainItem's ensureBodyLoaded).
  const toggles = page.locator('[data-testid="scene-chain-toggle"]');
  const toggleCount = await toggles.count();
  for (let i = 0; i < toggleCount; i++) {
    const item = page.locator('[data-testid="scene-chain-item"]').nth(i);
    const isOpen = await item.evaluate((el) => el.open);
    if (!isOpen) await toggles.nth(i).click();
  }
  await page.waitForTimeout(300);

  const insertControlCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-control"]').length);
  const insertPickerCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-picker"]').length);
  assert.equal(insertControlCount, 0, "insert-scene-control must be COMPLETELY REMOVED from the construction view (§26.B) -- real DOM-absence, not just untested");
  assert.equal(insertPickerCount, 0, "insert-scene-picker must be COMPLETELY REMOVED from the construction view (§26.B)");

  for (const sceneId of [sceneA.id, sceneB.id, sceneC.id]) {
    const btn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${sceneId}"]`);
    assert.equal(await btn.count(), 1, `add-scene-btn must render exactly once for scene ${sceneId}'s own expanded box`);
  }
});

test("TABLE MODE: 'insert-scene-control'/'insert-scene-picker' are DOM-absent, and 'add-scene-btn' renders for the currently-displayed scene's own box", async () => {
  await page.goto(`${base}/#session-planner/${sceneB.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const insertControlCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-control"]').length);
  const insertPickerCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-picker"]').length);
  assert.equal(insertControlCount, 0, "insert-scene-control must be COMPLETELY REMOVED from Table Mode too -- 'anything equivalent already built in Table Mode' per plans/phase-26-tasks.md task 26.6");
  assert.equal(insertPickerCount, 0, "insert-scene-picker must be COMPLETELY REMOVED from Table Mode too");

  const addSceneBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${sceneB.id}"]`);
  await addSceneBtn.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await addSceneBtn.count(), 1, "add-scene-btn must render for Table Mode's own currently-displayed scene");
});

test("clicking add-scene-btn opens the SAME add-scene-panel shape in both views (no separate/duplicate mechanism per view)", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 3, { timeout: 15000 });
  const cvBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${sceneA.id}"]`);
  await cvBtn.waitFor({ state: "visible", timeout: 10000 });
  await cvBtn.click();
  const cvPanel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${sceneA.id}"]`);
  await cvPanel.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await cvPanel.locator('[data-testid="add-scene-place-step"]').count(), 1, "construction view's add-scene-panel must render the shared place-step");

  await page.goto(`${base}/#session-planner/${sceneA.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });
  const tmBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${sceneA.id}"]`);
  await tmBtn.waitFor({ state: "visible", timeout: 10000 });
  await tmBtn.click();
  const tmPanel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${sceneA.id}"]`);
  await tmPanel.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await tmPanel.locator('[data-testid="add-scene-place-step"]').count(), 1, "Table Mode's add-scene-panel must render the SAME shared place-step shape -- one mechanism, not two");
});
