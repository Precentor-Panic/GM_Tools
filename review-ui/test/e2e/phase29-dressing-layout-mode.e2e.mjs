// Phase 29 task 29.0 -- Suggest dressing (§6) + Page|Cards layout / Prep|Run
// mode (§7). Read phase29-fixture.mjs's header FIRST. Both are pure
// frontend features (no new route) -- EXPECTED TO FAIL right now with real
// Playwright selector-timeout errors: `suggest-dressing-btn`, `layout-page-
// btn`/`layout-cards-btn`, `mode-prep-btn`/`mode-run-btn` do not exist
// anywhere in session-planner-view.js yet (confirmed by direct read). That
// failure is the deliverable of this task, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
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

test("UI (RED): Page|Cards layout segmented control does not exist yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "dress-place-forge" });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Quench barrel", fields: { gives: "Cloudy water and scale." } });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="layout-cards-btn"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.5: `layout-cards-btn` must render in the scene sub-bar -- RED today, absent from the DOM"
  );

  // scene-elements-list carries no data-layout attribute yet either.
  const layoutAttr = await page.locator('[data-testid="scene-elements-list"]').getAttribute("data-layout");
  assert.equal(layoutAttr, null, "29.5: `scene-elements-list` must default to data-layout=\"page\" once 29.5 lands -- RED today, the attribute doesn't exist at all");
  await page.close();
});

test("UI (RED): Prep|Run mode segmented control does not exist yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "dress-place-forge" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="mode-run-btn"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.5: `mode-run-btn` must render in the scene sub-bar -- RED today, absent from the DOM"
  );

  const modeAttr = await root.getAttribute("data-mode");
  assert.equal(modeAttr, null, "29.5: `scene-page` must default to data-mode=\"prep\" once 29.5 lands -- RED today, the attribute doesn't exist at all");
  await page.close();
});
