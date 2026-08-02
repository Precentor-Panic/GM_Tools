// Phase 25 task 25.0, REQUIRED SCENARIOS 3 + 5 -- "Adjacent-scenes strip:
// seed a real multi-scene chain, assert the immediate hop-1 neighbors
// render as single-tap targets, no picker/no intermediate step" and
// "Collapsed full list: the full scene list renders collapsed by default
// beneath the adjacent-scenes strip, expandable." Read
// table-mode-fixture.mjs's header FIRST (§3 is this file's own section).
// EXPECTED TO FAIL right now -- none of `table-nav-zone`/
// `table-adjacent-strip`/`table-full-list` exists yet. That failure is the
// deliverable of this task, not a bug in this file.
//
// FIXTURE: a straight-line chain of 4 place entities (a-b-c-d), matching
// scene-construction-chain-display.e2e.mjs's / scenes-tab-linkage.e2e.mjs's
// own established chain-fixture shape exactly. This suite enters Table Mode
// on scene B specifically (the middle of the chain, NOT an endpoint) so it
// has TWO real hop-1 neighbors (A and C) -- proving the strip surfaces every
// immediate neighbor, not just "the next one" -- while D (hop-2 from B)
// must NOT appear in the adjacent strip, only in the full list.
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

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-nav-");
const WORLD = "e2e-tablemode-nav-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmnav-a", name: "Nav Chain A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmnav-b", name: "Nav Chain B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmnav-c", name: "Nav Chain C", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmnav-d", name: "Nav Chain D", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "tmnav-e0", sourceId: "tmnav-a", targetId: "tmnav-b", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "tmnav-e1", sourceId: "tmnav-b", targetId: "tmnav-c", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "tmnav-e2", sourceId: "tmnav-c", targetId: "tmnav-d", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC, sceneD;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  // Scrambled creation order, matching this project's established
  // "an implementation that just echoes creation order would be caught"
  // reasoning (scene-construction-chain-display.e2e.mjs / scenes-tab-
  // linkage.e2e.mjs's own precedent).
  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-a" });
  sceneD = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-d" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-b" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-c" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("the adjacent-scenes strip shows exactly the hop-1 neighbors (A, C) of scene B, and NOT the hop-2 neighbor (D) or scene B itself", async () => {
  await gotoTableMode(page, base, sceneB.id);

  const strip = page.locator('[data-testid="table-adjacent-strip"]');
  await strip.waitFor({ state: "visible", timeout: 15000 });

  const items = strip.locator('[data-testid="table-adjacent-scene-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length === 2,
      '[data-testid="table-adjacent-strip"] [data-testid="table-adjacent-scene-item"]',
      { timeout: 10000 }
    );
  }, "expected exactly 2 adjacent-scene items (A and C) for scene B");
  assert.equal(await items.count(), 2);

  const ids = await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.deepEqual(new Set(ids), new Set([sceneA.id, sceneC.id]), "the adjacent strip must contain exactly scene A and scene C, the two real hop-1 neighbors of scene B");
  assert.ok(!ids.includes(sceneB.id), "scene B must never list itself as its own adjacent neighbor");
  assert.ok(!ids.includes(sceneD.id), "scene D is hop-2 from B -- must not appear in the adjacent strip");
});

test("clicking an adjacent-scene item is a single tap that jumps directly to that scene, staying in Table Mode", async () => {
  await gotoTableMode(page, base, sceneB.id);

  const itemC = page.locator(`[data-testid="table-adjacent-strip"] [data-testid="table-adjacent-scene-item"][data-scene-id="${sceneC.id}"]`);
  await itemC.waitFor({ state: "visible", timeout: 15000 });
  await itemC.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}?mode=table`,
      sceneC.id,
      { timeout: 5000 }
    );
  }, "clicking an adjacent-scene item must navigate straight to that scene's own Table Mode URL, no intermediate picker step");

  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), sceneC.id);
});

test("the full scene list renders as a collapsed <details> by default, beneath the adjacent-scenes strip", async () => {
  await gotoTableMode(page, base, sceneB.id);

  const fullList = page.locator('[data-testid="table-full-list"]');
  await fullList.waitFor({ state: "attached", timeout: 15000 });
  assert.equal(await fullList.evaluate((el) => el.tagName.toLowerCase()), "details", "table-full-list must be a real <details> element -- free, JS-free collapse, matching this project's established scene-chain-item precedent");
  assert.equal(await fullList.evaluate((el) => el.open), false, "the full scene list must be COLLAPSED by default");

  // DOM order: the adjacent strip must precede the full list (§3a: "beneath
  // the adjacent-scenes strip").
  const zone = page.locator('[data-testid="table-nav-zone"]');
  const order = await zone.evaluate((el) => {
    const strip = el.querySelector('[data-testid="table-adjacent-strip"]');
    const list = el.querySelector('[data-testid="table-full-list"]');
    if (!strip || !list) return null;
    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    return !!(strip.compareDocumentPosition(list) & 4);
  });
  assert.equal(order, true, "the full list must come AFTER (below) the adjacent-scenes strip in DOM order");

  // Items are not present/visible while collapsed.
  const itemsWhileCollapsed = fullList.locator('[data-testid="table-full-list-item"]');
  assert.equal(await itemsWhileCollapsed.first().isVisible().catch(() => false), false, "full-list items must not be visible while the <details> is collapsed");
});

test("expanding the full list reveals all 4 scenes in the world, each a working navigation link (staying in Table Mode)", async () => {
  await gotoTableMode(page, base, sceneB.id);

  const fullList = page.locator('[data-testid="table-full-list"]');
  const toggle = fullList.locator('[data-testid="table-full-list-toggle"]');
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  await toggle.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="table-full-list-item"]').length === 4, { timeout: 10000 });
  }, "expanding the full list must reveal all 4 scenes (a,b,c,d)");
  assert.equal(await fullList.evaluate((el) => el.open), true);

  const itemD = fullList.locator(`[data-testid="table-full-list-item"][data-scene-id="${sceneD.id}"]`);
  await itemD.waitFor({ state: "visible", timeout: 5000 });
  await itemD.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}?mode=table`,
      sceneD.id,
      { timeout: 5000 }
    );
  }, "clicking a full-list item (scene D, a non-adjacent scene from B) must jump straight to that scene, in Table Mode");
  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), sceneD.id);
});
