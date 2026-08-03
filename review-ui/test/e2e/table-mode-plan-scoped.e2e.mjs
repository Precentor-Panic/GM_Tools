// Phase 26 task 26.0, REQUIRED SCENARIO 7 -- "Table Mode is Plan-scoped:
// 'Start new plan' / active Plan's scenes (current expanded, rest
// collapsed) / other Plans (collapsed) -- replaces the old flat 'all
// scenes' list contract from table-mode-navigation.e2e.mjs/table-mode-
// search.e2e.mjs." Read phase26-fixture.mjs's header FIRST (§7 is this
// file's own section). EXPECTED TO FAIL right now -- none of `table-start-
// new-plan-btn`/`table-active-plan-list`/`table-other-plans-list` exists
// yet, and `table-full-list` (asserted absent below) is still very much
// present in the current, not-yet-reworked UI. That failure is the
// deliverable of this task, not a bug in this file.
//
// See table-mode-navigation.e2e.mjs's own updated header for exactly which
// of ITS tests were removed as now-stale (the flat full-list ones) versus
// kept unchanged (the adjacent-strip ones, unaffected by Plan-scoping).
//
// FIXTURE: three scenes ("tmplan-a/b/c"), all graph-disconnected from each
// other (no adjacency, so nothing here is reachable via the UNCHANGED
// adjacent-scenes strip -- isolating this file's assertions to the NEW
// Plan-scoped structure specifically, not an accidental overlap with §3's
// still-valid hop-1 mechanism).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";
import { tableModeHash, gotoTableMode } from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-tmplan-");
const WORLD = "e2e-tmplan-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmplan-a", name: "TM Plan Scene A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmplan-b", name: "TM Plan Scene B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmplan-c", name: "TM Plan Scene C", type: "place", importance: 0.5 } }
  // deliberately no edges
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmplan-a" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmplan-b" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmplan-c" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("table-full-list (the old flat 'all scenes' list) is DOM-absent entirely in Table Mode", async () => {
  await gotoTableMode(page, base, sceneA.id);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const fullListCount = await page.evaluate(() => document.querySelectorAll('[data-testid="table-full-list"]').length);
  const fullListItemCount = await page.evaluate(() => document.querySelectorAll('[data-testid="table-full-list-item"]').length);
  assert.equal(fullListCount, 0, "table-full-list must be COMPLETELY REMOVED -- superseded by Plan-scoped browsing (§26.8)");
  assert.equal(fullListItemCount, 0, "table-full-list-item must be gone too");
});

test("with NO active Plan for this scene, 'Start new plan' is the visible entry point (no active-plan-list, no other-plans-list yet)", async () => {
  await gotoTableMode(page, base, sceneA.id);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const startBtn = page.locator('[data-testid="table-start-new-plan-btn"]');
  await startBtn.waitFor({ state: "visible", timeout: 10000 });

  // Deliberately distinct from the pre-existing, unrelated Phase 20 control.
  assert.equal(await page.locator('[data-testid="session-planner-start-new"]').count(), 0, "Table Mode must never render the UNRELATED Phase 20 'start a fresh scene chain' control -- table-start-new-plan-btn is a genuinely different, new control");

  assert.equal(await page.locator('[data-testid="table-active-plan-list"]').count(), 0, "no active-plan-list should render before any Plan exists for this scene");
});

