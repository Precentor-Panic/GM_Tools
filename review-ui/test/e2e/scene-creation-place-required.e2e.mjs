// Phase 26 task 26.0, REQUIRED SCENARIO 1 -- "Scene creation (both
// construction view and Table Mode) requires a place; existing-or-new;
// link-or-not offered either way; a rough-distance note on a created link
// round-trips through the real addEdgeOp route." Read phase26-fixture.mjs's
// header FIRST (§3/§5 are this file's own sections -- the shared place-step/
// link-step sub-flow, mounted here under the `add-scene` "+Scene" prefix
// per §26.B/§26.6). EXPECTED TO FAIL right now with a Playwright
// selector-not-found/timeout error -- none of `add-scene-btn`/
// `add-scene-panel` exists yet. That failure is the deliverable of this
// task, not a bug in this file.
//
// FIXTURE: one anchor scene per view ("screq-cv-anchor" for construction
// view, "screq-tm-anchor" for Table Mode), plus one pre-existing real place
// entity ("screq-existing-place") for the "pick existing" path. This file
// covers all FOUR combinations the scenario's own wording requires
// (existing-vs-new place crossed with link-vs-no-link), split two-and-two
// across the two views so both views are genuinely exercised, not just one
// with the other rubber-stamped.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-screq-");
const WORLD = "e2e-screq-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "screq-cv-anchor", name: "Screq Construction Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "screq-tm-anchor", name: "Screq Table Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "screq-existing-place", name: "Screq Existing Waystop", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let cvScene, tmScene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  cvScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "screq-cv-anchor" });
  tmScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "screq-tm-anchor" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("CONSTRUCTION VIEW: picking an EXISTING place, then LINKING with a rough-distance note, creates a scene AND a real edge (via addEdgeOp) carrying that note", async () => {
  await page.goto(`${base}/#session-planner/${cvScene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 1, { timeout: 15000 });

  const addSceneBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${cvScene.id}"]`);
  await addSceneBtn.waitFor({ state: "visible", timeout: 10000 });
  await addSceneBtn.click();

  const panel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${cvScene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  // A place MUST be required -- the panel offers both existing-place and
  // new-place paths, never lets the flow proceed without one.
  const placeStep = panel.locator('[data-testid="add-scene-place-step"]');
  await placeStep.waitFor({ state: "visible", timeout: 5000 });

  const existingInput = placeStep.locator('[data-testid="add-scene-place-input"]');
  await existingInput.fill("Screq Existing Waystop");
  const option = placeStep.locator('[data-testid="add-scene-place-option"][data-entity-id="screq-existing-place"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const linkStep = panel.locator('[data-testid="add-scene-link-step"][data-place-entity-id="screq-existing-place"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });

  await linkStep.locator('[data-testid="add-scene-link-yes-btn"]').click();
  const noteInput = linkStep.locator('[data-testid="add-scene-link-note-input"]');
  await noteInput.waitFor({ state: "visible", timeout: 5000 });
  await noteInput.fill("~2 days' hard travel, rough terrain");
  await linkStep.locator('[data-testid="add-scene-link-confirm-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 10000 });
  }, "a new scene chain-item must appear once the place+link flow completes");

  // Confirm via the REAL snapshot, not just UI state: the scene's anchor is
  // the picked existing place, AND a real edge with the note exists.
  const items = page.locator('[data-testid="scene-chain-item"]');
  const orderedIds = await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  const newSceneId = orderedIds.find((id) => id !== cvScene.id);
  assert.ok(newSceneId);

  const brief = await (await fetch(`${base}/api/session-planner/brief?world=${WORLD}&sceneId=${newSceneId}`)).json();
  const anchorLoc = (brief.brief?.locations ?? []).find((l) => l.distance === 0);
  assert.equal(anchorLoc?.entityId, "screq-existing-place", "the new scene must be anchored to the picked EXISTING place");

  const { snapshot } = loadSnapshot(dataDir, WORLD);
  const edge = snapshot.edges.find(
    (e) => (e.sourceId === "screq-cv-anchor" && e.targetId === "screq-existing-place") ||
           (e.sourceId === "screq-existing-place" && e.targetId === "screq-cv-anchor")
  );
  assert.ok(edge, "a real graph edge must exist between the triggering scene's anchor and the picked place -- created via the real addEdgeOp route, not a UI-only link");
  assert.match(edge.notes ?? "", /2 days.*travel|rough terrain/i, "the rough-distance note typed in the UI must round-trip into the real edge's notes field (addEdgeOp's own existing label/notes allowlist, per §26.A)");
});

