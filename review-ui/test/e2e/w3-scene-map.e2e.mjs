// Friction Wave 1 W3 -- real headless-Chromium verification of the
// scene<->map association cluster (W3a src + W3b link/chips + W3c push
// default), end to end against the REAL routes/stores. No live Foundry: the
// push's ops-channel write is captured (and answered) by the same fake
// in-process watcher pattern review-ui/test/foundry-push-routes.test.mjs
// uses.
//
// Flow under test (the exact friction item, friction.md 2026-08-14):
//   1. A stagecraft map asset with a real `src` exists (hand-add route).
//   2. Scene page: the map chip is VISIBLE in its "No map linked" state
//      (absence must be seen, not inferred), the picker lists the asset
//      with name + src, choosing it persists scene.mapAssetId.
//   3. The chip flips to the linked state (green, asset name).
//   4. The scene tray (Library) shows the at-a-glance map glyph chip.
//   5. POST /api/foundry/push-scene with NO mapSrc -- the composed
//      create_scene op's background.src IS the linked asset's src.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase36-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-w3-scene-map-");
const WORLD = "e2e-w3-scene-map";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, foundryOpsPath, foundryResultsPath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { getScene } = await import("../../../session-planner/scenes.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base, browser, scene, mapAsset;

const MAP_SRC = "worlds/e2e-w3/maps/lowway-alleys.webp";

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  // A real map asset via the REAL hand-add route (W3a's src field included).
  const res = await fetch(`${base}/api/session-planner/stagecraft/hand-add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Lowway Alleys", kind: "map", src: MAP_SRC })
  });
  assert.equal(res.status, 200, "fixture setup: hand-add must succeed");
  ({ asset: mapAsset } = await res.json());
  assert.equal(mapAsset.src, MAP_SRC);

  scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Chase through the alleys." });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("scene page: the map chip is ALWAYS visible -- starts as an explicit 'No map linked', never a silent absence", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const chip = page.locator('[data-testid="scene-map-chip"]');
  await chip.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await chip.getAttribute("data-has-map"), "false");
  assert.match((await chip.textContent()) ?? "", /No map linked/);
  await page.close();
});

test("scene page: 'link a map…' opens the picker (asset listed with name + src), choosing it persists mapAssetId and flips the chip to the linked state", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const chip = page.locator('[data-testid="scene-map-chip"]');
  await chip.waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="scene-map-link-btn"]').click();
  const picker = page.locator('[data-testid="scene-map-picker"]');
  await picker.waitFor({ state: "visible", timeout: 15000 });

  // The picker's option text carries BOTH the asset name and its src -- the
  // "which file is this, actually" info the old desc-workaround hid.
  const optionText = await picker.locator(`option[value="${mapAsset.id}"]`).textContent();
  assert.match(optionText ?? "", /Lowway Alleys/);
  assert.ok((optionText ?? "").includes(MAP_SRC), `picker option must show the src -- got "${optionText}"`);

  await picker.selectOption(mapAsset.id);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scene-map-chip"]')?.getAttribute("data-has-map") === "true",
    { timeout: 15000 }
  );
  assert.match((await chip.textContent()) ?? "", /Lowway Alleys/, "the linked chip names the asset");

  // Persisted for real, not just painted.
  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.mapAssetId, mapAsset.id);
  await page.close();
});

test("scene cards at a glance: the Library's scene tray shows the map glyph chip for the linked scene", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/stagecraft`);
  const trayRow = page.locator(`[data-testid="scene-tray-scene-row"][data-scene-id="${scene.id}"]`);
  await trayRow.waitFor({ state: "visible", timeout: 15000 });
  const trayChip = trayRow.locator('[data-testid="scene-tray-map-chip"]');
  await trayChip.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await trayChip.getAttribute("data-map-asset-id"), mapAsset.id);
  const title = await trayChip.getAttribute("title");
  assert.match(title ?? "", /Lowway Alleys/, "the chip's tooltip names the map");
  await page.close();
});

test("push-scene with NO mapSrc: the composed create_scene op carries the DEFAULTED background.src from the linked asset (op file captured, fake watcher answers)", async () => {
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);
  let capturedOp = null;
  const watcher = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try { ops = JSON.parse(readFileSync(opsPath, "utf8")); } catch { return; }
    if (Array.isArray(ops) && ops.length && ops[0].kind === "create_scene") {
      clearInterval(watcher);
      capturedOp = ops[0];
      mkdirSync(dirname(resultsPath), { recursive: true });
      writeFileSync(resultsPath, JSON.stringify([{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.w3e2e" }]), "utf8");
      writeFileSync(opsPath, "[]", "utf8");
    }
  }, 20);

  const res = await fetch(`${base}/api/foundry/push-scene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId: scene.id }) // deliberately NO mapSrc
  });
  clearInterval(watcher);
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "applied");
  assert.equal(body.ok, true);
  assert.ok(capturedOp, "the ops-channel write must have been captured");
  assert.deepEqual(capturedOp.data.background, { src: MAP_SRC }, "the push defaulted its mapSrc from the linked asset's src");
  assert.equal(getScene(WORLD, scene.id).foundrySceneRef, "Scene.w3e2e");
});
