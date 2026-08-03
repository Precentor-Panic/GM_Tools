// ***SUPERSEDED by Phase 26 task 26.0*** (plans/phase-26-tasks.md §26.F/
// task 26.10). This file ORIGINALLY (Phase 25 task 25.0) asserted the
// `playerKnown` hard-gate contract (`table-roster-playerknown-gate-btn`
// requiring a separate confirm step before the real value ever entered the
// DOM). Phase 26's grounding (§26.F) found `buildPlayerKnownGate` to be a
// pure read-only status display with no real action behind it (the project
// owner's own assessment: "I don't care if I know that they know about some
// element... nor do I know how this... would even know to tell me this
// information") and REMOVES it entirely, replacing it with a genuine action
// -- "Drop this into Foundry" (drop-into-foundry.e2e.mjs's own new
// contract, per phase26-fixture.mjs's header §9).
//
// This file's ORIGINAL assertions (that the playerKnown gate exists and
// works a certain way) are now WRONG under the new contract -- rewritten
// here to assert the mechanism's ABSENCE instead, per plans/phase-26-tasks
// .md's own explicit instruction ("update the now-stale existing tests
// rather than leaving them contradictory"), mirroring scene-construction-
// insert-between.e2e.mjs's own "rewrite to assert absence" approach for the
// same reason.
//
// EXPECTED TO FAIL right now: `table-roster-playerknown-gate-btn` and its
// siblings are still very much present in the current, not-yet-reworked UI
// (Phase 25's real, live, unmodified `buildPlayerKnownGate`) -- these
// DOM-absence assertions will currently FAIL for that reason. That failure
// is the deliverable of this task, not a bug in this file.
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

test("***Phase 26 fix***: the plain roster expand still renders description, and the OLD playerKnown-gate DOM is COMPLETELY GONE (real DOM-absence, not CSS-hidden)", async () => {
  await gotoTableMode(page, base, scene.id);
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();

  const detail = page.locator(`[data-testid="table-roster-detail"][data-entity-id="${entityId}"]`);
  await detail.waitFor({ state: "visible", timeout: 10000 });
  assert.match((await detail.locator('[data-testid="table-roster-detail-description"]').textContent()) ?? "", /Ordinary description text/, "the plain expand must still show ordinary fields like description -- unaffected by this removal");

  const oldGateSelectors = [
    '[data-testid="table-roster-playerknown-gate-btn"]',
    '[data-testid="table-roster-playerknown-confirm-panel"]',
    '[data-testid="table-roster-playerknown-confirm-btn"]',
    '[data-testid="table-roster-playerknown-cancel-btn"]',
    '[data-testid="table-roster-playerknown-value"]'
  ];
  for (const sel of oldGateSelectors) {
    const count = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    assert.equal(count, 0, `${sel} must be COMPLETELY REMOVED per §26.F -- see drop-into-foundry.e2e.mjs for the replacement 'Drop this into Foundry' contract`);
  }
});

test("***Phase 26 fix***: the same absence holds even without expanding -- the old gate never lazily mounts elsewhere on the page either", async () => {
  await gotoTableMode(page, base, scene.id);
  await page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`).waitFor({ state: "visible", timeout: 15000 });
  const count = await page.evaluate(() => document.querySelectorAll('[data-testid="table-roster-playerknown-gate-btn"]').length);
  assert.equal(count, 0, "the old gate button must not exist anywhere on the page, expanded or not");
});
