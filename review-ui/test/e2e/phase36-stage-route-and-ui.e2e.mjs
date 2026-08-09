// Phase 36 task 36.0 -- QE-first e2e contract, part 1: the stage-it TOGGLE
// (route contract + UI presence). Read phase36-fixture.mjs FIRST (§1-§3,
// §7).
//
// EXPECTED-RED reasons:
//   - `POST /api/session-planner/scenes/:id/stage` appears nowhere in
//     server.mjs's route table (grep-confirmed) -> a genuine 404 via the
//     generic `sendJson(res, 404, {error:"No route: METHOD path"})`
//     fallback.
//   - `[data-testid="scene-stage-toggle"]` appears nowhere in
//     review-ui/public/session-planner-view.js (grep-confirmed) -> a
//     genuine Playwright zero-count assertion (not a timeout -- this test
//     does NOT wait for the toggle to appear, since it's asserting absence,
//     not presence; it waits for the scene page's own already-real root
//     first, then checks the toggle count on that settled page).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  stageSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase36-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-p36stage-");
const WORLD = "e2e-p36-stage-toggle";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base, browser, scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Stake out the ferry landing." });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// Route-level: POST /api/session-planner/scenes/:id/stage
// ---------------------------------------------------------------------------

test("POST /api/session-planner/scenes/:id/stage {world,staged:true} -> {scene} with stagedForFoundry:true (404 today)", async () => {
  const r = await stageSceneViaRoute(base, WORLD, scene.id, true);
  assert.equal(r.status, 200, `expected the v2-contract stage route to exist and succeed -- got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.scene.stagedForFoundry, true);
  assert.equal(r.body.scene.id, scene.id);
});

test("the staged scene also gained lastPushedAt:null as a field (additive, per §1) once staging exists", async () => {
  const r = await stageSceneViaRoute(base, WORLD, scene.id, true);
  assert.equal(r.status, 200, `expected the v2-contract stage route to exist -- got ${r.status}`);
  assert.ok("lastPushedAt" in r.body.scene, "Scene record must carry lastPushedAt once the additive field lands");
  assert.equal(r.body.scene.lastPushedAt, null, "a freshly-staged, never-pushed scene has lastPushedAt:null");
});

test("staging an unknown sceneId 404s with a clear error, matching every other scene route's convention", async () => {
  const r = await stageSceneViaRoute(base, WORLD, "scene_does_not_exist", true);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// UI-level: the scene page's stage toggle (Playwright)
// ---------------------------------------------------------------------------

test("scene page has NO stage-it toggle today -- selector absent (36.2 adds it)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const toggleCount = await page.locator('[data-testid="scene-stage-toggle"]').count();
  assert.equal(toggleCount, 0, "the §7-pinned scene-stage-toggle testid must not exist yet -- if this is >0, 36.2 has already shipped it and this test should be flipped to a presence assertion");

  await page.close();
});

test("scene page has NO 'in Foundry' status line today -- selector absent (36.2 adds it, only when staged)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const lineCount = await page.locator('[data-testid="scene-stage-status-line"]').count();
  assert.equal(lineCount, 0);

  await page.close();
});
