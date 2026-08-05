// Phase 29 -- Suggest dressing (§6, GREEN since 29.3) + Page|Cards layout /
// Prep|Run mode (§7, GREEN since 29.5). Read phase29-fixture.mjs's header
// FIRST. All three are pure frontend features (no new route). The two
// layout/mode tests below were authored RED in 29.0 (assert.rejects-on-
// absence) and INVERTED into real assertions in 29.5 once the segmented
// controls, `data-layout`/`data-mode` attributes, and the run-mode
// hide/collapse rules landed in session-planner-view.js + style.css.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  promoteElementViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase29Env("gm-tools-e2e-dressing-");
const WORLD = "e2e-dressing-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  // Deliberately named/described to match the "forge/smith" DRESSING
  // keyword group verbatim from Session Planner.dc.html's own DRESSING
  // constant (design/session-planner/README.md §"Suggest dressing" /
  // phase29-fixture.mjs §6) -- name-only match (no description), the
  // "matched on name only" toast case.
  { op: "upsert_entity", data: { id: "dress-place-forge", name: "The Ironwood Forge", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("UI: '✦ Suggest dressing' appends up to 3 MUNDANE elements matched from the place, shows a toast, and a second click adds new (non-duplicate) items", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "dress-place-forge" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const btn = root.locator(`[data-testid="suggest-dressing-btn"][data-scene-id="${scene.id}"]`);
  await btn.waitFor({ state: "visible", timeout: 5000 });

  // First click: the "forge/smith" group matches on the place NAME alone
  // ("The Ironwood Forge", no description) -> its first three items appear.
  await btn.click();
  await page.locator('[data-testid="suggest-dressing-toast"]').waitFor({ state: "visible", timeout: 5000 });

  const localRows = root.locator('[data-testid="scene-element-row"][data-kind="local"]');
  let count = 0;
  for (let i = 0; i < 40 && count < 3; i++) {
    count = await localRows.count();
    if (count < 3) await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(count, 3, "the first Suggest-dressing click appends exactly 3 MUNDANE elements");

  let elements = (await listSceneElementsViaRoute(base, WORLD, scene.id)).body.elements;
  const names1 = elements.map((e) => e.name);
  // Verbatim item names from the forge/smith DRESSING group.
  assert.ok(names1.includes("Quench barrel"), "forge/smith group item 'Quench barrel' was appended (verbatim from the prototype DRESSING map)");
  assert.ok(names1.includes("Rack of unclaimed work"), "forge/smith group item 'Rack of unclaimed work' was appended");
  assert.ok(names1.includes("Coal heap and shovel"), "forge/smith group item 'Coal heap and shovel' was appended");
  // Each dressing item carries its `gives` text.
  const quench = elements.find((e) => e.name === "Quench barrel");
  assert.ok(quench.fields && typeof quench.fields.gives === "string" && quench.fields.gives.length > 0, "each dressing element carries its own gives text");

  // Second click: the already-added items are skipped; the group's remaining
  // 4th item ("Wall of tongs") is added -- new, not a duplicate.
  await btn.click();
  let count2 = count;
  for (let i = 0; i < 40 && count2 < 4; i++) {
    count2 = await localRows.count();
    if (count2 < 4) await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(count2, 4, "a second Suggest-dressing click adds a new (non-duplicate) item");
  elements = (await listSceneElementsViaRoute(base, WORLD, scene.id)).body.elements;
  assert.ok(elements.map((e) => e.name).includes("Wall of tongs"), "the second click adds the group's remaining item 'Wall of tongs'");
  await page.close();
});

// Phase 29 task 29.5 (INVERTED, was RED in 29.0): the Page|Cards segmented
// control renders in the scene sub-bar, defaults to Page, and flips the
// scene-elements-list's `data-layout` attribute IN PLACE (no re-render -- the
// row survives the toggle), per phase29-fixture.mjs §7.
test("UI: Page|Cards layout segmented control flips scene-elements-list data-layout in place", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "dress-place-forge" });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Quench barrel", fields: { gives: "Cloudy water and scale." } });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const pageBtn = root.locator(`[data-testid="layout-page-btn"][data-scene-id="${scene.id}"]`);
  const cardsBtn = root.locator(`[data-testid="layout-cards-btn"][data-scene-id="${scene.id}"]`);
  await pageBtn.waitFor({ state: "visible", timeout: 5000 });
  await cardsBtn.waitFor({ state: "visible", timeout: 5000 });

  const list = root.locator('[data-testid="scene-elements-list"]');
  await list.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await list.getAttribute("data-layout"), "page", "defaults to Page layout (data-layout=\"page\") on a fresh load");

  await cardsBtn.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scene-elements-list"]')?.getAttribute("data-layout") === "cards",
    null, { timeout: 3000 }
  );
  assert.equal(await list.getAttribute("data-layout"), "cards", "clicking Cards sets data-layout=\"cards\"");
  // CSS-driven (same DOM) -- the row is not re-rendered away by the toggle.
  assert.equal(await root.locator('[data-testid="scene-element-row"]').count(), 1, "the element row survives the layout toggle (no data loss / re-render)");

  await pageBtn.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scene-elements-list"]')?.getAttribute("data-layout") === "page",
    null, { timeout: 3000 }
  );
  assert.equal(await list.getAttribute("data-layout"), "page", "clicking Page returns data-layout=\"page\"");
  await page.close();
});

