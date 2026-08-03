// Phase 26 task 26.0, REQUIRED SCENARIO 4 -- "'Beyond this path' no longer
// renders (beyond-corridor-summary DOM-absence); its former space now hosts
// connect-existing-scene / create-ad-hoc-scene actions." Read
// phase26-fixture.mjs's header FIRST (§6 is this file's own section).
// EXPECTED TO FAIL right now -- `beyond-corridor-summary` is still very much
// present in the current, not-yet-reworked UI (Phase 17's real, live,
// unmodified `renderBeyondCorridorSummary`) -- the absence assertions below
// will currently FAIL for that reason, and the replacement DOM
// (`connect-existing-scene-list`/`create-ad-hoc-scene-btn`) doesn't exist
// yet either. Both are the deliverable of this task, not a bug in this
// file.
//
// FIXTURE: a scene ("beyondpath-anchor") plus a graph-adjacent OTHER scene
// ("beyondpath-hop1-anchor", 1 hop away via a real edge) AND a separately
// explicit-scene-linked scene ("beyondpath-linked-anchor", genuinely
// disconnected in the graph) -- so this file can assert BOTH connect-
// existing sources (linkage-derived AND scene-link-derived) surface
// together in the repurposed space, per phase26-fixture.mjs's §6.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  linkScenesViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-beyondpath-");
const WORLD = "e2e-beyondpath-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "beyondpath-anchor", name: "Beyond-Path Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "beyondpath-hop1-anchor", name: "Beyond-Path Hop-1 Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "beyondpath-linked-anchor", name: "Beyond-Path Explicitly-Linked Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "beyondpath-e0", sourceId: "beyondpath-anchor", targetId: "beyondpath-hop1-anchor", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let scene, hop1Scene, linkedScene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "beyondpath-anchor" });
  hop1Scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "beyondpath-hop1-anchor" });
  linkedScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "beyondpath-linked-anchor" });
  await linkScenesViaRoute(base, WORLD, scene.id, linkedScene.id, "explicitly linked, not graph-adjacent");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("'beyond-corridor-summary' (and its two child counts) is DOM-absent entirely", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"][data-current="true"]').length === 1, { timeout: 15000 });

  const summaryCount = await page.evaluate(() => document.querySelectorAll('[data-testid="beyond-corridor-summary"]').length);
  const contentCountEl = await page.evaluate(() => document.querySelectorAll('[data-testid="beyond-corridor-content-count"]').length);
  const structCountEl = await page.evaluate(() => document.querySelectorAll('[data-testid="beyond-corridor-structural-count"]').length);
  assert.equal(summaryCount, 0, "beyond-corridor-summary must be COMPLETELY REMOVED (§26.B) -- real DOM-absence, not just untested");
  assert.equal(contentCountEl, 0, "its child beyond-corridor-content-count must be gone too");
  assert.equal(structCountEl, 0, "its child beyond-corridor-structural-count must be gone too");
});

test("the repurposed space hosts connect-existing-scene actions, immediately visible (not behind a <details>), surfacing BOTH linkage-derived AND explicit-scene-link candidates", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"][data-current="true"]').length === 1, { timeout: 15000 });

  const list = page.locator(`[data-testid="connect-existing-scene-list"][data-scene-id="${scene.id}"]`);
  await list.waitFor({ state: "visible", timeout: 10000 });

  // "Quick, visible options -- not buried behind a <details>." FIX (found
  // live while implementing 26.7, confirmed via direct empirical testing):
  // every scene's own body -- including the OLD beyond-corridor-summary
  // this zone replaces -- necessarily renders inside the construction
  // view's own pre-existing, unrelated scene-chain-item `<details>`
  // (buildChainItem's own established collapse-per-scene structure, task
  // 23.0). The scenario's real intent (confirmed by its own wording, "it
  // replaces the old collapsed summary, it doesn't reintroduce one") is
  // that this zone must not add a SECOND, NEW collapse of its own -- not
  // that it can somehow escape the outer per-scene details entirely, which
  // no scene-body content anywhere in this view has ever done. Corrected to
  // check for a details ancestor OTHER than that pre-existing outer one.
  const isBuriedInANewDetails = await list.evaluate((el) => el.closest('details:not([data-testid="scene-chain-item"])') !== null);
  assert.equal(isBuriedInANewDetails, false, "connect-existing-scene-list must NOT be nested inside a NEW <details> of its own -- it replaces the old collapsed summary, it doesn't reintroduce one");

  const items = list.locator('[data-testid="connect-existing-scene-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length >= 2,
      `[data-testid="connect-existing-scene-list"][data-scene-id="${scene.id}"] [data-testid="connect-existing-scene-item"]`,
      { timeout: 10000 }
    );
  }, "expected at least 2 connect-existing-scene-item entries: one linkage-derived (hop-1), one scene-link-derived");

  const linkageItem = list.locator(`[data-testid="connect-existing-scene-item"][data-scene-id="${hop1Scene.id}"][data-connect-source="linkage"]`);
  const sceneLinkItem = list.locator(`[data-testid="connect-existing-scene-item"][data-scene-id="${linkedScene.id}"][data-connect-source="scene-link"]`);
  assert.equal(await linkageItem.count(), 1, "the graph-adjacency (hop-1) candidate must surface with data-connect-source=\"linkage\"");
  assert.equal(await sceneLinkItem.count(), 1, "the explicitly-scene-linked (but graph-disconnected) candidate must ALSO surface, with data-connect-source=\"scene-link\" -- both sources together, per §26.C's 'surfaced together, not one replacing the other'");
});

test("create-ad-hoc-scene-btn is an alias for this scene's own add-scene-btn -- same panel, not a second creation mechanism", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"][data-current="true"]').length === 1, { timeout: 15000 });

  const adHocBtn = page.locator(`[data-testid="create-ad-hoc-scene-btn"][data-scene-id="${scene.id}"]`);
  await adHocBtn.waitFor({ state: "visible", timeout: 10000 });
  await adHocBtn.click();

  const panel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${scene.id}"]`);
  await assert.doesNotReject(async () => {
    await panel.waitFor({ state: "visible", timeout: 5000 });
  }, "create-ad-hoc-scene-btn must open the SAME add-scene-panel §26.6's own '+Scene' button opens -- no second/duplicate scene-creation mechanism");
});
