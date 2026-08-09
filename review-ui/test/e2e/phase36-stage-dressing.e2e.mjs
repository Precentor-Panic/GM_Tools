// Phase 36 task 36.4b -- "Stage" chip row on the scene page (Russell's pass
// finding #2: "I can't see the maps, splash, music items in the scene… we
// should show them somewhere"). Read the "Phase 36.4" section of
// ~/.claude/plans/ok-i-m-back-with-dazzling-newt.md + phase36-fixture.mjs
// FIRST.
//
// The scene page (Prep AND Run) gains a quiet chip row under the
// stage-toggle area: one small chip per tray-roster `kind:'asset'` row
// (map/splash/music/item), kind glyph + name resolved item-store-first-
// then-stagecraft (mirrors scene-tray.js's own `nameFor`), click navigates
// to the asset's Library shelf. Absent entirely when the roster has no
// asset rows. Testids: `scene-stage-dressing-row` / `scene-stage-dressing-
// chip` (+ data-kind, data-asset-id). This is a pure read of the existing
// `GET .../tray` route + the existing item/stagecraft list routes -- no new
// store or route.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase36-fixture.mjs";
import {
  makeStagecraftAsset,
  seedStagecraftAssets,
  makeItemRecord,
  seedItemRecords,
  dropOnSceneTrayViaRoute
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-p36dressing-");
const WORLD = "e2e-p36-stage-dressing";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base, browser;

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

test("chip row renders for a roster with map + splash + music + item asset rows -- right glyphs, names, data-kinds; visible in Prep mode", async () => {
  const map = makeStagecraftAsset({ id: "sc_dress_map1", world: WORLD, kind: "map", name: "The Sunken Chantry", status: "accepted" });
  const splash = makeStagecraftAsset({ id: "sc_dress_splash1", world: WORLD, kind: "splash", name: "Chantry cold open", status: "accepted" });
  const music = makeStagecraftAsset({ id: "sc_dress_music1", world: WORLD, kind: "music", name: "Drowned bells", status: "accepted" });
  seedStagecraftAssets(WORLD, [map, splash, music]);
  const item = makeItemRecord({ id: "it_dress_item1", world: WORLD, name: "Barnacled key", status: "accepted" });
  seedItemRecords(WORLD, [item]);

  const scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Dressed with everything." });
  for (const asset of [map, splash, music, item]) {
    const r = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "asset", id: asset.id });
    assert.equal(r.status, 200, `drop of asset ${asset.id} must succeed -- got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const row = page.locator('[data-testid="scene-stage-dressing-row"]');
  await row.waitFor({ state: "visible", timeout: 15000 });
  const chips = page.locator('[data-testid="scene-stage-dressing-chip"]');
  assert.equal(await chips.count(), 4, "one chip per asset roster row");

  const mapChip = page.locator('[data-testid="scene-stage-dressing-chip"][data-kind="map"]');
  const splashChip = page.locator('[data-testid="scene-stage-dressing-chip"][data-kind="splash"]');
  const musicChip = page.locator('[data-testid="scene-stage-dressing-chip"][data-kind="music"]');
  const itemChip = page.locator('[data-testid="scene-stage-dressing-chip"][data-kind="item"]');

  assert.equal(await mapChip.count(), 1);
  assert.equal(await mapChip.getAttribute("data-asset-id"), map.id);
  assert.match((await mapChip.textContent()) ?? "", /▦/, "map glyph");
  assert.match((await mapChip.textContent()) ?? "", /The Sunken Chantry/);

  assert.equal(await splashChip.count(), 1);
  assert.match((await splashChip.textContent()) ?? "", /◐/, "splash glyph");
  assert.match((await splashChip.textContent()) ?? "", /Chantry cold open/);

  assert.equal(await musicChip.count(), 1);
  assert.match((await musicChip.textContent()) ?? "", /♪/, "music glyph");
  assert.match((await musicChip.textContent()) ?? "", /Drowned bells/);

  assert.equal(await itemChip.count(), 1);
  assert.equal(await itemChip.getAttribute("data-asset-id"), item.id);
  assert.match((await itemChip.textContent()) ?? "", /◈/, "item (default) glyph");
  assert.match((await itemChip.textContent()) ?? "", /Barnacled key/);

  await page.close();
});

test("clicking a stagecraft-kind chip navigates to #library/stagecraft; clicking an item chip navigates to #library/reliquary", async () => {
  const map = makeStagecraftAsset({ id: "sc_dress_click_map", world: WORLD, kind: "map", name: "Click-target map", status: "accepted" });
  seedStagecraftAssets(WORLD, [map]);
  const item = makeItemRecord({ id: "it_dress_click_item", world: WORLD, name: "Click-target item", status: "accepted" });
  seedItemRecords(WORLD, [item]);

  const scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Click targets." });
  await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "asset", id: map.id });
  await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "asset", id: item.id });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-stage-dressing-row"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="scene-stage-dressing-chip"][data-kind="map"]').click();
  await page.waitForFunction(() => location.hash === "#library/stagecraft", { timeout: 5000 });

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-stage-dressing-row"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-stage-dressing-chip"][data-kind="item"]').click();
  await page.waitForFunction(() => location.hash === "#library/reliquary", { timeout: 5000 });

  await page.close();
});

test("the row is entirely absent for a scene whose roster has no asset rows", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "No assets at all." });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  // The rest of the page has settled (stage row present) -- absence of the
  // dressing row is a real "never rendered", not a still-loading race.
  await page.locator('[data-testid="scene-stage-toggle"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="scene-stage-dressing-row"]').count(), 0, "no asset rows -- the chip row must not render at all");

  await page.close();
});

test("the chip row is ALSO visible in Run mode, not just Prep", async () => {
  const map = makeStagecraftAsset({ id: "sc_dress_run_map", world: WORLD, kind: "map", name: "Run-mode map", status: "accepted" });
  seedStagecraftAssets(WORLD, [map]);

  const scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Run mode check." });
  await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "asset", id: map.id });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-stage-dressing-row"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="mode-run-btn"]').click();
  const sceneRoot = page.locator('.scene-page[data-mode="run"]');
  await sceneRoot.waitFor({ state: "attached", timeout: 15000 });
  const row = page.locator('[data-testid="scene-stage-dressing-row"]');
  assert.equal(await row.count(), 1, "the row must still be present in Run mode");
  assert.ok(await row.isVisible(), "and actually visible, not just present-but-hidden");

  await page.close();
});