test("CONSTRUCTION VIEW: picking an EXISTING place, then choosing NOT to link, creates the scene with NO new edge at all", async () => {
  await page.goto(`${base}/#session-planner/${cvScene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length >= 1, { timeout: 15000 });

  const { snapshot: before1 } = loadSnapshot(dataDir, WORLD);
  const edgeCountBefore = before1.edges.length;

  const addSceneBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${cvScene.id}"]`).first();
  await addSceneBtn.click();
  const panel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${cvScene.id}"]`).first();
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const modeNewBtn = panel.locator('[data-testid="add-scene-place-mode-new-btn"]');
  await modeNewBtn.waitFor({ state: "visible", timeout: 5000 });
  await modeNewBtn.click();

  const newNameInput = panel.locator('[data-testid="add-scene-new-place-name-input"]');
  await newNameInput.fill("Screq Freshly Created Place (no-link case)");
  await panel.locator('[data-testid="add-scene-new-place-submit-btn"]').click();

  const linkStep = panel.locator('[data-testid="add-scene-link-step"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });
  await linkStep.locator('[data-testid="add-scene-link-no-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 10000 });
  }, "declining to link must still create the new scene");

  const { snapshot: after1 } = loadSnapshot(dataDir, WORLD);
  assert.equal(after1.edges.length, edgeCountBefore, "declining to link must create ZERO new edges -- link-or-not is a genuine choice, not link-always");
  const newPlace = after1.entities.find((e) => e.name === "Screq Freshly Created Place (no-link case)");
  assert.ok(newPlace, "the NEW place must still be a real, committed entity even though it wasn't linked");
});

test("TABLE MODE: creating a NEW place and choosing to LINK (no note this time) still round-trips a real edge via addEdgeOp", async () => {
  await page.goto(`${base}/#session-planner/${tmScene.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const addSceneBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${tmScene.id}"]`);
  await addSceneBtn.waitFor({ state: "visible", timeout: 10000 });
  await addSceneBtn.click();

  const panel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${tmScene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const modeNewBtn = panel.locator('[data-testid="add-scene-place-mode-new-btn"]');
  await modeNewBtn.waitFor({ state: "visible", timeout: 5000 });
  await modeNewBtn.click();
  const newNameInput = panel.locator('[data-testid="add-scene-new-place-name-input"]');
  await newNameInput.fill("Screq Table Mode New Place");
  await panel.locator('[data-testid="add-scene-new-place-submit-btn"]').click();

  const linkStep = panel.locator('[data-testid="add-scene-link-step"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });
  await linkStep.locator('[data-testid="add-scene-link-yes-btn"]').click();
  // Leave the note blank this time -- optional, per §26.A.
  await linkStep.locator('[data-testid="add-scene-link-confirm-btn"]').click();

  const status = page.locator(`[data-testid="add-scene-status"][data-scene-id="${tmScene.id}"]`);
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.textContent ?? "").length > 0,
      `[data-testid="add-scene-status"][data-scene-id="${tmScene.id}"]`,
      { timeout: 10000 }
    );
  }, "Table Mode's add-scene flow must report success feedback even though (being single-scene-focused) it doesn't grow a visible chain");

  const { snapshot } = loadSnapshot(dataDir, WORLD);
  const newPlace = snapshot.entities.find((e) => e.name === "Screq Table Mode New Place");
  assert.ok(newPlace, "the new place created from Table Mode's add-scene flow must be a real committed entity");
  const edge = snapshot.edges.find(
    (e) => (e.sourceId === "screq-tm-anchor" && e.targetId === newPlace.id) ||
           (e.sourceId === newPlace.id && e.targetId === "screq-tm-anchor")
  );
  assert.ok(edge, "linking from Table Mode must ALSO create a real edge via the same addEdgeOp route -- the link-or-not offer applies identically regardless of which view triggered scene creation (§26.A)");
});

test("TABLE MODE: picking an EXISTING place and declining to link works identically to the construction view's own no-link path", async () => {
  await page.goto(`${base}/#session-planner/${tmScene.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const { snapshot: before1 } = loadSnapshot(dataDir, WORLD);
  const edgeCountBefore = before1.edges.length;

  const addSceneBtn = page.locator(`[data-testid="add-scene-btn"][data-scene-id="${tmScene.id}"]`);
  await addSceneBtn.click();
  const panel = page.locator(`[data-testid="add-scene-panel"][data-scene-id="${tmScene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const existingInput = panel.locator('[data-testid="add-scene-place-input"]');
  await existingInput.waitFor({ state: "visible", timeout: 5000 });
  await existingInput.fill("Screq Existing Waystop");
  const option = panel.locator('[data-testid="add-scene-place-option"][data-entity-id="screq-existing-place"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const linkStep = panel.locator('[data-testid="add-scene-link-step"][data-place-entity-id="screq-existing-place"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });
  await linkStep.locator('[data-testid="add-scene-link-no-btn"]').click();

  const status = page.locator(`[data-testid="add-scene-status"][data-scene-id="${tmScene.id}"]`);
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.textContent ?? "").length > 0,
      `[data-testid="add-scene-status"][data-scene-id="${tmScene.id}"]`,
      { timeout: 10000 }
    );
  }, "declining to link from Table Mode must still succeed and report feedback");

  const { snapshot: after1 } = loadSnapshot(dataDir, WORLD);
  assert.equal(after1.edges.length, edgeCountBefore, "declining to link (existing place, Table Mode) must create zero new edges");
});
