// Phase 30 task 30.0 -- Session Planner surface shell-integration contract
// (deliberately light per plans/phase-30-tasks.md's own "keep this focused
// on shell-integration flows; deep scene-page feature coverage is ported in
// 30.3" -- full stat-block/dressing/wrap-rail/etc. coverage is NOT this
// file's job, it's phase29-*.e2e.mjs's replacement in 30.3). Read
// phase30-fixture.mjs's header FIRST. EXPECTED TO FAIL right now: none of
// `[data-testid="planner-plans-view"]`/`-plan-view`/`-scene-view` exist
// anywhere (index.html/app.js have no `#planner/*` dispatch branch at all).
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

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p30-planner-");
const WORLD = "e2e-p30-planner-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
applyHeadless(snapshotFilePath(dataDir, WORLD), [
  { op: "upsert_entity", data: { id: "planner-place-a", name: "The Salt Archive", type: "place", importance: 0.5 } }
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

test("#planner/plans renders a plan-shelf list (real plan names, not raw ids)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const plan = await createPlanViaRoute(base, WORLD, "Shelf Card Check Plan");

  await page.goto(`${base}/#planner/plans`);
  const view = page.locator('[data-testid="planner-plans-view"]');
  await view.waitFor({ state: "visible", timeout: 30000 });
  // Harden (Phase 30.5): the shelf's plan name lands only after several
  // chained async fetches (plans + scenes + entity graph), so a bare
  // visible-then-snapshot could race the fill and intermittently time out
  // under parallel load. Poll until the real plan name is actually in the DOM,
  // with a generous timeout (project convention) -- this asserts EXACTLY what
  // the snapshot below asserts (the real plan name, never a raw id), it just
  // waits for it to arrive instead of sampling once.
  await page.waitForFunction(
    (name) => {
      const v = document.querySelector('[data-testid="planner-plans-view"]');
      return !!v && v.textContent.includes(name);
    },
    "Shelf Card Check Plan",
    { timeout: 30000, polling: 200 }
  );
  assert.match(await view.textContent(), /Shelf Card Check Plan/);
  await page.close();
});

test("opening a plan from the shelf navigates to #planner/plan/<id> and renders the runsheet root", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const plan = await createPlanViaRoute(base, WORLD, "Open-From-Shelf Plan");

  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${plan.id}"]`).click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#planner/plan/${id}`, plan.id, { timeout: 10000 });
  }, "opening a plan from the shelf must navigate to #planner/plan/<id>");
  await page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

test("opening a scene from the runsheet navigates to #planner/scene/<id> and renders the scene root with its light stub sub-roots", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "planner-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Runsheet-To-Scene Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const planView = page.locator(`[data-testid="planner-plan-view"][data-plan-id="${plan.id}"]`);
  await planView.waitFor({ state: "visible", timeout: 15000 });

  // 30.0 does not pin the exact runsheet row testid (that's 30.3's job) --
  // it pins only that a click-target reaching this scene exists, SCOPED to
  // the main-column runsheet root (not the persistent rail's own
  // scene-library item, which also carries a [data-scene-id] for the same
  // scene and would otherwise make this locator ambiguous once both exist).
  const sceneLink = planView.locator(`[data-scene-id="${scene.id}"]`).first();
  await sceneLink.waitFor({ state: "visible", timeout: 10000 });
  await sceneLink.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#planner/scene/${id}`, scene.id, { timeout: 10000 });
  }, "opening a scene from the runsheet must navigate to #planner/scene/<id>");

  const sceneRoot = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await sceneRoot.waitFor({ state: "visible", timeout: 10000 });
  await sceneRoot.locator('[data-testid="planner-scene-place-header"]').waitFor({ state: "visible", timeout: 10000 });
  await sceneRoot.locator('[data-testid="planner-scene-read-aloud"]').waitFor({ state: "visible", timeout: 10000 });
  await sceneRoot.locator('[data-testid="planner-scene-elements"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});
