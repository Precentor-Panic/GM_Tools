// Phase 28 task 28.0 -- Navigation spine (`#plans`, `#plans/<planId>`, open
// scene -> `#session-planner/<sceneId>`). Read phase28-fixture.mjs's header
// FIRST (§1/§2/§3 are this file's own sections). EXPECTED TO FAIL right now:
// `#plans`/`#plans/<planId>` match no dispatch branch in app.js's
// renderCurrentView (neither hash is recognized), so every
// `[data-testid="plans-shelf"]`/`[data-testid="plan-detail"]` locator below
// times out waiting for a selector that never appears. That failure is the
// deliverable of this task, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase28Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase28-fixture.mjs";

const { scratchDir, dataDir } = setupPhase28Env("gm-tools-e2e-nav-spine-");
const WORLD = "e2e-nav-spine-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "nav-place-a", name: "Riverside Docks", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "nav-place-b", name: "Ashen Keep", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "nav-place-existing-pickable", name: "The Old Bridge", type: "place", importance: 0.4 } }
]);

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("#plans lists every Plan as a shelf item (name + scene count); New plan creates one and opens it directly", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "nav-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Shelf Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);

  await page.goto(`${base}/#plans`);
  const item = page.locator(`[data-testid="plan-shelf-item"][data-plan-id="${plan.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await item.locator('[data-testid="plan-shelf-name"]').textContent()).trim(), "Shelf Check Plan");
  assert.match((await item.locator('[data-testid="plan-shelf-scene-count"]').textContent()).trim(), /1/);

  await page.locator('[data-testid="new-plan-btn"]').click();
  const panel = page.locator('[data-testid="new-plan-panel"]');
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="new-plan-name-input"]').fill("Freshly Minted Plan");
  await panel.locator('[data-testid="new-plan-submit-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash.startsWith("#plans/"), { timeout: 10000 });
  }, "submitting New plan must navigate straight into the new plan's own #plans/<planId>");
  await page.locator('[data-testid="plan-detail"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

test("#plans/<planId>: an EMPTY plan renders ONLY the empty-state + ghost add-scene row, no plan-scene-list", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const plan = await createPlanViaRoute(base, WORLD, "Genuinely Empty Plan");

  await page.goto(`${base}/#plans/${plan.id}`);
  const empty = page.locator(`[data-testid="plan-empty-state"][data-plan-id="${plan.id}"]`);
  await empty.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="plan-scene-list"]').count(), 0, "an empty plan must render NO plan-scene-list");
  assert.equal(await empty.locator('[data-testid="plan-add-scene-row"]').count(), 1, "the empty-plan screen's only construction action must be the ghost add-scene row");
  await page.close();
});

test("#plans/<planId>: scene rows render in sceneIds order (data-order); opening a row navigates to #session-planner/<sceneId>", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "nav-place-a" });
  const sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "nav-place-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Ordered Rows Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);

  await page.goto(`${base}/#plans/${plan.id}`);
  const list = page.locator(`[data-testid="plan-scene-list"][data-plan-id="${plan.id}"]`);
  await list.waitFor({ state: "visible", timeout: 15000 });
  const rows = page.locator('[data-testid="plan-scene-row"]');
  assert.equal(await rows.count(), 2);
  const rowA = page.locator(`[data-testid="plan-scene-row"][data-scene-id="${sceneA.id}"]`);
  const rowB = page.locator(`[data-testid="plan-scene-row"][data-scene-id="${sceneB.id}"]`);
  assert.equal(await rowA.getAttribute("data-order"), "0");
  assert.equal(await rowB.getAttribute("data-order"), "1");
  // Ends: the FIRST row has no up-btn, the LAST row has no down-btn.
  assert.equal(await rowA.locator('[data-testid="plan-scene-row-up-btn"]').count(), 0, "the first row must not offer an up-btn");
  assert.equal(await rowB.locator('[data-testid="plan-scene-row-down-btn"]').count(), 0, "the last row must not offer a down-btn");

  await rowA.locator('[data-testid="plan-scene-row-open-btn"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#session-planner/${id}`, sceneA.id, { timeout: 10000 });
  }, "opening a plan-scene-row must navigate to #session-planner/<sceneId>, the preserved deep-link hash");
  await page.close();
});

test("#plans/<planId>: down-btn reorders via the REAL Plan record, confirmed by a fresh GET", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "nav-place-a" });
  const sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "nav-place-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Reorder Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);

  await page.goto(`${base}/#plans/${plan.id}`);
  const rowA = page.locator(`[data-testid="plan-scene-row"][data-scene-id="${sceneA.id}"]`);
  await rowA.waitFor({ state: "visible", timeout: 15000 });
  await rowA.locator('[data-testid="plan-scene-row-down-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector('[data-testid="plan-scene-row"][data-order="0"]')?.getAttribute("data-scene-id") !== id,
      sceneA.id,
      { timeout: 10000 }
    );
  }, "clicking down on the first row must visibly swap the row order");

  const planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.deepEqual(planAfter.plan.sceneIds, [sceneB.id, sceneA.id], "the swap must persist in the real Plan record's own sceneIds, not just client-side DOM order");
  await page.close();
});

