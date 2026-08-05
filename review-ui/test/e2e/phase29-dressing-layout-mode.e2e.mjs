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

test("UI (RED): '✦ Suggest dressing' button does not exist yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "dress-place-forge" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="suggest-dressing-btn"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.3: `suggest-dressing-btn` must render below the elements list -- RED today, absent from the DOM"
  );
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
