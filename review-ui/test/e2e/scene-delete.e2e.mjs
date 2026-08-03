// Phase 27 task 27.0 -- "Scene delete vs. remove-from-plan" (F1). Read
// phase27-fixture.mjs's header FIRST (§1 is this file's own section).
// EXPECTED TO FAIL right now: `DELETE /api/session-planner/scenes/:sceneId`
// doesn't exist yet (session-planner/scenes.mjs has no `deleteScene`, per
// plans/phase-27-tasks.md's own grounding pass, re-confirmed fresh against
// the real file), so the route-level test gets a real 404; the Scenes-tab
// delete button (`scene-list-item-delete`) doesn't exist yet in
// scenes-view.js's real `renderSceneListItem`; and the plan-view "remove
// from plan" control (`plan-scene-remove-btn`) doesn't exist yet since the
// plan-first construction view itself (27.4) hasn't been built. All three
// failures are the deliverable of this task, not a bug in this file.
//
// Two genuinely distinct affordances are asserted DISTINCTLY, per this
// project owner's own explicit framing (Decision 2 in the design record):
// Scenes-tab delete is a TRUE delete (record + all plan memberships + all
// scene-links gone; the place ENTITY survives); plan-view "remove" is an
// UNLINK ONLY (scene survives in the Scenes tab and any other plan).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase27Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  linkScenesViaRoute,
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

test("ROUTE LEVEL: DELETE /api/session-planner/scenes/:sceneId cascades -- scene record gone, every plan membership gone, every scene-link gone, place entity untouched", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-a" });
  const otherScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-b" });

  const planOne = await createPlanViaRoute(base, WORLD, "Scene-Delete Plan One");
  const planTwo = await createPlanViaRoute(base, WORLD, "Scene-Delete Plan Two");
  await addSceneToPlanViaRoute(base, WORLD, planOne.id, scene.id);
  await addSceneToPlanViaRoute(base, WORLD, planTwo.id, scene.id);
  await linkScenesViaRoute(base, WORLD, scene.id, otherScene.id, "cascade check");

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

  // (3) every scene-link involving it is gone (queried from the OTHER side,
  // since the deleted scene itself is no longer a valid query target).
  const linkedFromOther = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${otherScene.id}`)).json();
  assert.ok(!linkedFromOther.linked.some((l) => l.sceneId === scene.id), "deleting a scene must remove its scene-links -- the other scene must no longer see it as linked");

  // (4) the place ENTITY survives -- deleting a scene is not a graph mutation.
  const { snapshot } = loadSnapshot(dataDir, WORLD);
  assert.ok(snapshot.entities.some((e) => e.id === "scdel-place-a"), "the scene's own anchor place entity must survive scene deletion (Decision 2)");

  // (5) idempotent-in-shape sanity: deleting an already-deleted scene must not 500.
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

test("PLAN VIEW: 'remove from plan' unlinks only -- scene survives in the Scenes tab and in any OTHER plan it belonged to", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-a" });
  const otherScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Remove-From-Plan Check");
  const otherPlan = await createPlanViaRoute(base, WORLD, "Untouched Sibling Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, otherScene.id);
  await addSceneToPlanViaRoute(base, WORLD, otherPlan.id, scene.id);

  await page.goto(`${base}/#session-planner/plan/${plan.id}`);
  const chainItem = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"]`);
  await chainItem.waitFor({ state: "visible", timeout: 15000 });
  if (!(await chainItem.evaluate((el) => el.open))) {
    await chainItem.locator('[data-testid="scene-chain-toggle"]').click();
  }

  const removeBtn = chainItem.locator('[data-testid="plan-scene-remove-btn"]');
  await removeBtn.waitFor({ state: "visible", timeout: 10000 });
  await removeBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="scene-chain-item"][data-scene-id="${id}"]`).length === 0,
      scene.id,
      { timeout: 10000 }
    );
  }, "removing a scene from the active plan must remove its chain-item from THIS plan's own view");

  // The scene itself is COMPLETELY untouched: still a real, fetchable
  // record, still a member of the OTHER plan.
  const getRes = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.equal(getRes.status, 200, "removing a scene from ONE plan must never delete the scene record itself");

  const planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.ok(!planAfter.plan.sceneIds.includes(scene.id), "the scene must genuinely be gone from THIS plan's own sceneIds");

  const otherPlanAfter = await (await fetch(`${base}/api/scene-planning/plans/${otherPlan.id}?world=${WORLD}`)).json();
  assert.ok(otherPlanAfter.plan.sceneIds.includes(scene.id), "removing from ONE plan must never touch the scene's membership in ANY OTHER plan");

  // And it's still reachable from the Scenes tab.
  await page.goto(`${base}/#scenes`);
  const scenesTabItem = page.locator(`[data-testid="scene-list-item"][data-scene-id="${scene.id}"]`);
  await scenesTabItem.waitFor({ state: "visible", timeout: 15000 });
});

test("PLAN VIEW: removing the CURRENTLY-VIEWED scene from the active plan never dead-ends -- falls back to a remaining scene or the empty-plan screen", async () => {
  const soleScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "scdel-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Dead-End Check (single scene)");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, soleScene.id);

  await page.goto(`${base}/#session-planner/plan/${plan.id}`);
  const chainItem = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${soleScene.id}"]`);
  await chainItem.waitFor({ state: "visible", timeout: 15000 });
  if (!(await chainItem.evaluate((el) => el.open))) {
    await chainItem.locator('[data-testid="scene-chain-toggle"]').click();
  }
  await chainItem.locator('[data-testid="plan-scene-remove-btn"]').click();

  // Removing the ONLY scene in the plan must land on the empty-plan screen,
  // never a blank/broken view.
  const emptyState = page.locator(`[data-testid="plan-empty-state"][data-plan-id="${plan.id}"]`);
  await assert.doesNotReject(async () => {
    await emptyState.waitFor({ state: "visible", timeout: 10000 });
  }, "removing the last/only scene from the active plan while viewing it must land on the empty-plan +Add scene screen, not a dead end");
  assert.equal(await page.locator('[data-testid="plan-add-scene-btn"]').count(), 1, "the empty-plan screen's only construction action must still be +Add scene");
});
