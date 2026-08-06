// Phase 30 task 30.3 -- feature coverage for the ported designer plan SHELF
// (README §A) and plan RUNSHEET (README §B) in the shell (`#planner/plans`,
// `#planner/plan/<id>`). Re-homes the load-bearing plan-navigation-spine +
// deletes flows the retired phase28-navigation-spine/-deletes + plans-crud
// files carried, asserted against the REAL designer DOM (card grid + runsheet
// rows), never the old plan-shelf-item/plan-detail DOM.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";
import { createSceneElementViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p30-runsheet-");
const WORLD = "e2e-p30-runsheet-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rs-vault", name: "The Drowned Vault", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "rs-forge", name: "The Salt Forge", type: "place", importance: 0.5 } }
]);

let server, base, browser;

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

async function planScenes(planId) {
  const r = await fetch(`${base}/api/scene-planning/plans/${planId}?world=${WORLD}`);
  return (await r.json()).plan.sceneIds;
}

test("plan shelf renders a designer card per plan (name + scene names) plus a New-plan card", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-vault" });
  const plan = await createPlanViaRoute(base, WORLD, "Shelf Card Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });

  const card = page.locator(`[data-testid="planner-plan-card"][data-plan-id="${plan.id}"]`);
  await card.waitFor({ state: "visible" });
  assert.match(await card.textContent(), /Shelf Card Plan/);
  assert.match(await card.textContent(), /Drowned Vault/, "the card lists its scenes' display names");
  assert.equal(await page.locator('[data-testid="planner-new-plan-card"]').count(), 1);
  await page.close();
});

test("the New-plan card creates a real plan and opens its runsheet", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });

  const before = (await (await fetch(`${base}/api/scene-planning/plans?world=${WORLD}`)).json()).plans.length;
  await page.locator('[data-testid="planner-new-plan-card"]').click();
  await page.waitForFunction(() => location.hash.startsWith("#planner/plan/"), null, { timeout: 8000 });
  await page.locator('[data-testid="planner-plan-view"]').waitFor({ state: "visible", timeout: 8000 });
  const after = (await (await fetch(`${base}/api/scene-planning/plans?world=${WORLD}`)).json()).plans.length;
  assert.equal(after, before + 1, "a real new plan must exist");
  await page.close();
});

test("runsheet rows show mono index, uppercase place, element meta, and objective; a scene row navigates to the shell scene hash", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-vault", objectiveNote: "Break the seal before the tide." });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "The seal", fields: { trigger: "touch it" } });
  const plan = await createPlanViaRoute(base, WORLD, "Runsheet Detail Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const view = page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`);
  await view.waitFor({ state: "visible", timeout: 15000 });

  const row = view.locator(`[data-testid="planner-runsheet-row"][data-scene-id="${scene.id}"]`);
  await row.waitFor({ state: "visible" });
  const text = await row.textContent();
  assert.match(text, /01/, "mono two-digit index");
  assert.match(text, /THE DROWNED VAULT/, "uppercase place label");
  assert.match(text, /1 elements · 0 key/, "element meta");
  assert.match(text, /Break the seal before the tide\./, "objective");

  await row.locator('.planner-runsheet-body').click();
  await page.waitForFunction((id) => location.hash === `#planner/scene/${id}`, scene.id, { timeout: 8000 });
  await page.close();
});

test("runsheet reorder (↓) swaps scene order via the real reorder route", async () => {
  const s1 = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-vault" });
  const s2 = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-forge" });
  const plan = await createPlanViaRoute(base, WORLD, "Reorder Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, s1.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, s2.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const view = page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`);
  await view.waitFor({ state: "visible", timeout: 15000 });

  assert.deepEqual(await planScenes(plan.id), [s1.id, s2.id]);
  await view.locator(`[data-testid="planner-runsheet-down-btn"][data-scene-id="${s1.id}"]`).click();
  await page.waitForTimeout(400);
  assert.deepEqual(await planScenes(plan.id), [s2.id, s1.id], "↓ on the first row must move it below the second");
  await page.close();
});

test("runsheet remove (✕) unlinks the scene with an undo toast; the scene itself survives; Undo re-adds it", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-forge" });
  const plan = await createPlanViaRoute(base, WORLD, "Remove Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const view = page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`);
  await view.waitFor({ state: "visible", timeout: 15000 });

  await view.locator(`[data-testid="planner-runsheet-remove-btn"][data-scene-id="${scene.id}"]`).click();
  await page.locator('[data-testid="undo-toast"]').waitFor({ state: "visible", timeout: 5000 });
  assert.deepEqual(await planScenes(plan.id), [], "remove unlinks the scene from the plan");
  // scene record survives
  const sceneRes = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.equal(sceneRes.status, 200);

  await page.locator('[data-testid="undo-toast-undo-btn"]').click();
  await page.waitForTimeout(400);
  assert.deepEqual(await planScenes(plan.id), [scene.id], "Undo re-adds the scene to the plan");
  await page.close();
});

test("Delete plan (confirm) removes the plan and returns to the shelf; the plan's scenes survive", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-vault" });
  const plan = await createPlanViaRoute(base, WORLD, "Doomed Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const view = page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`);
  await view.waitFor({ state: "visible", timeout: 15000 });

  await view.locator('[data-testid="planner-plan-delete-btn"]').click();
  await page.locator('[data-testid="planner-plan-delete-confirm-btn"]').click();
  await page.waitForFunction(() => location.hash === "#planner/plans", null, { timeout: 8000 });

  const plans = (await (await fetch(`${base}/api/scene-planning/plans?world=${WORLD}`)).json()).plans;
  assert.ok(!plans.some((p) => p.id === plan.id), "plan record is gone");
  const sceneRes = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.equal(sceneRes.status, 200, "the plan's scenes survive a plan delete");
  await page.close();
});

test("runsheet + Add scene panel creates a new scene anchored to an existing place and appends it to the plan", async () => {
  const plan = await createPlanViaRoute(base, WORLD, "Add-Scene Plan");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const view = page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`);
  await view.waitFor({ state: "visible", timeout: 15000 });

  assert.deepEqual(await planScenes(plan.id), []);
  await view.locator('[data-testid="planner-add-scene-btn"]').click();
  // reuse the shared add-scene panel: pick an existing place
  await view.locator('[data-testid="plan-add-scene-place-input"]').fill("Salt Forge");
  await view.locator('[data-testid="plan-add-scene-place-option"][data-entity-id="rs-forge"]').first().click();
  await page.waitForTimeout(600);

  const ids = await planScenes(plan.id);
  assert.equal(ids.length, 1, "a new scene must be created and appended to the plan");
  await page.close();
});
