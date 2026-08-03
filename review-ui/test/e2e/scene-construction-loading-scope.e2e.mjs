// Phase 23 task 23.0, REQUIRED SCENARIO 10 -- "Loading-affordance scope:
// withSlowNotice-style loading UI appears ONLY for develop-scene and
// quick-gen submissions -- never for chain navigation, add/remove-node, or
// rollback actions." Read scene-construction-fixture.mjs's header first
// (§9 is this file's own section). EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- none of this DOM exists
// yet. That failure is the deliverable of this task, not a bug in this
// file.
//
// Mirrors combat-planning-loading-scope.e2e.mjs's own established method
// EXACTLY: every genuinely-local/deterministic route under test is
// route-intercepted and ARTIFICIALLY DELAYED past withSlowNotice's own
// ~1500ms threshold via route.continue() (never route.fulfill() -- these
// are real, deterministic, non-LLM requests against the real server, so
// letting them actually complete for real afterward is both possible and
// correct), while polling, DURING the delay window, that
// `[data-testid="still-working-indicator"]` never appears ANYWHERE in the
// view. The two genuine LLM call sites (develop-scene, quick-gen) are fully
// MOCKED via route.fulfill() with an artificial delay, matching
// scene-construction-develop.e2e.mjs's / scene-construction-quick-gen
// .e2e.mjs's own established no-API-key-available reasoning.
//
// ***UPDATED by Phase 27 task 27.0*** (F5/F6: the construction view's own
// top-level "+ Quick add scene" -- `quick-add-scene-btn`/-panel/-name-input/
// -submit-btn/-status, this file's own THIRD test's original target -- is
// RETIRED ENTIRELY (see phase27-fixture.mjs's header §7). Table Mode's OWN,
// separate `table-quick-gen-*` control is UNTOUCHED by F5/F6 and already
// wires the SAME still-working-indicator pattern this file's original test
// was checking (buildTableQuickGenControl's own withSlowNoticeIndicator
// call, confirmed live and unaffected by this phase) -- re-asserting that
// ALREADY-GREEN behavior here would not be a genuine Phase-27 red test, so
// this file's third test is updated to assert the RETIREMENT instead (real
// DOM-absence for the construction view's own quick-add-scene mechanism,
// including its still-working-indicator scope), matching this file's own
// §9 "loading-affordance scope" contract. EXPECTED TO FAIL right now: the
// construction view's `quick-add-scene-btn`/-panel/-status are still live
// today (confirmed fresh against the real session-planner-view.js), so the
// absence assertion below currently fails. Not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-loadscope-");
const WORLD = "e2e-scconstruct-loadscope-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const HOLD_MS = 2200; // comfortably longer than withSlowNotice's own ~1500ms threshold
const POLL_INTERVAL_MS = 150;

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "loadscope-anchor", name: "Load-Scope Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "loadscope-other", name: "Load-Scope Other Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "loadscope-addable", name: "Load-Scope Addable", type: "place", importance: 0.5 } }
  // loadscope-addable: deliberately zero edges -- unreachable, so add-node
  // takes the direct-add (no offer) branch, keeping this file's own concern
  // scoped to loading-affordance timing, not reachability branching (that's
  // scene-construction-add-node.e2e.mjs's job).
]);

let server, base, browser, page;
let scene, otherScene;

