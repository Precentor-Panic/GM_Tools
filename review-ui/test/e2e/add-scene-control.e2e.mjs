// Phase 26 task 26.0, REQUIRED SCENARIO 3 -- "'+Scene' renders at the
// bottom of every scene box in both views; insert-scene-control/insert-
// scene-picker no longer exist anywhere in either view (a real DOM-absence
// assertion, not just 'not tested')." Read phase26-fixture.mjs's header
// FIRST (§5 is this file's own section).
//
// ***UPDATED by Phase 27 task 27.0*** (F6: "+Scene" moves from a PER-SCENE
// control to a single PLAN-LEVEL control in the construction view -- see
// phase27-fixture.mjs's header for the full routing/testid contract). Table
// Mode is UNCHANGED (F6 only targets the construction/session-planner view,
// per plans/phase-27-tasks.md's own scope) -- Table Mode's own per-current-
// scene `add-scene-btn`/`add-scene-panel` (buildAddSceneControl, still
// mounted the SAME way inside buildTableActionsBar) is untouched, so this
// file's Table Mode scenarios below are UNCHANGED. Only the CONSTRUCTION
// VIEW scenarios are rewritten: the per-scene `add-scene-btn` this file
// used to assert on EVERY expanded scene box is now asserted ABSENT
// (real DOM-absence, not merely "not tested"), replaced by exactly ONE
// top-level `plan-add-scene-btn`/`plan-add-scene-panel`. EXPECTED TO FAIL
// right now -- the CURRENT code still mounts a per-scene `add-scene-btn`
// inside buildSceneBodyInto in the construction view (confirmed fresh
// against the real session-planner-view.js), so the absence assertion
// below currently fails, and `plan-add-scene-btn` doesn't exist at all yet.
// Both are the deliverable of this task, not a bug in this file.
//
// FIXTURE: a 3-scene straight-line chain (so this file can assert the
// construction view's per-scene add-scene-btn absence across every box, not
// just one), matching scene-construction-chain-display.e2e.mjs's own
// established chain-fixture shape.
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

test("CONSTRUCTION VIEW: 'insert-scene-control'/'insert-scene-picker' are DOM-absent entirely, and the per-scene 'add-scene-btn' is ALSO DOM-absent everywhere (Phase 27, F6) -- replaced by exactly ONE top-level plan-add-scene-btn", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 3, { timeout: 15000 });

  // Expand every scene so their bodies are actually mounted, matching this
  // suite's own established lazy-body-load convention (buildChainItem's
  // ensureBodyLoaded).
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

  // Phase 27, F6: the per-scene add-scene-btn is retired too -- "+Scene"
  // moves to the plan level, a SINGLE control, not one per scene box.
  for (const sceneId of [sceneA.id, sceneB.id, sceneC.id]) {
    const perSceneBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${sceneId}"]`);
    assert.equal(await perSceneBtn.count(), 0, `add-scene-btn must NOT render per-scene any more (scene ${sceneId}) -- retired in favor of the plan-level control (F6)`);
  }
  assert.equal(await page.locator('[data-testid="plan-add-scene-btn"]').count(), 1, "exactly ONE plan-level +Scene control must render, top-level, not scoped to any one scene box");
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

test("clicking +Scene opens the shared place-required-flow shape in both views (construction view: the new plan-level control; Table Mode: its own unchanged per-scene control)", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 3, { timeout: 15000 });
  // Phase 27: the construction view's own "+Scene" is now the single
  // top-level plan-add-scene-btn, not a per-scene add-scene-btn.
  const cvBtn = page.locator('[data-testid="plan-add-scene-btn"]');
  await cvBtn.waitFor({ state: "visible", timeout: 10000 });
  await cvBtn.click();
  const cvPanel = page.locator('[data-testid="plan-add-scene-panel"]');
  await cvPanel.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await cvPanel.locator('[data-testid="plan-add-scene-place-step"]').count(), 1, "construction view's plan-add-scene-panel must render the shared place-step");

  await page.goto(`${base}/#session-planner/${sceneA.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });
  const tmBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${sceneA.id}"]`);
  await tmBtn.waitFor({ state: "visible", timeout: 10000 });
  await tmBtn.click();
  const tmPanel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${sceneA.id}"]`);
  await tmPanel.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await tmPanel.locator('[data-testid="add-scene-place-step"]').count(), 1, "Table Mode's add-scene-panel must render the SAME shared place-step shape -- one mechanism, not two");
});
