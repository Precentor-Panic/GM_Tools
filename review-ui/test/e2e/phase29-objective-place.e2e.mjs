// Phase 29 task 29.0 -- Objective inline edit (§4) + place-description grid,
// missing-description banner, draft-read-aloud ghost link (§5). Read
// phase29-fixture.mjs's header FIRST. EXPECTED TO FAIL right now: the
// objective route-level test gets a real 404 (confirmed by direct read of
// review-ui/server.mjs -- a bare POST to `/api/session-planner/scenes/
// :sceneId` matches no handler today, only `.../rename` and `.../fork` do).
// Every UI-level test gets a real Playwright selector-timeout: none of
// `scene-objective`, `scene-place-description`, `missing-description-
// banner`, `draft-read-aloud-link` exist in session-planner-view.js yet
// (confirmed by direct read). Both failure shapes are the deliverable of
// this task, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  updateSceneViaRoute,
  getNarrationViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase29Env("gm-tools-e2e-objplace-");
const WORLD = "e2e-objplace-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "op-place-desc", name: "The Drowned Chapel", type: "place", importance: 0.5, description: "A half-flooded nave, altar tilted into the water." } },
  { op: "upsert_entity", data: { id: "op-place-nodesc", name: "The Bare Vestry", type: "place", importance: 0.5 } }
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

test("ROUTE LEVEL (RED): POST /api/session-planner/scenes/:sceneId {objectiveNote} updates the scene", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc", objectiveNote: "Find the sexton" });
  const { status, body } = await updateSceneViaRoute(base, WORLD, scene.id, { objectiveNote: "Recover the drowned ledger" });
  assert.equal(status, 200, "29.1: POST /api/session-planner/scenes/:sceneId must exist and succeed -- RED today, real 404 (only .../rename and .../fork are wired)");
  assert.equal(body?.scene?.objectiveNote, "Recover the drowned ledger", "29.1: the scene's objectiveNote must be updated");

  const { status: status2, body: body2 } = await updateSceneViaRoute(base, WORLD, scene.id, { name: "Chapel confrontation" });
  assert.equal(status2, 200);
  assert.equal(body2?.scene?.name, "Chapel confrontation");
  assert.equal(body2?.scene?.objectiveNote, "Recover the drowned ledger", "29.1: patching `name` alone must leave objectiveNote untouched (independent, patch-style fields)");
});

test("UI (RED): objective inline edit does not exist on the scene page yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc", objectiveNote: "Find the sexton" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="scene-objective"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.3: `scene-objective` must render as the scene page's third body line -- RED today, absent from the DOM"
  );
  await page.close();
});

test("UI (RED): the place-description grid does not exist for a place WITH a description", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="scene-place-description"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.3: `scene-place-description` must render the anchor place's real description -- RED today, absent from the DOM"
  );
  await page.close();
});

test("UI (RED): the missing-description banner does not exist for a place with NO description", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-nodesc" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="missing-description-banner"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.3: `missing-description-banner` must render when the anchor place has no description -- RED today, absent from the DOM"
  );
  await page.close();
});

test("UI (RED): draft-read-aloud ghost link does not exist (place has a description, narration is empty)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc" });
  const narrationBefore = await getNarrationViaRoute(base, WORLD, scene.id);
  assert.equal(narrationBefore.body?.narration, null, "test setup: a fresh scene must start with no narration");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="draft-read-aloud-link"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.3: `draft-read-aloud-link` must render when narration is empty and the place has a description -- RED today, absent from the DOM"
  );
  await page.close();
});
