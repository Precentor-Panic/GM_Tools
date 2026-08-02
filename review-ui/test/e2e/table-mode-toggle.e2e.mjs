// Phase 25 task 25.0, REQUIRED SCENARIO 1 -- "Table Mode toggle: a control
// on the existing Session Planner view switches between the Phase 23
// construction view and the new single-scene Table Mode render, both
// addressable via the URL (so a reload preserves which mode was active)."
// Read table-mode-fixture.mjs's header FIRST (§1 is this file's own
// section) for the full shared DOM/URL contract. EXPECTED TO FAIL right now
// with a Playwright selector-not-found/timeout error -- none of the
// `table-mode-toggle-btn`/`table-mode-view`/`construction-mode-toggle-btn`
// DOM exists yet. That failure is the deliverable of this task, not a bug
// in this file.
//
// FIXTURE: two independent, unconnected place entities, each anchoring its
// own scene -- deliberately unconnected (no edge between them) so scene B
// can never accidentally satisfy scene A's own corridor/linkage, keeping
// this file's two-scene assertions unambiguous.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoConstructionMode,
  gotoTableMode,
  tableModeHash,
  constructionHash,
  DESKTOP_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-toggle-");
const WORLD = "e2e-tablemode-toggle-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmtoggle-a", name: "Toggle Scene A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmtoggle-b", name: "Toggle Scene B", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let sceneA, sceneB;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmtoggle-a", objectiveNote: "Scene at A" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmtoggle-b", objectiveNote: "Scene at B" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("construction view is the default: scene-chain renders, table-mode-view does not", async () => {
  await gotoConstructionMode(page, base, sceneA.id);
  await page.locator('[data-testid="scene-chain"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="table-mode-view"]').count(), 0, "table-mode-view must not be present while in construction mode");
});

test("clicking table-mode-toggle-btn switches to Table Mode for the SAME currently-loaded scene, updating the URL", async () => {
  await gotoConstructionMode(page, base, sceneA.id);
  const toggle = page.locator('[data-testid="table-mode-toggle-btn"]');
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  await toggle.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#${expected}`,
      tableModeHash(sceneA.id),
      { timeout: 5000 }
    );
  }, `expected the URL hash to become #${tableModeHash(sceneA.id)} after clicking table-mode-toggle-btn`);

  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), sceneA.id, "Table Mode must render for the scene that was actually loaded (A), not any other scene");
  assert.equal(await page.locator('[data-testid="scene-chain"]').count(), 0, "scene-chain (construction view) must not remain in the DOM once Table Mode is active -- mutually exclusive");
});

test("Table Mode's own hash is directly URL-addressable: a fresh navigation with no prior toggle click lands straight in Table Mode", async () => {
  await gotoTableMode(page, base, sceneB.id);
  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), sceneB.id, "direct hash entry must render Table Mode for the sceneId encoded in the URL (B)");
  assert.equal(await page.locator('[data-testid="scene-chain"]').count(), 0);
});

test("a real page reload preserves Table Mode -- the whole point of URL-addressability", async () => {
  await gotoTableMode(page, base, sceneA.id);
  await page.locator('[data-testid="table-mode-view"]').waitFor({ state: "visible", timeout: 15000 });

  await page.reload();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash.includes("mode=table"), { timeout: 5000 });
  }, "the hash itself must still encode mode=table immediately after reload, before any script re-derives it");
  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), sceneA.id, "reloading a Table Mode URL must render Table Mode again for the SAME scene, with no click needed");
});

test("construction-mode-toggle-btn switches back to the construction view, preserving the scene id (not resetting to bootstrap/last-resumed)", async () => {
  await gotoTableMode(page, base, sceneA.id);
  const backToggle = page.locator('[data-testid="construction-mode-toggle-btn"]');
  await backToggle.waitFor({ state: "visible", timeout: 15000 });
  await backToggle.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#${expected}`,
      constructionHash(sceneA.id),
      { timeout: 5000 }
    );
  }, `expected the URL hash to become #${constructionHash(sceneA.id)} after clicking construction-mode-toggle-btn`);

  const chain = page.locator('[data-testid="scene-chain"]');
  await chain.waitFor({ state: "visible", timeout: 15000 });
  const currentItem = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneA.id}"]`);
  assert.equal(await currentItem.getAttribute("data-current"), "true", "returning to construction mode must land back on scene A specifically, not reset to whichever scene was last resumed from storage");
  assert.equal(await page.locator('[data-testid="table-mode-view"]').count(), 0);
});