async function assertIndicatorNeverAppearsFor(pg, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const count = await pg.locator('[data-testid="still-working-indicator"]').count();
    assert.equal(count, 0, `[still-working-indicator] must never appear anywhere in the view during "${label}" -- it is not one of this phase's two LLM call sites (develop-scene, quick-gen)`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "loadscope-anchor" });
  otherScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "loadscope-other" });

  // Pre-seed a real scene-undo session with one action so undo-last has
  // something real to do during this file's own delayed-undo-last test.
  await fetch(`${base}/api/scene-planning/scenes/${scene.id}/undo/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: WORLD })
  });
  await fetch(`${base}/api/scene-planning/scenes/${scene.id}/undo/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, action: { kind: "edit_node", description: "seed action", graphMutations: [{ op: "discard_prep_content", entityId: "loadscope-anchor" }] } })
  });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("chain-toggle navigation, add-node, and rollback actions NEVER show the loading indicator, even when artificially delayed past the withSlowNotice threshold", async () => {
  await page.route("**/api/scene-planning/scenes/*/members", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });
  await page.route("**/api/scene-planning/scenes/*/undo/last", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });
  await page.route("**/api/scene-planning/scenes/*/undo/all", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });

  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 15000 });

  // --- chain-toggle expand/collapse ---
  const otherToggle = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${otherScene.id}"] [data-testid="scene-chain-toggle"]`);
  await otherToggle.waitFor({ state: "visible", timeout: 5000 });
  const toggleDone = otherToggle.click();
  await assertIndicatorNeverAppearsFor(page, 1600, "chain-item expand/collapse");
  await toggleDone;

  // --- add-node (direct-add branch, artificially delayed) ---
  const addToggle = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="add-node-toggle"]`);
  await addToggle.waitFor({ state: "visible", timeout: 5000 });
  await addToggle.click();
  const addPanel = page.locator(`[data-testid="add-node-panel"][data-scene-id="${scene.id}"]`);
  await addPanel.waitFor({ state: "visible", timeout: 5000 });
  await addPanel.locator('[data-testid="add-node-input"]').fill("Load-Scope Addable");
  const option = addPanel.locator('[data-testid="add-node-option"][data-entity-id="loadscope-addable"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  const addDone = option.click();
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "add-node direct-add");
  await addDone;
  await page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="location-card"][data-entity-id="loadscope-addable"]`)
    .waitFor({ state: "visible", timeout: 10000 });

  // --- rollback: undo-last ---
  const rollbackPanel = page.locator(`[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"]`);
  await rollbackPanel.waitFor({ state: "visible", timeout: 5000 });
  const undoLastDone = rollbackPanel.locator('[data-testid="scene-rollback-undo-last-btn"]').click();
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "rollback undo-last");
  await undoLastDone;

  // --- rollback: undo-all (even on an already-empty session, still a real
  // local call worth confirming never shows the indicator) ---
  const undoAllDone = rollbackPanel.locator('[data-testid="scene-rollback-undo-all-btn"]').click();
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "rollback undo-all");
  await undoAllDone;

  await page.unroute("**/api/scene-planning/scenes/*/members");
  await page.unroute("**/api/scene-planning/scenes/*/undo/last");
  await page.unroute("**/api/scene-planning/scenes/*/undo/all");
});

test("develop-scene shows the loading indicator, scoped to develop-scene-status (LLM call site #1, mocked -- no live API key needed)", async () => {
  await page.route("**/api/scene-planning/scenes/*/develop", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sceneId: scene.id, results: [] }) });
  });

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const developBtn = page.locator(`[data-testid="develop-scene-btn"][data-scene-id="${scene.id}"]`);
  await developBtn.waitFor({ state: "visible", timeout: 15000 });
  const clickDone = developBtn.click();

  await assert.doesNotReject(async () => {
    await page.locator(`[data-testid="develop-scene-status"][data-scene-id="${scene.id}"] [data-testid="still-working-indicator"]`)
      .waitFor({ state: "visible", timeout: HOLD_MS + 3000 });
  }, "the still-working-indicator must appear inside develop-scene-status while the (mocked, artificially-delayed) develop-scene request is in flight");

  await clickDone;
  await page.unroute("**/api/scene-planning/scenes/*/develop");
});

test("Phase 27 (F5/F6): the construction view's OWN quick-add-scene mechanism (and its loading-indicator scope) is retired entirely -- real DOM-absence", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length >= 1, { timeout: 15000 });

  for (const testid of ["quick-add-scene-btn", "quick-add-scene-panel", "quick-add-scene-status"]) {
    const count = await page.evaluate((t) => document.querySelectorAll(`[data-testid="${t}"]`).length, testid);
    assert.equal(count, 0, `${testid} must be COMPLETELY REMOVED from the construction view (F5/F6) -- folded into the plan-level +Scene control, which never calls quick-gen at all`);
  }
});
