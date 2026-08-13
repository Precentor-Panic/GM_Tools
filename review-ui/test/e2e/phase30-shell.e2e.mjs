// Phase 30 task 30.0 -- the SHELL contract (app-shell visibility switch,
// topbar toggle/breadcrumb/world-select, planner rail with plans+scene-
// library+add-to-plan). Read phase30-fixture.mjs's header FIRST. EXPECTED TO
// FAIL right now: `[data-testid="app-shell"]` does not exist anywhere in
// index.html (confirmed by direct read), so every locator below times out.
// That failure is the deliverable of this task, not a bug in this file.
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

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p30-shell-");
const WORLD = "e2e-p30-shell-world";
const WORLD_B = "e2e-p30-shell-world-b";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
applyHeadless(snapshotFilePath(dataDir, WORLD), [
  { op: "upsert_entity", data: { id: "shell-place-a", name: "The Gilded Cistern", type: "place", importance: 0.5 } }
]);
bootstrapSnapshot(snapshotFilePath(dataDir, WORLD_B), { worldId: WORLD_B });

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

// Phase 37 task 37.3: this test's old "legacy hash" example was `#queue`,
// which now hash-redirects into the shell (#chronicle). Retargeted to `#graph`
// -- a surviving legacy (non-shell) hash -- so the shell-vs-legacy-chrome
// visibility switch this test actually exercises is unchanged.
test("app-shell is hidden on a legacy hash (#graph) and visible with legacy chrome hidden on #planner/plans", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.goto(`${base}/#graph`);
  await page.locator("header.topbar").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="app-shell"]').isVisible().catch(() => false), false, "app-shell must be hidden on a legacy hash");

  await page.goto(`${base}/#planner/plans`);
  const shell = page.locator('[data-testid="app-shell"][data-surface="planner"]');
  await shell.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator("header.topbar").isVisible().catch(() => false), false, "legacy topbar must be hidden inside the shell");
  assert.equal(await page.locator("main").isVisible().catch(() => false), false, "legacy main must be hidden inside the shell");
  await page.close();
});

test("surface toggle switches planner <-> world, updating the hash and swapping main-column roots", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="shell-surface-toggle-world"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#world", { timeout: 10000 });
  }, "clicking the World toggle must navigate to bare #world");
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="shell-rail-planner"]').count(), 0, "the planner rail must not remain mounted on the World surface");

  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#planner/plans", { timeout: 10000 });
  }, "clicking the Session planner toggle must navigate to #planner/plans");
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="world-surface-root"]').count(), 0);
  await page.close();
});

test("breadcrumb: no standalone Plans crumb on the bare plans-list route; Plans leads once a plan/scene is open; scene segment is a non-navigating leaf", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Breadcrumb Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });
  // QA W3 finding 1: the standalone "Plans" crumb is redundant on the
  // plans-list route itself (the Session planner tab already says where you
  // are) -- it no longer renders here at all.
  assert.equal(await page.locator('[data-testid="shell-breadcrumb-plans"]').count(), 0, "no standalone Plans crumb on the bare shelf");
  assert.equal(await page.locator('[data-testid="shell-breadcrumb-plan"]').count(), 0, "no plan segment on the bare shelf");

  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const planCrumb = page.locator(`[data-testid="shell-breadcrumb-plan"][data-plan-id="${plan.id}"]`);
  await planCrumb.waitFor({ state: "visible", timeout: 15000 });
  // Once a plan is open, "Plans" leads the trail as a clickable parent again.
  await page.locator('[data-testid="shell-breadcrumb-plans"]').waitFor({ state: "visible", timeout: 15000 });

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const sceneCrumb = page.locator(`[data-testid="shell-breadcrumb-scene"][data-scene-id="${scene.id}"]`);
  await sceneCrumb.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="shell-breadcrumb-plans"]').waitFor({ state: "visible", timeout: 15000 });
  await sceneCrumb.click();
  await page.waitForTimeout(300);
  assert.equal(page.url().includes(`#planner/scene/${scene.id}`) || (await page.evaluate(() => location.hash)) === `#planner/scene/${scene.id}`, true, "clicking the leaf scene crumb must not navigate away");

  await page.goto(`${base}/#world`);
  assert.equal(await page.locator('[data-testid="shell-breadcrumb"]').count(), 0, "breadcrumb is planner-surface-only");
  await page.close();
});

test("deep link: #planner/scene/<id> opens the scene directly with no prior click", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.close();
});

test("rail: plans list + scene library render; scene-library row + adds to the open plan, with dedupe notice and undo", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Rail Add Check Plan");

  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const railPlanItem = page.locator(`[data-testid="shell-plan-item"][data-plan-id="${plan.id}"]`);
  await railPlanItem.waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await railPlanItem.locator('[data-testid="shell-plan-item-name"]').textContent()).trim(), "Rail Add Check Plan");

  const libItem = page.locator(`[data-testid="shell-scene-library-item"][data-scene-id="${scene.id}"]`);
  await libItem.waitFor({ state: "visible", timeout: 15000 });
  await libItem.locator('[data-testid="shell-scene-library-item-add-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="undo-toast"]') !== null, { timeout: 10000 });
  }, "adding a scene not already in the open plan must call the real route and show an undo toast");

  let planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.deepEqual(planAfter.plan.sceneIds, [scene.id]);

  // Clicking + again on the same (now-member) scene: dedupe notice, no second toast/route effect.
  await libItem.locator('[data-testid="shell-scene-library-item-add-btn"]').click();
  const dedupe = page.locator(`[data-testid="shell-add-to-plan-dedupe-notice"][data-plan-id="${plan.id}"]`);
  await dedupe.waitFor({ state: "visible", timeout: 10000 });
  assert.match((await dedupe.textContent()) || "", /already in/i);
  assert.match((await dedupe.textContent()) || "", /Rail Add Check Plan/);

  planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.deepEqual(planAfter.plan.sceneIds, [scene.id], "dedupe must not add the scene a second time");
  await page.close();
});

test("rail: + with no open plan (on the bare shelf) shows a no-target notice and calls no route", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });

  await page.goto(`${base}/#planner/plans`);
  const libItem = page.locator(`[data-testid="shell-scene-library-item"][data-scene-id="${scene.id}"]`);
  await libItem.waitFor({ state: "visible", timeout: 15000 });
  await libItem.locator('[data-testid="shell-scene-library-item-add-btn"]').click();

  const notice = page.locator('[data-testid="shell-add-to-plan-no-target-notice"]');
  await notice.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="undo-toast"]').count(), 0);
  await page.close();
});

test("shell world select writes localStorage[gmReview.world] and re-renders the rail for the newly selected world", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const planWorldA = await createPlanViaRoute(base, WORLD, "World A Only Plan");
  const planWorldB = await createPlanViaRoute(base, WORLD_B, "World B Only Plan");

  await page.goto(`${base}/#planner/plans`);
  await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${planWorldA.id}"]`).waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="shell-world-select"]').selectOption(WORLD_B);
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => localStorage.getItem("gmReview.world") === "e2e-p30-shell-world-b", { timeout: 10000 });
  }, "changing the shell world select must write localStorage[gmReview.world]");
  await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${planWorldB.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${planWorldA.id}"]`).count(), 0, "world A's plan must not remain listed after switching to world B");
  await page.close();
});