// Phase 29 task 29.5 (INVERTED, was RED in 29.0): the Prep|Run segmented
// control renders, defaults to Prep, and Run flips scene-page's `data-mode` to
// "run" WITHOUT a reload -- hiding all edit chrome, collapsing a MUNDANE row to
// its Gives line only (KEY rows stay full), enlarging read-aloud to 20px, and
// force-closing the Wrap panel. Switching back to Prep restores everything.
// Per phase29-fixture.mjs §7.
test("UI: Prep|Run mode hides edit chrome, collapses MUNDANE to Gives, enlarges read-aloud, and force-closes Wrap", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "dress-place-forge" });
  // A MUNDANE (local) element carrying a NON-Gives field (trigger) as well as Gives.
  const mundane = (await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Cracked bell", fields: { trigger: "PCs ring it.", gives: "A dull, flat clang." } })).body.element;
  // A KEY (graph) element, also carrying a non-Gives field, to prove KEY stays full in Run.
  const keySeed = (await createSceneElementViaRoute(base, WORLD, scene.id, { name: "The Smith", fields: { trigger: "Approach the anvil.", gives: "A wary nod." } })).body.element;
  await promoteElementViaRoute(base, WORLD, scene.id, keySeed.id);

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const prepBtn = root.locator(`[data-testid="mode-prep-btn"][data-scene-id="${scene.id}"]`);
  const runBtn = root.locator(`[data-testid="mode-run-btn"][data-scene-id="${scene.id}"]`);
  await prepBtn.waitFor({ state: "visible", timeout: 5000 });
  await runBtn.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await root.getAttribute("data-mode"), "prep", "defaults to Prep mode (data-mode=\"prep\")");

  const mundaneRow = root.locator(`[data-testid="scene-element-row"][data-element-id="${mundane.id}"]`);
  const keyRow = root.locator(`[data-testid="scene-element-row"][data-element-id="${keySeed.id}"]`);
  const wrapToggle = root.locator('[data-testid="wrap-toggle-btn"]');
  const wrapPanel = root.locator('[data-testid="wrap-panel"]');
  const removeBtn = mundaneRow.locator('[data-testid="scene-element-remove-btn"]');
  const mundaneTrigger = mundaneRow.locator('[data-testid="scene-element-field"][data-field="trigger"]');
  const mundaneGives = mundaneRow.locator('[data-testid="scene-element-field"][data-field="gives"]');
  const keyTrigger = keyRow.locator('[data-testid="scene-element-field"][data-field="trigger"]');

  // Prep baseline: edit chrome + all field-lines visible.
  assert.equal(await removeBtn.isVisible(), true, "Prep: element remove button is visible");
  assert.equal(await wrapToggle.isVisible(), true, "Prep: Wrap toggle is visible");
  assert.equal(await mundaneTrigger.isVisible(), true, "Prep: MUNDANE trigger field is visible");

  // Open the Wrap panel first, so Run has something to force-close.
  await wrapToggle.click();
  await wrapPanel.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await wrapPanel.isVisible(), true, "Wrap panel opened in Prep");

  // Enter Run mode.
  await runBtn.click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="scene-page"][data-scene-id="${id}"]`)?.getAttribute("data-mode") === "run",
    scene.id, { timeout: 3000 }
  );
  assert.equal(await root.getAttribute("data-mode"), "run", "clicking Run sets data-mode=\"run\"");

  // Wrap force-closed + its toggle hidden.
  assert.equal(await wrapPanel.isVisible(), false, "Run force-closes the Wrap panel");
  assert.equal(await wrapToggle.isVisible(), false, "Run hides the Wrap toggle");

  // Edit chrome hidden.
  assert.equal(await removeBtn.isVisible(), false, "Run hides the element remove button");
  assert.equal(await mundaneRow.locator('[data-testid="scene-element-key-toggle"]').isVisible(), false, "Run hides the promote/demote toggle");
  assert.equal(await root.locator('[data-testid="npc-creature-btn"]').isVisible(), false, "Run hides the NPC/creature button");
  assert.equal(await root.locator('[data-testid="from-graph-btn"]').isVisible(), false, "Run hides the From-graph button");
  assert.equal(await root.locator('[data-testid="suggest-dressing-btn"]').isVisible(), false, "Run hides the Suggest-dressing button");
  assert.equal(await root.locator('[data-testid="scene-add-element-row"]').isVisible(), false, "Run hides the add-element ghost row");

  // MUNDANE collapses to Gives only; KEY stays full.
  assert.equal(await mundaneGives.isVisible(), true, "Run: MUNDANE Gives line stays visible");
  assert.equal(await mundaneTrigger.isVisible(), false, "Run: MUNDANE non-Gives field-line collapses");
  assert.equal(await keyTrigger.isVisible(), true, "Run: KEY element stays full (its non-Gives field stays visible)");

  // Read-aloud enlarges to 20px.
  const readAloudPx = await root.locator('[data-testid="scene-narration"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.equal(readAloudPx, 20, "Run bumps read-aloud to 20px");

  // Back to Prep restores everything with no further interaction.
  await prepBtn.click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="scene-page"][data-scene-id="${id}"]`)?.getAttribute("data-mode") === "prep",
    scene.id, { timeout: 3000 }
  );
  assert.equal(await removeBtn.isVisible(), true, "Prep restore: remove button visible again");
  assert.equal(await mundaneTrigger.isVisible(), true, "Prep restore: MUNDANE trigger field visible again");
  assert.equal(await wrapToggle.isVisible(), true, "Prep restore: Wrap toggle visible again");
  await page.close();
});
