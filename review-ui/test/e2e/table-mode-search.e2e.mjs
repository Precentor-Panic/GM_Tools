// Phase 25 task 25.0, REQUIRED SCENARIO 4 -- "In-place search: typing in
// the nav-zone search bar filters to a real non-adjacent scene (seeded 3+
// hops away or in a disconnected chain) and opening it switches Table
// Mode's current scene WITHOUT navigating away from Table Mode (assert the
// mode toggle state / URL shape stays 'table mode,' only the sceneId
// argument changes)." Read table-mode-fixture.mjs's header FIRST (§3 is
// this file's own section). EXPECTED TO FAIL right now -- none of
// `table-nav-search-input`/`table-nav-search-results` exists yet. That
// failure is the deliverable of this task, not a bug in this file.
//
// FIXTURE: two entirely DISCONNECTED place entities (zero edges between
// them, or to anything) -- the strongest, least-ambiguous form of
// "non-adjacent" this project's own linkage query recognizes
// (linkedScenesForScene's corridor traversal can never find a path between
// two genuinely unconnected components, regardless of maxHops), so the
// origin scene's adjacent-scenes strip is guaranteed empty and the target
// scene is guaranteed reachable ONLY via search, never via the adjacent
// strip -- proving this scenario actually exercises search, not a strip
// entry that happens to also satisfy the assertion.
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

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-search-");
const WORLD = "e2e-tablemode-search-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmsearch-origin", name: "Search Origin Village", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmsearch-target", name: "Faraway Search Target Keep", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let originScene, targetScene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  originScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmsearch-origin" });
  targetScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmsearch-target" });

  // Sanity check on the real, already-shipped linkage route: confirms the
  // fixture's own premise (genuinely disconnected, zero linked scenes)
  // BEFORE testing the (not-yet-built) UI -- if this fails, the bug is in
  // this test's own fixture, not the UI under test below.
  const linkageRes = await fetch(`${base}/api/scene-planning/linkage?world=${WORLD}&sceneId=${originScene.id}`);
  const linkageBody = await linkageRes.json();
  assert.equal(linkageRes.status, 200, `sanity check on the real linkage route failed: ${JSON.stringify(linkageBody)}`);
  assert.equal(linkageBody.linked.length, 0, "sanity: the origin scene must have zero linked scenes -- confirms this fixture is a genuinely disconnected pair");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("the disconnected target scene does NOT appear in the adjacent-scenes strip -- confirms search is genuinely needed to reach it", async () => {
  await gotoTableMode(page, base, originScene.id);
  const strip = page.locator('[data-testid="table-adjacent-strip"]');
  await strip.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await strip.locator('[data-testid="table-adjacent-scene-item"]').count(), 0, "the adjacent strip must be empty for a scene with zero linked neighbors");
});

test("typing the target scene's anchor name into the search bar filters down to it, and opening it switches the current scene WITHOUT leaving Table Mode", async () => {
  await gotoTableMode(page, base, originScene.id);

  const searchInput = page.locator('[data-testid="table-nav-search-input"]');
  await searchInput.waitFor({ state: "visible", timeout: 15000 });
  await searchInput.fill("Faraway Search Target");

  const results = page.locator('[data-testid="table-nav-search-results"]');
  await results.waitFor({ state: "visible", timeout: 10000 });
  const resultItems = results.locator('[data-testid="table-nav-search-result"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length === 1,
      '[data-testid="table-nav-search-results"] [data-testid="table-nav-search-result"]',
      { timeout: 10000 }
    );
  }, "typing the target's own name must filter results down to exactly that one scene");
  const resultTarget = resultItems.first();
  assert.equal(await resultTarget.getAttribute("data-scene-id"), targetScene.id, "the one search result must be the target scene, not the origin scene itself");

  await resultTarget.click();

  // The critical assertion: the URL must still encode Table Mode -- only
  // the sceneId argument changes, never a navigation away from Table Mode
  // (e.g. never routing out to the #scenes tab).
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}?mode=table`,
      targetScene.id,
      { timeout: 5000 }
    );
  }, "opening a search result must land on #session-planner/<targetSceneId>?mode=table -- the SAME table-mode URL shape, only the sceneId changed");

  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), targetScene.id, "Table Mode must now be showing the target scene");
  assert.equal(await page.locator('[data-testid="scene-chain"]').count(), 0, "must never have fallen back to the construction view during this jump");
});

test("clearing the search input hides the results list again", async () => {
  await gotoTableMode(page, base, originScene.id);
  const searchInput = page.locator('[data-testid="table-nav-search-input"]');
  await searchInput.waitFor({ state: "visible", timeout: 15000 });

  await searchInput.fill("Faraway");
  await page.locator('[data-testid="table-nav-search-results"]').waitFor({ state: "visible", timeout: 10000 });

  await searchInput.fill("");
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="table-nav-search-results"]');
      return !el || el.offsetParent === null;
    }, { timeout: 5000 });
  }, "clearing the search input must hide the results list, not leave a stale result set showing");
});
