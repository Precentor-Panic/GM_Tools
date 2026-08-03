// Phase 26 task 26.0, REQUIRED SCENARIO 9 -- "'Drop this into Foundry'
// renders in place of the old playerKnown gate, gated behind a real
// confirm step, shows a loading state during the (mocked) push, and the old
// player-known-gate/'Reveal player-known status' DOM is gone entirely."
// Read phase26-fixture.mjs's header FIRST (§9 is this file's own section).
// EXPECTED TO FAIL right now -- `table-roster-foundry-push-btn` doesn't
// exist yet, AND the old `table-roster-playerknown-gate-btn` (asserted
// absent below) is still very much present in the current, not-yet-reworked
// UI. Both are the deliverable of this task, not a bug in this file. See
// table-mode-player-known-gate.e2e.mjs's own updated header for why THAT
// file's old presence-asserting contract was rewritten rather than left
// silently contradictory.
//
// The real POST /api/entities/:entityId/foundry-push route is MOCKED via
// page.route() -- per §26.F, the real route wraps headless Chromium login +
// gm-say.mjs's ChatMessage.create, genuinely slow/external, never
// re-invoked for real inside an already-running Playwright session
// (matching this project's established "mock at the route boundary for
// slow/external actions" convention, e.g. scene-construction-quick-gen
// .e2e.mjs's own page.route() precedent).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";
import { gotoTableMode } from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-dropfoundry-");
const WORLD = "e2e-dropfoundry-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  {
    op: "upsert_entity",
    data: {
      id: "dropfoundry-anchor", name: "Drop-Into-Foundry Anchor", type: "place", importance: 0.5,
      description: "A description that could be pushed into Foundry chat.",
      playerKnown: true
    }
  }
]);

let server, base, browser, page;
let scene;
const entityId = "dropfoundry-anchor";

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: entityId });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function expandRosterDetail() {
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();
  const detail = page.locator(`[data-testid="table-roster-detail"][data-entity-id="${entityId}"]`);
  await detail.waitFor({ state: "visible", timeout: 10000 });
  return detail;
}

test("the old playerKnown gate DOM is gone entirely -- real DOM-absence, and the old 'Reveal player-known status' text is nowhere on the page", async () => {
  await gotoTableMode(page, base, scene.id);
  await expandRosterDetail();

  const oldGateCount = await page.evaluate(() =>
    document.querySelectorAll(
      '[data-testid="table-roster-playerknown-gate-btn"], [data-testid="table-roster-playerknown-confirm-panel"], [data-testid="table-roster-playerknown-confirm-btn"], [data-testid="table-roster-playerknown-cancel-btn"], [data-testid="table-roster-playerknown-value"]'
    ).length
  );
  assert.equal(oldGateCount, 0, "every old playerKnown-gate selector must be COMPLETELY REMOVED (§26.F)");

  const bodyText = await page.evaluate(() => document.body.textContent ?? "");
  assert.ok(!/reveal player-known status/i.test(bodyText), "the old 'Reveal player-known status…' text must not appear anywhere on the page");
});

test("'Drop this into Foundry' renders in the roster detail, requires a real confirm step, shows a loading state during the mocked push, and reports success", async () => {
  let pushCallCount = 0;
  await page.route(`**/api/entities/${entityId}/foundry-push`, async (route) => {
    pushCallCount++;
    // Artificial delay so the loading affordance has a real window to appear in.
    await new Promise((r) => setTimeout(r, 1800));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posted: true }) });
  });

  await gotoTableMode(page, base, scene.id);
  const detail = await expandRosterDetail();

  const pushBtn = detail.locator(`[data-testid="table-roster-foundry-push-btn"][data-entity-id="${entityId}"]`);
  await pushBtn.waitFor({ state: "visible", timeout: 10000 });
  await pushBtn.click();

  const confirmPanel = page.locator('[data-testid="table-roster-foundry-push-confirm-panel"]');
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });

  // The confirm click alone (before actually confirming) must not have
  // called the route yet -- a genuine gate, not a click-through.
  assert.equal(pushCallCount, 0, "opening the confirm panel must not itself trigger the real push -- confirmation must be a distinct, deliberate step");

  const confirmBtn = confirmPanel.locator('[data-testid="table-roster-foundry-push-confirm-btn"]');
  await confirmBtn.click();

  const indicator = page.locator('[data-testid="still-working-indicator"]');
  await assert.doesNotReject(async () => {
    await indicator.waitFor({ state: "visible", timeout: 3000 });
  }, "a genuinely slow (mocked ~1.8s) push must show this project's established still-working-indicator loading affordance, matching the withSlowNotice-style treatment §26.F explicitly requires");

  await indicator.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  const status = page.locator('[data-testid="table-roster-foundry-push-status"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.textContent ?? "").length > 0,
      '[data-testid="table-roster-foundry-push-status"]',
      { timeout: 5000 }
    );
  }, "the push must report success feedback once the mocked route resolves");

  assert.equal(pushCallCount, 1, "confirming must call the real foundry-push route exactly once");
  await page.unroute(`**/api/entities/${entityId}/foundry-push`);
});

test("cancelling the confirm panel never calls the route at all", async () => {
  let pushCallCount = 0;
  await page.route(`**/api/entities/${entityId}/foundry-push`, async (route) => {
    pushCallCount++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posted: true }) });
  });

  await gotoTableMode(page, base, scene.id);
  const detail = await expandRosterDetail();
  await detail.locator(`[data-testid="table-roster-foundry-push-btn"][data-entity-id="${entityId}"]`).click();

  const confirmPanel = page.locator('[data-testid="table-roster-foundry-push-confirm-panel"]');
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="table-roster-foundry-push-cancel-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => !document.querySelector('[data-testid="table-roster-foundry-push-confirm-panel"]'), { timeout: 5000 });
  }, "cancelling must dismiss the confirm panel");
  assert.equal(pushCallCount, 0, "cancelling must NEVER call the real foundry-push route");
  await page.unroute(`**/api/entities/${entityId}/foundry-push`);
});
