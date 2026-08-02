// Phase 23 task 23.0, REQUIRED SCENARIO 6 -- "Scene-local rollback: visible
// directly in the scene UI (not behind Settings/gear), wired to the real
// undo-session routes; undo-last and undo-all both reachable and
// functionally distinct." Read scene-construction-fixture.mjs's header
// first (§5 is this file's own section). EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- none of this DOM exists
// yet. That failure is the deliverable of this task, not a bug in this
// file.
//
// Seeds a real scene-undo session with 2 REAL recorded actions directly via
// the real, already-shipped Phase 22 routes
// (POST .../undo/start, POST .../undo/record x2) -- not hand-built
// fixture JSON -- so this file can assert the rollback panel reads real
// server state on load, before testing that undo-last/undo-all are
// distinct.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-rollback-");
const WORLD = "e2e-scconstruct-rollback-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rollback-anchor", name: "Rollback Anchor", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let scene;

async function seedUndoAction(description, entityId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/undo/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: WORLD,
      action: {
        kind: "edit_node",
        description,
        graphMutations: [{ op: "discard_prep_content", entityId }]
      }
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `undo/record setup itself must succeed (got ${res.status}: ${JSON.stringify(body)})`);
  return body;
}

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rollback-anchor" });

  const startRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/undo/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD })
  });
  assert.equal(startRes.status, 200, "undo/start setup itself must succeed");

  await seedUndoAction("Developed content for entity \"rollback-anchor\" (first).", "rollback-anchor");
  await seedUndoAction("Developed content for entity \"rollback-anchor\" (second).", "rollback-anchor");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("the rollback panel lives directly in the scene UI (never behind Settings) and shows the real, already-recorded action history on load", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const panel = page.locator(`[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 15000 });

  // Confirm it's NOT inside the settings view at all -- must be reachable
  // from #session-planner/<id> directly, no navigation to #settings.
  assert.equal(new URL(page.url()).hash.startsWith("#session-planner"), true, "the rollback panel must be visible while still on the Session Planner hash route, not after navigating to Settings");
  assert.equal(await page.locator("#view-settings.active").count(), 0, "the Settings view must not be the active view while the rollback panel is visible");

  const items = panel.locator('[data-testid="scene-rollback-action-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 2,
      `[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"] [data-testid="scene-rollback-action-item"]`,
      { timeout: 10000 }
    );
  }, "expected exactly the 2 real, pre-seeded undo actions to render");
  assert.equal(await items.count(), 2);
});

test("undo-last removes exactly the most recent action; undo-all then clears everything -- two distinct, functionally different actions", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const panel = page.locator(`[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(
    (selector) => document.querySelectorAll(selector).length === 2,
    `[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"] [data-testid="scene-rollback-action-item"]`,
    { timeout: 10000 }
  );

  const undoLastBtn = panel.locator('[data-testid="scene-rollback-undo-last-btn"]');
  const undoAllBtn = panel.locator('[data-testid="scene-rollback-undo-all-btn"]');
  await undoLastBtn.waitFor({ state: "visible", timeout: 5000 });
  await undoAllBtn.waitFor({ state: "visible", timeout: 5000 });

  await undoLastBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 1,
      `[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"] [data-testid="scene-rollback-action-item"]`,
      { timeout: 10000 }
    );
  }, "undo-last must remove exactly ONE action (the most recent), not all of them");

  const remainingText = (await panel.locator('[data-testid="scene-rollback-action-item"]').first().textContent()).trim();
  assert.match(remainingText, /first/, "undo-last must remove the SECOND (most recent) action, leaving the first one");

  const statusAfterLast = (await panel.locator('[data-testid="scene-rollback-status"]').textContent()).trim();
  assert.notEqual(statusAfterLast, "", "undo-last must leave a real status message behind");

  // Confirm via the real server route too, not just UI state.
  const peekRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/undo?world=${WORLD}`);
  const peekBody = await peekRes.json();
  assert.equal(peekBody.actions.length, 1, "the real server-side undo session must also show exactly 1 remaining action");

  await undoAllBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      `[data-testid="scene-rollback-panel"][data-scene-id="${scene.id}"] [data-testid="scene-rollback-action-item"]`,
      { timeout: 10000 }
    );
  }, "undo-all must clear every remaining action");

  const statusAfterAll = (await panel.locator('[data-testid="scene-rollback-status"]').textContent()).trim();
  assert.notEqual(statusAfterAll, "", "undo-all must leave a real status message behind");
  assert.notEqual(statusAfterAll, statusAfterLast, "undo-last and undo-all must produce genuinely DIFFERENT status messages -- proving these are two distinct actions, not the same mechanism under two labels");

  const peekRes2 = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/undo?world=${WORLD}`);
  const peekBody2 = await peekRes2.json();
  assert.equal(peekBody2.actions.length, 0, "the real server-side undo session must be empty after undo-all");
});
