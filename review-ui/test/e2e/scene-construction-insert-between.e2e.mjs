// Phase 23 task 23.0, REQUIRED SCENARIOS 3 + 4 -- "'+' between scenes --
// real place: inserting an existing place entity as a new scene between two
// others" and "'+' between scenes -- transit/path: inserting a transit
// scene calls the real transit-entity route, committing a real entity
// (assert via the actual store, not just a UI state check) -- confirm the
// created entity's type is 'place' with attributes.isTransit === true."
// Read scene-construction-fixture.mjs's header first (§3 is this file's own
// section). EXPECTED TO FAIL right now with a Playwright selector-not-found/
// timeout error -- none of this DOM exists yet. That failure is the
// deliverable of this task, not a bug in this file.
//
// FIXTURE: two scenes, anchored to two DISCONNECTED place entities
// ("insbtw-start", "insbtw-end" -- no edge between them at all, deliberately,
// so this file's real-place-insertion test can add a genuinely-new place in
// between without that place needing to already be graph-adjacent to
// anything -- adjacency is not this file's concern, transit-entity.mjs/
// scene-membership.mjs's own already-shipped Phase 22 tests own that). A
// separate real "insbtw-existing-place" entity exists in the graph for the
// real-place insertion path to pick.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-insbtw-");
const WORLD = "e2e-scconstruct-insbtw-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "insbtw-start", name: "Insert-Between Start", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "insbtw-end", name: "Insert-Between End", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "insbtw-existing-place", name: "Insert-Between Waystop", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let sceneStart, sceneEnd;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneStart = await createSceneViaRoute(base, WORLD, { locationEntityId: "insbtw-start" });
  sceneEnd = await createSceneViaRoute(base, WORLD, { locationEntityId: "insbtw-end" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("real-place path: picking an existing place inserts a new scene chain-item between the two scenes", async () => {
  await page.goto(`${base}/#session-planner/${sceneStart.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 15000 });

  const control = page.locator(`[data-testid="insert-scene-control"][data-after-scene-id="${sceneStart.id}"]`);
  await control.waitFor({ state: "visible", timeout: 10000 });
  await control.click();

  const picker = page.locator(`[data-testid="insert-scene-picker"][data-after-scene-id="${sceneStart.id}"]`);
  await picker.waitFor({ state: "visible", timeout: 5000 });

  const placeInput = picker.locator('[data-testid="insert-scene-place-input"]');
  await placeInput.fill("Insert-Between Waystop");
  const option = picker.locator('[data-testid="insert-scene-place-option"][data-entity-id="insbtw-existing-place"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 3, { timeout: 10000 });
  }, "picking a real place must insert exactly one new scene chain-item");

  const items = page.locator('[data-testid="scene-chain-item"]');
  const orderedIds = await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.equal(orderedIds[0], sceneStart.id);
  assert.equal(orderedIds[2], sceneEnd.id);
  const newSceneId = orderedIds[1];
  assert.notEqual(newSceneId, sceneStart.id);
  assert.notEqual(newSceneId, sceneEnd.id);

  // Confirm via the real store, not just UI state: the new scene really is
  // anchored to insbtw-existing-place.
  const brief = await (await fetch(`${base}/api/session-planner/brief?world=${WORLD}&sceneId=${newSceneId}`)).json();
  const anchorLoc = (brief.brief?.locations ?? []).find((l) => l.distance === 0);
  assert.equal(anchorLoc?.entityId, "insbtw-existing-place", "the newly-inserted scene must be anchored to the picked real place entity");
});

test("transit/path path: creates a real committed entity via the real transit-entity route (type:\"place\", attributes.isTransit===true), and inserts a new scene anchored to it", async () => {
  await page.goto(`${base}/#session-planner/${sceneStart.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length >= 2, { timeout: 15000 });

  const control = page.locator(`[data-testid="insert-scene-control"][data-after-scene-id="${sceneEnd.id}"]`);
  await control.waitFor({ state: "visible", timeout: 10000 });
  await control.click();

  const picker = page.locator(`[data-testid="insert-scene-picker"][data-after-scene-id="${sceneEnd.id}"]`);
  await picker.waitFor({ state: "visible", timeout: 5000 });

  const beforeCount = await page.locator('[data-testid="scene-chain-item"]').count();

  // Leave the name field blank -- transit-entity.mjs's own established
  // default-naming allowance ("stay exactly as generic as 'Path'
  // indefinitely").
  const submitBtn = picker.locator('[data-testid="insert-scene-transit-submit-btn"]');
  await submitBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="scene-chain-item"]').length === expected,
      beforeCount + 1,
      { timeout: 10000 }
    );
  }, "submitting the transit path must insert exactly one new scene chain-item");

  const items = page.locator('[data-testid="scene-chain-item"]');
  const orderedIds = await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  const newSceneId = orderedIds.find((id) => id !== sceneStart.id && id !== sceneEnd.id);
  assert.ok(newSceneId, "a new scene id must appear in the chain");

  const brief = await (await fetch(`${base}/api/session-planner/brief?world=${WORLD}&sceneId=${newSceneId}`)).json();
  const anchorLoc = (brief.brief?.locations ?? []).find((l) => l.distance === 0);
  const transitEntityId = anchorLoc?.entityId;
  assert.ok(transitEntityId, "the newly-inserted transit scene must have a real anchor entity id");
  assert.notEqual(transitEntityId, "insbtw-start");
  assert.notEqual(transitEntityId, "insbtw-end");

  // ASSERT VIA THE ACTUAL STORE (not just a UI state check), per this
  // scenario's own explicit requirement: reload the real snapshot from disk
  // via the real snapshot.mjs loader and inspect the committed entity
  // directly.
  const { snapshot } = loadSnapshot(dataDir, WORLD);
  const transitEntity = snapshot.entities.find((e) => e.id === transitEntityId);
  assert.ok(transitEntity, "the transit entity must be a REAL committed entity in the live snapshot, not UI-only state");
  assert.equal(transitEntity.type, "place", "a transit entity must commit as type:\"place\" -- no new entity-type enum value (plans/phase-21-review.md §12)");
  assert.equal(transitEntity.attributes?.isTransit, true, "a transit entity must carry attributes.isTransit === true, the pinned Phase 22 distinguishing field");
});
