// Phase 27 task 27.0 -- "Plan-first navigation" (F3). Read
// phase27-fixture.mjs's header FIRST (the routing-contract decision at the
// top, plus §1, is what this file exercises). EXPECTED TO FAIL right now --
// `#session-planner/plan/<planId>` doesn't exist as a route at all yet
// (session-planner-view.js's renderSessionPlanner dispatches only on a
// sceneId or the "new" sentinel today), `plan-empty-state`/`plan-add-scene-
// btn`/`plan-add-scene-panel` don't exist, and the CURRENT `scene-chain`
// shows every root scene in the WHOLE WORLD regardless of Plan membership
// (buildChainOrder has no Plan-scoping concept today) -- so the "only this
// plan's scenes" assertion below is currently false for the opposite
// reason (too MANY scenes render, not too few). All of that is the
// deliverable of this task, not a bug in this file.
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
  DESKTOP_VIEWPORT
} from "./phase27-fixture.mjs";

const { scratchDir, dataDir } = setupPhase27Env("gm-tools-e2e-planfirst-");
const WORLD = "e2e-planfirst-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "planfirst-a", name: "Plan-First Place A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "planfirst-b", name: "Plan-First Place B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "planfirst-outsider", name: "Plan-First Outsider Place", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "planfirst-new-place", name: "Plan-First Freshly Created Place", type: "place", importance: 0.5 } }
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

test("opening an existing (non-empty) plan shows EXACTLY that plan's scenes -- never a scene from another plan in the same world", async () => {
  const inPlanScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "planfirst-a" });
  const outsiderScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "planfirst-outsider" });
  const plan = await createPlanViaRoute(base, WORLD, "Plan-First Scoping Check");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, inPlanScene.id);
  // outsiderScene deliberately NOT added to this plan.

  await page.goto(`${base}/#session-planner/plan/${plan.id}`);
  const chain = page.locator(`[data-testid="scene-chain"][data-plan-id="${plan.id}"]`);
  await chain.waitFor({ state: "visible", timeout: 15000 });

  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length >= 1, { timeout: 10000 });
  const ids = await page.locator('[data-testid="scene-chain-item"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.ok(ids.includes(inPlanScene.id), "the plan's own scene must render");
  assert.ok(!ids.includes(outsiderScene.id), "a scene that belongs to NO plan (or a different one) must never render inside another plan's own chain view");
});

test("a brand-new, empty plan renders a screen whose ONLY construction action is +Add scene -- no scene-chain, no per-scene body, anywhere", async () => {
  const plan = await createPlanViaRoute(base, WORLD, "Freshly Created Empty Plan");

  await page.goto(`${base}/#session-planner/plan/${plan.id}`);
  const emptyState = page.locator(`[data-testid="plan-empty-state"][data-plan-id="${plan.id}"]`);
  await emptyState.waitFor({ state: "visible", timeout: 15000 });

  assert.equal(await page.locator('[data-testid="scene-chain-item"]').count(), 0, "an empty plan must render zero scene-chain-items");
  assert.equal(await page.locator('[data-testid="scene-actions-bar"]').count(), 0, "an empty plan must render zero per-scene actions bars -- there is no scene yet");

  const addSceneBtn = emptyState.locator('[data-testid="plan-add-scene-btn"]');
  assert.equal(await addSceneBtn.count(), 1, "the empty-plan screen's only construction action must be +Add scene");
});

test("adding a scene from the empty-plan screen attaches it to the active plan (real POST .../plans/:planId/scenes round trip) and it becomes the plan's own chain item", async () => {
  const plan = await createPlanViaRoute(base, WORLD, "Empty Plan Gets Its First Scene");

  await page.goto(`${base}/#session-planner/plan/${plan.id}`);
  const emptyState = page.locator(`[data-testid="plan-empty-state"][data-plan-id="${plan.id}"]`);
  await emptyState.waitFor({ state: "visible", timeout: 15000 });

  await emptyState.locator('[data-testid="plan-add-scene-btn"]').click();
  const panel = page.locator('[data-testid="plan-add-scene-panel"]');
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const placeStep = panel.locator('[data-testid="plan-add-scene-place-step"]');
  await placeStep.waitFor({ state: "visible", timeout: 5000 });
  const existingInput = placeStep.locator('[data-testid="plan-add-scene-place-input"]');
  await existingInput.fill("Plan-First Place A");
  const option = placeStep.locator('[data-testid="plan-add-scene-place-option"][data-entity-id="planfirst-a"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const linkStep = panel.locator('[data-testid="plan-add-scene-link-step"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });
  await linkStep.locator('[data-testid="plan-add-scene-link-no-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 1, { timeout: 10000 });
  }, "adding a scene from the empty-plan screen must render it as the plan's first chain item");

  const newSceneId = await page.locator('[data-testid="scene-chain-item"]').getAttribute("data-scene-id");
  const planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.ok(planAfter.plan.sceneIds.includes(newSceneId), "the newly-created scene must be a real, persisted member of the active plan -- not just a UI-only append");
});

test("deep-linking a specific scene that IS a member of a plan resolves and scopes the chain to that plan's own scenes", async () => {
  const sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "planfirst-a" });
  const sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "planfirst-b" });
  const outsiderScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "planfirst-outsider" });
  const plan = await createPlanViaRoute(base, WORLD, "Deep-Link Resolves Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);

  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length >= 1, { timeout: 15000 });

  const ids = await page.locator('[data-testid="scene-chain-item"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.ok(ids.includes(sceneA.id) && ids.includes(sceneB.id), "deep-linking a plan-member scene must show every OTHER scene in that same plan too");
  assert.ok(!ids.includes(outsiderScene.id), "deep-linking a plan-member scene must NOT show a scene outside that plan, even though it exists in the same world");

  const itemA = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneA.id}"]`);
  assert.equal(await itemA.getAttribute("data-current"), "true", "the deep-linked scene itself must be the current/expanded item");
});