test("'Start new plan' creates a real Plan (via the real routes), adds the current scene, and becomes the active Plan -- rendered as an OPEN <details> with the current scene expanded/marked", async () => {
  await gotoTableMode(page, base, sceneA.id);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  await page.locator('[data-testid="table-start-new-plan-btn"]').click();
  const panel = page.locator('[data-testid="table-start-new-plan-panel"]');
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="table-start-new-plan-name-input"]').fill("Session 1 — The Opening Act");
  await panel.locator('[data-testid="table-start-new-plan-submit-btn"]').click();

  const activeList = page.locator('[data-testid="table-active-plan-list"]');
  await activeList.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await activeList.evaluate((el) => el.tagName.toLowerCase()), "details", "table-active-plan-list must be a real <details> element");
  assert.equal(await activeList.evaluate((el) => el.open), true, "the active Plan's own scene list must be OPEN by default (current expanded)");

  const currentItem = activeList.locator(`[data-testid="table-active-plan-scene-item"][data-scene-id="${sceneA.id}"]`);
  await currentItem.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await currentItem.getAttribute("data-current"), "true", "the currently-displayed scene's own entry must be marked data-current=\"true\"");

  // Confirm via the REAL Plan routes, not just DOM state.
  const plansRes = await (await fetch(`${base}/api/scene-planning/plans?world=${WORLD}`)).json();
  const plan = plansRes.plans.find((p) => p.name === "Session 1 — The Opening Act");
  assert.ok(plan, "a real Plan must have been created via the real POST /api/scene-planning/plans route");
  assert.ok(plan.sceneIds.includes(sceneA.id), "the current scene must be a real member of the newly-created Plan");
});

test("scenes belonging to the active Plan render inside table-active-plan-list; a DIFFERENT Plan (not active) renders COLLAPSED under table-other-plans-list, revealing its scenes only on expand", async () => {
  const activePlan = await createPlanViaRoute(base, WORLD, "Active Plan For This Test");
  await addSceneToPlanViaRoute(base, WORLD, activePlan.id, sceneB.id);
  const otherPlan = await createPlanViaRoute(base, WORLD, "A Completely Different Plan");
  await addSceneToPlanViaRoute(base, WORLD, otherPlan.id, sceneC.id);

  // Make activePlan the active one by starting Table Mode on one of its own
  // member scenes -- the SAME real "start new plan"-adjacent mechanism
  // (this suite does not pin the exact activation trigger beyond "viewing a
  // scene that belongs to exactly one Plan makes that Plan active" -- a
  // reasonable, defensible interpretation of "active Plan" this suite locks
  // in via observable behavior, not implementation detail).
  await gotoTableMode(page, base, sceneB.id);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const activeList = page.locator('[data-testid="table-active-plan-list"]');
  await activeList.waitFor({ state: "visible", timeout: 10000 });
  const activeItem = activeList.locator(`[data-testid="table-active-plan-scene-item"][data-scene-id="${sceneB.id}"]`);
  assert.equal(await activeItem.count(), 1, "scene B must render under the active Plan's own scene list");

  const otherPlansList = page.locator('[data-testid="table-other-plans-list"]');
  await otherPlansList.waitFor({ state: "visible", timeout: 10000 });
  const otherPlanItem = otherPlansList.locator(`[data-testid="table-other-plan-item"][data-plan-id="${otherPlan.id}"]`);
  await otherPlanItem.waitFor({ state: "attached", timeout: 5000 });
  assert.equal(await otherPlanItem.evaluate((el) => el.tagName.toLowerCase()), "details", "each other-plan-item must be a real <details> element");
  assert.equal(await otherPlanItem.evaluate((el) => el.open), false, "a non-active Plan must render COLLAPSED by default");

  // Scene C (member of the OTHER plan) must not be visible until expanded.
  const hiddenSceneItem = otherPlanItem.locator(`[data-testid="table-other-plan-scene-item"][data-scene-id="${sceneC.id}"]`);
  assert.equal(await hiddenSceneItem.isVisible().catch(() => false), false, "the other Plan's own scene items must not be visible while collapsed");

  await otherPlanItem.locator('[data-testid="table-other-plan-toggle"]').click();
  await hiddenSceneItem.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await otherPlanItem.evaluate((el) => el.open), true, "expanding the other-plan-item must reveal its own member scenes");
});

test("clicking a scene inside the ACTIVE plan's list navigates and stays in Table Mode", async () => {
  const plan = await createPlanViaRoute(base, WORLD, "Nav Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);

  await gotoTableMode(page, base, sceneA.id);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const target = page.locator(`[data-testid="table-active-plan-scene-item"][data-scene-id="${sceneB.id}"]`);
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction((h) => location.hash === `#${h}`, tableModeHash(sceneB.id), { timeout: 5000 });
  }, "clicking an active-plan scene item must navigate straight there, staying in Table Mode");
});
