// ***SUPERSEDED by Phase 26 task 26.0*** (plans/phase-26-tasks.md §26.B/
// task 26.6). This file ORIGINALLY (Phase 23 task 23.0) asserted that
// "+ Insert Scene Here" (`insert-scene-control`/`insert-scene-picker`,
// `buildInsertSceneControl`) let a DM insert a scene between two arbitrary
// chain positions. Phase 26's grounding (§26.B) found this mechanism itself
// was the direct cause of real reported confusion ("are all the nodes you
// listed with + add scene here between them actually adjacent?") and
// REMOVES it entirely, replacing it with a single "+Scene" action living at
// the bottom of every scene's own box (add-scene-control.e2e.mjs's own new
// contract, per phase26-fixture.mjs's header §5).
//
// This file's ORIGINAL assertions (that inserting via insert-scene-control
// works, both real-place and transit-entity paths) are now WRONG under the
// new contract -- rewritten here to assert the mechanism's ABSENCE instead,
// per plans/phase-26-tasks.md's own explicit instruction ("its old
// assertions about insert-scene-control existing are now wrong and need
// updating, not left as silently-contradictory frozen tests"). The
// transit-entity real-route coverage this file used to provide is NOT lost
// -- it lives on via add-scene-control.e2e.mjs's/scene-creation-place-
// required.e2e.mjs's own new-place-creation assertions (transit-entity
// creation itself, session-planner/transit-entity.mjs, is UNCHANGED by
// Phase 26 -- only the UI trigger for reaching a "new place" changed).
//
// EXPECTED TO FAIL right now: `insert-scene-control` is still very much
// present in the current, not-yet-reworked UI (Phase 23's real, live,
// unmodified implementation) -- these DOM-absence assertions will currently
// FAIL for that reason. That failure is the deliverable of this task, not a
// bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-insbtw-");
const WORLD = "e2e-scconstruct-insbtw-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "insbtw-start", name: "Insert-Between Start", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "insbtw-end", name: "Insert-Between End", type: "place", importance: 0.5 } }
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

test("***Phase 26 fix***: insert-scene-control/insert-scene-picker are DOM-absent -- the confusing 'between two arbitrary chain positions' mechanism no longer exists anywhere in the construction view", async () => {
  await page.goto(`${base}/#session-planner/${sceneStart.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 15000 });

  const controlCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-control"]').length);
  const pickerCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-picker"]').length);
  assert.equal(controlCount, 0, "insert-scene-control must be COMPLETELY REMOVED per §26.B -- see add-scene-control.e2e.mjs for the replacement '+Scene' contract");
  assert.equal(pickerCount, 0, "insert-scene-picker must be COMPLETELY REMOVED per §26.B");

  const transitInputCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-transit-name-input"], [data-testid="insert-scene-transit-submit-btn"]').length);
  assert.equal(transitInputCount, 0, "the old transit-entity UI trigger tied to insert-scene-picker must also be gone (transit-entity.mjs's own real route is unaffected and still reachable via the new '+Scene' new-place path, per add-scene-control.e2e.mjs / scene-creation-place-required.e2e.mjs)");
});

test("***Phase 26 fix***: the same absence holds even after this chain has more than two scenes (not just the boundary case)", async () => {
  await page.goto(`${base}/#session-planner/${sceneEnd.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length >= 1, { timeout: 15000 });
  const toggles = page.locator('[data-testid="scene-chain-toggle"]');
  const n = await toggles.count();
  for (let i = 0; i < n; i++) {
    const item = page.locator('[data-testid="scene-chain-item"]').nth(i);
    if (!(await item.evaluate((el) => el.open))) await toggles.nth(i).click();
  }
  await page.waitForTimeout(200);
  const controlCount = await page.evaluate(() => document.querySelectorAll('[data-testid="insert-scene-control"]').length);
  assert.equal(controlCount, 0, "insert-scene-control must stay absent regardless of how many scenes are expanded");
});
