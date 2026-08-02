// Phase 25 task 25.0, REQUIRED SCENARIO 7 -- "playerKnown hard gate: assert
// this field is NEVER visible via the same one-tap expand as description/
// tags; requires a distinct, separate confirm step, real DOM assertion
// that the value isn't present in the DOM at all until that separate step
// fires (not just visually hidden via CSS)." Read table-mode-fixture.mjs's
// header FIRST (§4 is this file's own section, the playerKnown-gate half).
// EXPECTED TO FAIL right now -- none of `table-roster-playerknown-gate-btn`
// / `table-roster-playerknown-confirm-panel` / `table-roster-playerknown-
// value` exists yet. That failure is the deliverable of this task, not a
// bug in this file.
//
// Every assertion in this file that checks "the value is absent" uses
// `document.querySelector(...) === null` (via page.evaluate), NEVER
// `.isVisible()`/`.isHidden()` -- the whole point of this scenario is that
// a CSS-hidden-but-present element (e.g. display:none) would be a FAILED
// implementation, and only a real DOM-presence check catches that
// distinction. A naive `expect(locator).toBeHidden()`-shaped assertion
// would incorrectly PASS a display:none leak; this file deliberately never
// uses that shape.
//
// FIXTURE: one anchor entity with playerKnown:true (a real WF entity field,
// confirmed live in foundry_worldFabric/graph-service.mjs's upsertEntity
// field list, boolean-typed per graph-import/writeup-import.mjs's own
// z.boolean().optional() schema).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoTableMode,
  DESKTOP_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-pk-");
const WORLD = "e2e-tablemode-pk-world";
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
      id: "tmpk-anchor", name: "Player Known Gate Anchor", type: "place", importance: 0.5,
      description: "Ordinary description text, must render on plain expand.",
      playerKnown: true
    }
  }
]);

let server, base, browser, page;
let scene;

const entityId = "tmpk-anchor";

/** Real DOM-absence check -- never CSS-visibility-based. See header. */
async function playerKnownValueCount(pg) {
  return pg.evaluate(() => document.querySelectorAll('[data-testid="table-roster-playerknown-value"]').length);
}

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

test("the plain roster expand renders description, but zero playerKnown-value elements exist anywhere in the DOM", async () => {
  await gotoTableMode(page, base, scene.id);
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();

  const detail = page.locator(`[data-testid="table-roster-detail"][data-entity-id="${entityId}"]`);
  await detail.waitFor({ state: "visible", timeout: 10000 });
  assert.match((await detail.locator('[data-testid="table-roster-detail-description"]').textContent()) ?? "", /Ordinary description text/, "the plain expand must still show ordinary fields like description");

  assert.equal(await playerKnownValueCount(page), 0, "zero table-roster-playerknown-value elements may exist in the DOM after only the general (non-gated) expand -- playerKnown must never ride along with the casual reveal");
});

test("clicking the gate button reveals a confirm panel, but the value STILL does not exist in the DOM until confirm is actually clicked", async () => {
  await gotoTableMode(page, base, scene.id);
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();

  const gateBtn = page.locator(`[data-testid="table-roster-playerknown-gate-btn"][data-entity-id="${entityId}"]`);
  await gateBtn.waitFor({ state: "visible", timeout: 10000 });
  await gateBtn.click();

  const confirmPanel = page.locator('[data-testid="table-roster-playerknown-confirm-panel"]');
  await confirmPanel.waitFor({ state: "visible", timeout: 10000 });

  assert.equal(await playerKnownValueCount(page), 0, "the gate button alone (before the explicit confirm click) must NOT be enough to put the real value into the DOM -- this is the 'harder, more deliberate gate than a plain expand' the design record requires");
});

test("clicking confirm puts the real playerKnown value into the DOM, carrying the actual seeded value", async () => {
  await gotoTableMode(page, base, scene.id);
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();
  await page.locator(`[data-testid="table-roster-playerknown-gate-btn"][data-entity-id="${entityId}"]`).click();

  const confirmBtn = page.locator('[data-testid="table-roster-playerknown-confirm-btn"]');
  await confirmBtn.waitFor({ state: "visible", timeout: 10000 });
  await confirmBtn.click();

  const value = page.locator('[data-testid="table-roster-playerknown-value"]');
  await value.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await value.count(), 1);
  assert.equal(await value.getAttribute("data-player-known"), "true", "the revealed value must reflect the real seeded playerKnown:true, not a placeholder");
});

test("cancelling the confirm panel leaves the value permanently absent (does not fall back to revealing it anyway)", async () => {
  await gotoTableMode(page, base, scene.id);
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();
  await page.locator(`[data-testid="table-roster-playerknown-gate-btn"][data-entity-id="${entityId}"]`).click();

  const cancelBtn = page.locator('[data-testid="table-roster-playerknown-cancel-btn"]');
  await cancelBtn.waitFor({ state: "visible", timeout: 10000 });
  await cancelBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => !document.querySelector('[data-testid="table-roster-playerknown-confirm-panel"]'), { timeout: 5000 });
  }, "cancelling must dismiss the confirm panel");
  assert.equal(await playerKnownValueCount(page), 0, "cancelling must never leak the real value into the DOM");
});
