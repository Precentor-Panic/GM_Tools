// Phase 28 task 28.0 -- Scenes tab: the "linked scenes" panel is REPLACED
// by a read-only "In plans:" chip row (`plansContainingScene`). Read
// phase28-fixture.mjs's header FIRST (§9/§13 are this file's own sections).
// EXPECTED TO FAIL right now: `GET /api/scene-planning/scenes/:sceneId/
// plans` doesn't exist yet (real 404); `scenes-view.js`'s real
// `renderSceneListItem` still renders the OLD `scene-list-item-linked-
// toggle` / `linked-scenes-panel` DOM (unmodified by this task), so
// `scene-list-item-plans-toggle`/`in-plans-panel` never appear. Both
// failure shapes are the deliverable of this task, not a bug in this file.
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
  plansContainingSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase28-fixture.mjs";

const { scratchDir, dataDir } = setupPhase28Env("gm-tools-e2e-inplans-");
const WORLD = "e2e-inplans-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "inplans-place-a", name: "Hollow Reach", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "inplans-place-b", name: "Quietwater Bend", type: "place", importance: 0.5 } }
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

test("ROUTE LEVEL: GET .../scenes/:sceneId/plans returns every plan containing the scene; [] (never 404) for an orphaned scene", async () => {
  const sceneInTwo = await createSceneViaRoute(base, WORLD, { locationEntityId: "inplans-place-a" });
  const sceneOrphan = await createSceneViaRoute(base, WORLD, { locationEntityId: "inplans-place-b" });
  const planOne = await createPlanViaRoute(base, WORLD, "First Story Arc");
  const planTwo = await createPlanViaRoute(base, WORLD, "Session 4 Grab-Bag");
  await addSceneToPlanViaRoute(base, WORLD, planOne.id, sceneInTwo.id);
  await addSceneToPlanViaRoute(base, WORLD, planTwo.id, sceneInTwo.id);

  const { status, body } = await plansContainingSceneViaRoute(base, WORLD, sceneInTwo.id);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const names = body.plans.map((p) => p.name).sort();
  assert.deepEqual(names, ["First Story Arc", "Session 4 Grab-Bag"].sort(), "must return every plan (full records, not just ids) that contains this scene");

  const orphanRes = await plansContainingSceneViaRoute(base, WORLD, sceneOrphan.id);
  assert.equal(orphanRes.status, 200, "a scene belonging to zero plans must still return 200, never a 404 -- an orphaned scene is a valid state");
  assert.deepEqual(orphanRes.body.plans, []);
});

test("UI: the OLD linked-scenes mechanism is gone; scene-list-item-plans-toggle opens a read-only In-plans chip row backed by the real route, and a chip navigates to that plan", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "inplans-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Chip Navigation Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#scenes`);

  const item = page.locator(`[data-testid="scene-list-item"][data-scene-id="${scene.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });

  // The OLD mechanism this phase replaces must be genuinely gone, not just
  // unused -- a real DOM-absence assertion.
  assert.equal(await item.locator('[data-testid="scene-list-item-linked-toggle"]').count(), 0, "the old 'linked scenes' toggle must no longer render at all");

  const plansToggle = item.locator('[data-testid="scene-list-item-plans-toggle"]');
  await plansToggle.waitFor({ state: "visible", timeout: 10000 });
  await plansToggle.click();

  const panel = item.locator(`[data-testid="in-plans-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="linked-scenes-panel"]').count(), 0, "the old linked-scenes-panel must not render anywhere, not even under a different trigger");

  const chip = panel.locator(`[data-testid="in-plans-chip"][data-plan-id="${plan.id}"]`);
  await chip.waitFor({ state: "visible", timeout: 5000 });
  assert.equal((await chip.textContent()).trim(), "Chip Navigation Check Plan", "the chip must show the plan's own real name");

  await chip.click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#plans/${id}`, plan.id, { timeout: 10000 });
  }, "clicking an In-plans chip must navigate to that plan's own #plans/<planId>");
  await page.close();
});

test("UI: a scene in zero plans shows the empty state, not a blank panel", async () => {
  const orphanScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "inplans-place-b" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#scenes`);

  const item = page.locator(`[data-testid="scene-list-item"][data-scene-id="${orphanScene.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.locator('[data-testid="scene-list-item-plans-toggle"]').click();

  const panel = item.locator(`[data-testid="in-plans-panel"][data-scene-id="${orphanScene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 10000 });
  const empty = panel.locator('[data-testid="in-plans-empty"]');
  await assert.doesNotReject(async () => {
    await empty.waitFor({ state: "visible", timeout: 5000 });
  }, "a scene in zero plans must render the explicit in-plans-empty state, never a silently-blank panel");
  assert.equal(await panel.locator('[data-testid="in-plans-chip"]').count(), 0);
  await page.close();
});
