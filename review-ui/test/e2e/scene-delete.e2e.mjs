// Phase 27 task 27.0 -- "Scene delete vs. remove-from-plan" (F1).
//
// ***TRIMMED by Phase 28 task 28.0*** (scrap-and-rebuild re-baseline): this
// file ORIGINALLY also covered the plan-first construction view's own
// "remove from plan" control (`plan-scene-remove-btn`, inside the now-
// scrapped `scene-chain-item`/`#session-planner/plan/<planId>` chain view)
// -- those two scenarios are REMOVED here (that DOM no longer exists in the
// Phase 28 design; fresh, equivalent "remove-from-plan, scene survives,
// undo toast" coverage lives in review-ui/test/e2e/
// phase28-navigation-spine.e2e.mjs's own §2 scenario, against the NEW
// `#plans/<planId>` scene-row DOM). The route-level cascade test below is
// ALSO trimmed of its scene-links-specific assertion: scene-to-scene
// linking is scrapped entirely this phase (session-planner/scene-links.mjs
// itself is slated for removal by task 28.1, "Remove scene-links.mjs +
// routes + deleteScene's scene-link cascade import") -- asserting on a
// cascade path about to be deleted is testing a soon-dead contract, not the
// surviving one. What SURVIVES and is KEPT here, unchanged in spirit: the
// Scenes-tab delete-scene flow (`scene-list-item-delete` et al, still real,
// still shipped, still green) and the plan-membership-cascade + place-
// entity-survives guarantees of the real DELETE /api/session-planner/
// scenes/:sceneId route (Decision 2: deleting a scene is never a graph
// mutation).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase27Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  deleteSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase27-fixture.mjs";

const { scratchDir, dataDir } = setupPhase27Env("gm-tools-e2e-scenedelete-");
const WORLD = "e2e-scenedelete-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "scdel-place-a", name: "Scene-Delete Place A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "scdel-place-b", name: "Scene-Delete Place B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "scdel-place-c", name: "Scene-Delete Place C", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("ROUTE LEVEL: DELETE /api/session-planner/scenes/:sceneId cascades -- scene record gone, every plan membership gone, place entity untouched", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-a" });

  const planOne = await createPlanViaRoute(base, WORLD, "Scene-Delete Plan One");
  const planTwo = await createPlanViaRoute(base, WORLD, "Scene-Delete Plan Two");
  await addSceneToPlanViaRoute(base, WORLD, planOne.id, scene.id);
  await addSceneToPlanViaRoute(base, WORLD, planTwo.id, scene.id);

  const { status, body } = await deleteSceneViaRoute(base, WORLD, scene.id);
  assert.equal(status, 200, `expected 200 from the delete route, got ${status}: ${JSON.stringify(body)}`);

  // (1) the scene record itself is genuinely gone.
  const getRes = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.notEqual(getRes.status, 200, "the deleted scene must no longer be fetchable by id");

  // (2) removed from EVERY plan it was a member of, not just one.
  const planOneAfter = await (await fetch(`${base}/api/scene-planning/plans/${planOne.id}?world=${WORLD}`)).json();
  const planTwoAfter = await (await fetch(`${base}/api/scene-planning/plans/${planTwo.id}?world=${WORLD}`)).json();
  assert.ok(!planOneAfter.plan.sceneIds.includes(scene.id), "deleting a scene must remove it from every plan it belonged to (plan one)");
  assert.ok(!planTwoAfter.plan.sceneIds.includes(scene.id), "deleting a scene must remove it from every plan it belonged to (plan two)");

  // (3) the place ENTITY survives -- deleting a scene is not a graph mutation.
  const { snapshot } = loadSnapshot(dataDir, WORLD);
  assert.ok(snapshot.entities.some((e) => e.id === "scdel-place-a"), "the scene's own anchor place entity must survive scene deletion (Decision 2)");

  // (4) idempotent-in-shape sanity: deleting an already-deleted scene must not 500.
  const { status: secondStatus } = await deleteSceneViaRoute(base, WORLD, scene.id);
  assert.notEqual(secondStatus, 500, "deleting an already-deleted scene must not crash the server");
});

test("SCENES TAB: delete removes the scene entirely (real DELETE route, confirmed row-removal, gone from a fresh list)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-c" });

  await page.goto(`${base}/#scenes`);
  const item = page.locator(`[data-testid="scene-list-item"][data-scene-id="${scene.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });

  const deleteBtn = item.locator('[data-testid="scene-list-item-delete"]');
  await deleteBtn.waitFor({ state: "visible", timeout: 5000 });
  await deleteBtn.click();

  const confirmPanel = item.locator(`[data-testid="scene-list-item-delete-confirm-panel"][data-scene-id="${scene.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="scene-list-item-delete-confirm-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="scene-list-item"][data-scene-id="${id}"]`).length === 0,
      scene.id,
      { timeout: 10000 }
    );
  }, "confirming the delete must remove the row from the Scenes tab");

  // Confirm via a completely fresh page load + the real route, not just
  // in-page DOM state.
  await page.goto(`${base}/#scenes`);
  const itemAgain = page.locator(`[data-testid="scene-list-item"][data-scene-id="${scene.id}"]`);
  assert.equal(await itemAgain.count(), 0, "a fresh Scenes-tab load must not show the deleted scene");

  const getRes = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.notEqual(getRes.status, 200, "the scene must be genuinely gone from the real store, not just hidden in the DOM");
});

// The two former "PLAN VIEW: remove from plan" scenarios that used to live
// here (against the OLD `#session-planner/plan/<planId>` chain view's
// `scene-chain-item`/`plan-scene-remove-btn`/`plan-empty-state` DOM) are
// REMOVED by Phase 28 task 28.0 -- that whole view is scrapped this phase.
// Equivalent, updated coverage (remove-from-plan is immediate/no-confirm
// with an undo toast, scene survives, and the empty-plan screen's own
// ghost add-scene row) now lives in review-ui/test/e2e/
// phase28-navigation-spine.e2e.mjs, against the NEW `#plans/<planId>` DOM.
