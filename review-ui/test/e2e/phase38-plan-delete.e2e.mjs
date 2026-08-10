// Phase 38 task 38.0 -- plan-delete rail ✕ contract (phase38-fixture.mjs §5),
// mirroring scene-delete.e2e.mjs's own two-part structure exactly (a
// route-level test + a UI-level test). Read phase38-fixture.mjs's header
// (§5) FIRST.
//
// Test 1 is RED: `fillRailPlans` (app-shell.js) has no delete affordance at
// all today (confirmed by direct read before writing this file) --
// `shell-plan-item-delete-btn` appears nowhere in the DOM.
// Test 2 is a DELIBERATE GREEN PIN, called out explicitly: `deletePlan`
// (session-planner/plans.mjs) and `DELETE /api/scene-planning/plans/:planId`
// (server.mjs) are REAL, SHIPPED, working routes today -- this test protects
// that existing backend contract (plan gone, both its scenes untouched,
// idempotent) while 38.3 builds the missing rail UI on top of it. A failure
// here IS a genuine regression, not an expected-red signal.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  deletePlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-p38-plandel-");
const WORLD = "e2e-p38-plandel-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p38pd-place-a", name: "P38 Plan-Delete Place A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "p38pd-place-b", name: "P38 Plan-Delete Place B", type: "place", importance: 0.5 } }
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

test("GREEN PIN, ROUTE LEVEL: DELETE /api/scene-planning/plans/:planId -- plan gone, its scenes survive untouched, idempotent", async () => {
  const sceneOne = await createSceneViaRoute(base, WORLD, { locationEntityId: "p38pd-place-a" });
  const sceneTwo = await createSceneViaRoute(base, WORLD, { locationEntityId: "p38pd-place-b" });
  const plan = await createPlanViaRoute(base, WORLD, "P38 Plan To Delete");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneOne.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneTwo.id);

  const { status, body } = await deletePlanViaRoute(base, WORLD, plan.id);
  assert.equal(status, 200, `expected 200 from the existing delete-plan route, got ${status}: ${JSON.stringify(body)}`);

  const getRes = await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`);
  assert.notEqual(getRes.status, 200, "the deleted plan must no longer be fetchable by id");

  const sceneOneAfter = await (await fetch(`${base}/api/session-planner/scenes/${sceneOne.id}?world=${WORLD}`)).json();
  const sceneTwoAfter = await (await fetch(`${base}/api/session-planner/scenes/${sceneTwo.id}?world=${WORLD}`)).json();
  assert.ok(sceneOneAfter?.scene, "deleting a plan must NOT delete its scenes -- plans hold sceneId pointers only");
  assert.ok(sceneTwoAfter?.scene, "deleting a plan must NOT delete its scenes -- plans hold sceneId pointers only");

  const { status: secondStatus } = await deletePlanViaRoute(base, WORLD, plan.id);
  assert.notEqual(secondStatus, 500, "deleting an already-deleted plan must not crash the server");
});

test("PLANNER RAIL: a ✕ on the plan row deletes the plan entirely (mirrors the scene rail's delete flow)", async () => {
  const plan = await createPlanViaRoute(base, WORLD, "P38 Rail Delete Target");

  await page.goto(`${base}/#planner/plans`);
  const item = page.locator(`[data-testid="shell-plan-item"][data-plan-id="${plan.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });

  const deleteBtn = item.locator('[data-testid="shell-plan-item-delete-btn"]');
  await deleteBtn.waitFor({ state: "visible", timeout: 5000 });
  await deleteBtn.click();

  const confirmPanel = item.locator(`[data-testid="shell-plan-item-delete-confirm-panel"][data-plan-id="${plan.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="shell-plan-item-delete-confirm-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="shell-plan-item"][data-plan-id="${id}"]`).length === 0,
      plan.id,
      { timeout: 10000 }
    );
  }, "confirming the delete must remove the row from the planner rail");

  const getRes = await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`);
  assert.notEqual(getRes.status, 200, "the plan must be genuinely gone from the real store, not just hidden in the DOM");
});
