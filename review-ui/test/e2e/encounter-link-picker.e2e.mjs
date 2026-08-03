// Phase 27 task 27.0 -- "Encounter-link picker" (F11, SHARED REFERENCE).
// Read phase27-fixture.mjs's header FIRST (§4 is this file's own section).
// EXPECTED TO FAIL right now: `GET /api/scene-planning/encounters?world=`
// doesn't exist yet, `POST .../encounters/:encounterId/attach` doesn't
// exist yet (combat-planning/saved-encounter.mjs has no `sceneIds`/
// `attachEncounterToScene`/`listEncountersForWorld`, confirmed fresh
// against the real file -- still the single-`sceneId` shape), and clicking
// `add-encounter-btn` still navigates INSTANTLY to the builder today
// (mountAddEncounterControl, confirmed live) rather than opening a picker
// panel -- so `add-encounter-panel` never appears. All of that is the
// deliverable of this task, not a bug in this file.
//
// Asserts the SHARED-REFERENCE data model directly (not a copy): attaching
// an already-built encounter to a second scene must make it appear in BOTH
// scenes' own saved-encounters-list, and detaching from one scene must
// never affect the other.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase27Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  saveEncounterViaRoute,
  listEncountersForSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase27-fixture.mjs";

const { scratchDir, dataDir } = setupPhase27Env("gm-tools-e2e-enclinkpicker-");
const WORLD = "e2e-enclinkpicker-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "enclinkpicker-origin", name: "Encounter-Link Origin Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "enclinkpicker-second", name: "Encounter-Link Second Anchor", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let originScene, secondScene, encounter;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  originScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "enclinkpicker-origin" });
  secondScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "enclinkpicker-second" });

  encounter = await saveEncounterViaRoute(base, WORLD, originScene.id, {
    name: "Encounter-Link Picker Goblin Ambush",
    combination: [{ entryId: "goblin", count: 3 }],
    knobs: { difficultyTier: "medium" },
    scoreSnapshot: { expectedScore: 10, burstCeiling: 20, snowballDelta: {}, asymmetricRiskFlag: false }
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

test("ROUTE LEVEL: GET /api/scene-planning/encounters?world= lists the world's saved encounters (the picker's own feed)", async () => {
  const res = await fetch(`${base}/api/scene-planning/encounters?world=${WORLD}`);
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body.encounters), "must return an encounters array");
  assert.ok(body.encounters.some((e) => e.id === encounter.id), "the world's own saved encounter must appear in the world-scoped list");
});

test("UI: add-encounter opens a picker over the world's saved encounters; selecting one attaches the SAME shared definition to a second scene (appears in BOTH rosters, not a copy)", async () => {
  await page.goto(`${base}/#session-planner/${secondScene.id}`);
  const actionsBar = page.locator(`[data-testid="scene-actions-bar"][data-scene-id="${secondScene.id}"]`);
  await actionsBar.waitFor({ state: "visible", timeout: 15000 });

  const addEncounterBtn = actionsBar.locator('[data-testid="add-encounter-btn"]');
  await addEncounterBtn.waitFor({ state: "visible", timeout: 5000 });
  await addEncounterBtn.click();

  const panel = page.locator(`[data-testid="add-encounter-panel"][data-scene-id="${secondScene.id}"]`);
  await assert.doesNotReject(async () => {
    await panel.waitFor({ state: "visible", timeout: 5000 });
  }, "clicking add-encounter-btn must open a picker panel, not navigate instantly (F11)");

  // Must NOT have navigated away yet.
  const hashAfterOpen = await page.evaluate(() => location.hash);
  assert.notEqual(hashAfterOpen, `#combat-planning/${secondScene.id}`, "opening the picker panel must not itself navigate to the Encounter Builder");

  const pickerItem = panel.locator(`[data-testid="add-encounter-picker-item"][data-encounter-id="${encounter.id}"]`);
  await pickerItem.waitFor({ state: "visible", timeout: 10000 });
  await pickerItem.locator('[data-testid="add-encounter-picker-select-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="saved-encounters-list"][data-scene-id="${id}"] [data-testid="saved-encounter-item"]`) !== null,
      secondScene.id,
      { timeout: 10000 }
    );
  }, "attaching the picked encounter must add it to THIS scene's own saved-encounters-list");

  // SHARED REFERENCE, not a copy: same encounter id in BOTH rosters, and the
  // real store confirms it via the SAME encounterId, not a re-saved clone.
  const secondSceneEncounters = await listEncountersForSceneViaRoute(base, WORLD, secondScene.id);
  const originSceneEncounters = await listEncountersForSceneViaRoute(base, WORLD, originScene.id);
  assert.ok(secondSceneEncounters.some((e) => e.id === encounter.id), "the second scene's roster must contain the SAME encounter id");
  assert.ok(originSceneEncounters.some((e) => e.id === encounter.id), "the ORIGIN scene's roster must STILL contain it too -- shared reference, not moved");
  assert.equal(secondSceneEncounters.length, 1, "attaching must not create a duplicate/second record for the second scene");
});

test("UI: roster remove DETACHES only -- the shared definition survives in the other scene", async () => {
  await page.goto(`${base}/#session-planner/${secondScene.id}`);
  const savedList = page.locator(`[data-testid="saved-encounters-list"][data-scene-id="${secondScene.id}"]`);
  const item = savedList.locator(`[data-testid="saved-encounter-item"][data-encounter-id="${encounter.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.locator('[data-testid="saved-encounter-remove-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sceneId) => document.querySelectorAll(`[data-testid="saved-encounters-list"][data-scene-id="${sceneId}"] [data-testid="saved-encounter-item"]`).length === 0,
      secondScene.id,
      { timeout: 10000 }
    );
  }, "removing from this scene's roster must clear it from this scene's own list");

  const secondSceneEncounters = await listEncountersForSceneViaRoute(base, WORLD, secondScene.id);
  const originSceneEncounters = await listEncountersForSceneViaRoute(base, WORLD, originScene.id);
  assert.ok(!secondSceneEncounters.some((e) => e.id === encounter.id), "detaching must genuinely remove the second scene's own membership");
  assert.ok(originSceneEncounters.some((e) => e.id === encounter.id), "detaching from ONE scene must never delete the shared definition -- the origin scene's roster must still show it");

  const defRes = await fetch(`${base}/api/scene-planning/encounters?world=${WORLD}`);
  const defBody = await defRes.json();
  assert.ok(defBody.encounters.some((e) => e.id === encounter.id), "the encounter DEFINITION itself must still exist in the world's own list after a detach, per the orphan-safe semantics (27.2)");
});

test("UI: the 'open Encounter Builder' button still preserves the original navigate-to-builder behavior", async () => {
  await page.goto(`${base}/#session-planner/${originScene.id}`);
  const actionsBar = page.locator(`[data-testid="scene-actions-bar"][data-scene-id="${originScene.id}"]`);
  await actionsBar.waitFor({ state: "visible", timeout: 15000 });
  await actionsBar.locator('[data-testid="add-encounter-btn"]').click();

  const panel = page.locator(`[data-testid="add-encounter-panel"][data-scene-id="${originScene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="add-encounter-open-builder-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => location.hash === `#combat-planning/${id}`,
      originScene.id,
      { timeout: 5000 }
    );
  }, "the open-builder button must still navigate to #combat-planning/<sceneId>, exactly as add-encounter used to do instantly");
});