test("#plans/<planId>: hover-x remove-from-plan is immediate (no confirm), shows undo-toast, scene survives and reappears on undo", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "nav-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Remove-From-Plan Nav Check");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);

  await page.goto(`${base}/#plans/${plan.id}`);
  const row = page.locator(`[data-testid="plan-scene-row"][data-scene-id="${sceneA.id}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="plan-scene-row-remove-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="plan-scene-row"][data-scene-id="${id}"]`).length === 0,
      sceneA.id,
      { timeout: 10000 }
    );
  }, "clicking remove must take effect immediately -- no confirm step, since it's reversible");

  const toast = page.locator('[data-testid="undo-toast"]');
  await toast.waitFor({ state: "visible", timeout: 5000 });

  // The scene record itself is completely untouched by an unlink.
  const getRes = await fetch(`${base}/api/session-planner/scenes/${sceneA.id}?world=${WORLD}`);
  assert.equal(getRes.status, 200, "remove-from-plan must never delete the scene record itself");

  await toast.locator('[data-testid="undo-toast-undo-btn"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="plan-scene-row"][data-scene-id="${id}"]`).length === 1,
      sceneA.id,
      { timeout: 10000 }
    );
  }, "Undo must re-add the scene to this plan");
  await page.close();
});

test("ghost add-scene row: existing-place path attaches a scene to the plan via the real routes", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const plan = await createPlanViaRoute(base, WORLD, "Add-Scene Existing-Place Plan");

  await page.goto(`${base}/#plans/${plan.id}`);
  const ghost = page.locator(`[data-testid="plan-add-scene-row"][data-plan-id="${plan.id}"]`);
  await ghost.waitFor({ state: "visible", timeout: 15000 });
  await ghost.click();

  const panel = page.locator(`[data-testid="plan-add-scene-panel"][data-plan-id="${plan.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  const existingInput = panel.locator('[data-testid="plan-add-scene-place-input"]');
  await existingInput.fill("Old Bridge");
  const option = panel.locator('[data-testid="plan-add-scene-place-option"][data-entity-id="nav-place-existing-pickable"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="plan-scene-row"]').length === 1, { timeout: 10000 });
  }, "picking an existing place and completing the flow must append a real scene row");

  const planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.equal(planAfter.plan.sceneIds.length, 1, "the plan record itself must show exactly one attached scene");
  await page.close();
});

test("ghost add-scene row: new-place path offers contained-in, and choosing an existing container creates a REAL containment edge", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const plan = await createPlanViaRoute(base, WORLD, "Add-Scene New-Place Containment Plan");

  await page.goto(`${base}/#plans/${plan.id}`);
  const ghost = page.locator(`[data-testid="plan-add-scene-row"][data-plan-id="${plan.id}"]`);
  await ghost.waitFor({ state: "visible", timeout: 15000 });
  await ghost.click();

  const panel = page.locator(`[data-testid="plan-add-scene-panel"][data-plan-id="${plan.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="plan-add-scene-place-mode-new-btn"]').click();
  await panel.locator('[data-testid="plan-add-scene-new-place-name-input"]').fill("The Sunken Chapel");
  await panel.locator('[data-testid="plan-add-scene-new-place-submit-btn"]').click();

  const containedStep = panel.locator('[data-testid="plan-add-scene-contained-in-step"]');
  await containedStep.waitFor({ state: "visible", timeout: 10000 });
  await containedStep.locator('[data-testid="plan-add-scene-contained-in-yes-btn"]').click();
  const containerInput = containedStep.locator('[data-testid="plan-add-scene-contained-in-input"]');
  await containerInput.fill("Old Bridge");
  const containerOption = containedStep.locator('[data-testid="plan-add-scene-contained-in-option"][data-entity-id="nav-place-existing-pickable"]');
  await containerOption.waitFor({ state: "visible", timeout: 5000 });
  await containerOption.click();
  await containedStep.locator('[data-testid="plan-add-scene-contained-in-confirm-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="plan-scene-row"]').length === 1, { timeout: 10000 });
  }, "the new-place + contained-in flow must still end with a real attached scene row");

  const { nodes, edges } = await fetchGraphViaRoute(base, WORLD);
  const newPlace = nodes.find((n) => n.name === "The Sunken Chapel");
  assert.ok(newPlace, "the new place must be a real graph entity");
  const containmentEdge = edges.find(
    (e) => e.sourceId === newPlace.id && e.targetId === "nav-place-existing-pickable" && e.relationshipType === "containment"
  );
  assert.ok(containmentEdge, "choosing an existing container must create a REAL containment edge from the new place to it");
  await page.close();
});
