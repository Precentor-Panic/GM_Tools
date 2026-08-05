// Phase 29 task 29.3 -- Objective inline edit (§4) + place-description grid,
// missing-description banner, draft-read-aloud ghost link (§5). Read
// phase29-fixture.mjs's header FIRST. The route-level objective test asserts
// the real 29.1 route (POST /api/session-planner/scenes/:sceneId). The UI
// tests below were RED-asserting-absence at task 29.0 (assert.rejects on a
// selector-timeout); task 29.3 built the DOM, so they are now INVERTED into
// real behavioural assertions per the fixture contract (feature renders, the
// edit persists via the real route, the banner seeds+focuses, the draft link
// composes + saves narration + updates the DOM without a reload).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  updateSceneViaRoute,
  getNarrationViaRoute,
  saveNarrationViaRoute,
  fetchGraphViaRoute,
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

test("UI: objective inline edit renders as the scene's third body line and autosaves via the updateScene route", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc", objectiveNote: "Find the sexton" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const objective = root.locator(`[data-testid="scene-objective"][data-scene-id="${scene.id}"]`);
  await objective.waitFor({ state: "visible", timeout: 5000 });
  assert.equal((await objective.textContent()).trim(), "Find the sexton", "objective renders the scene's own objectiveNote at rest");

  // Click-to-edit, never focus-to-edit.
  await objective.focus();
  assert.equal(await page.locator('[data-testid="scene-objective-input"]').count(), 0, "focus alone must not swap in the edit textarea");

  await objective.click();
  const input = page.locator('[data-testid="scene-objective-input"]');
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill("Recover the drowned ledger");
  await input.blur();

  let persisted = false;
  for (let i = 0; i < 40 && !persisted; i++) {
    const res = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
    const body = await res.json().catch(() => null);
    persisted = body?.scene?.objectiveNote === "Recover the drowned ledger";
    if (!persisted) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(persisted, "the edited objective must persist via the real POST /api/session-planner/scenes/:sceneId route");
  await page.close();
});

test("UI: the place-description grid renders the anchor place's real description and edits persist via editNodeOp", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const desc = root.locator(`[data-testid="scene-place-description"][data-entity-id="op-place-desc"]`);
  await desc.waitFor({ state: "visible", timeout: 5000 });
  assert.ok((await desc.textContent()).includes("half-flooded nave"), "the grid renders the anchor place's real description from the graph");

  // No missing-description banner for a place that HAS a description.
  assert.equal(await root.locator('[data-testid="missing-description-banner"]').count(), 0, "a place with a description must NOT show the banner");

  await desc.click();
  const input = page.locator('[data-testid="scene-place-description-input"]');
  await input.waitFor({ state: "visible", timeout: 5000 });
  const newDesc = "A half-flooded nave, altar tilted into the water. Cold as a dropped well.";
  await input.fill(newDesc);
  await input.blur();

  let persisted = false;
  for (let i = 0; i < 40 && !persisted; i++) {
    const { nodes } = await fetchGraphViaRoute(base, WORLD);
    persisted = nodes.some((n) => n.id === "op-place-desc" && n.description === newDesc);
    if (!persisted) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(persisted, "the edited place description must write back to the graph NODE via POST /api/graph/nodes/:entityId (editNodeOp), not the scene");
  await page.close();
});

test("UI: the missing-description banner renders for a place with no description; clicking it seeds an empty description and focuses the editor", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-nodesc" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const banner = root.locator(`[data-testid="missing-description-banner"][data-entity-id="op-place-nodesc"]`);
  await banner.waitFor({ state: "visible", timeout: 5000 });
  // The grid (and the draft link) are absent while the description is missing.
  assert.equal(await root.locator('[data-testid="scene-place-description"]').count(), 0, "the place-description grid must NOT render while the place has no description");
  assert.equal(await root.locator('[data-testid="draft-read-aloud-link"]').count(), 0, "the draft-read-aloud link stays hidden while the place has no description (the banner covers that case)");

  await banner.click();

  // Banner gone; the grid + its editor are now present, and the editor is focused.
  await root.locator('[data-testid="scene-place-description"]').waitFor({ state: "visible", timeout: 5000 });
  const input = page.locator('[data-testid="scene-place-description-input"]');
  await input.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await root.locator('[data-testid="missing-description-banner"]').count(), 0, "clicking the banner swaps it out for the description grid");

  const focusedTestid = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  assert.equal(focusedTestid, "scene-place-description-input", "clicking the banner focuses the freshly-swapped-in place-description editor");
  await page.close();
});

test("UI: draft-read-aloud composes the place description into narration, updates the DOM without a reload, and saves via the narration route", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc" });
  const narrationBefore = await getNarrationViaRoute(base, WORLD, scene.id);
  assert.equal(narrationBefore.body?.narration, null, "test setup: a fresh scene must start with no narration");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const link = root.locator(`[data-testid="draft-read-aloud-link"][data-scene-id="${scene.id}"]`);
  await link.waitFor({ state: "visible", timeout: 5000 });
  await link.click();

  // The narration DOM updates in place (no reload).
  const narration = root.locator(`[data-testid="scene-narration"][data-scene-id="${scene.id}"]`);
  let domUpdated = false;
  for (let i = 0; i < 40 && !domUpdated; i++) {
    domUpdated = (await narration.textContent()).includes("half-flooded nave");
    if (!domUpdated) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(domUpdated, "the composed narration must appear in the scene-narration DOM without a page reload");

  // And it is persisted via the existing narration route.
  let persisted = false;
  for (let i = 0; i < 40 && !persisted; i++) {
    const res = await getNarrationViaRoute(base, WORLD, scene.id);
    const text = res.body?.narration?.text;
    persisted = typeof text === "string" && text.trim().length > 0;
    if (!persisted) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(persisted, "clicking draft-read-aloud must save a non-empty narration via POST /api/scene-planning/scenes/:sceneId/narration");
  await page.close();
});

test("UI: draft-read-aloud is hidden when the scene already has narration (non-empty narration + place with a description)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "op-place-desc" });
  await saveNarrationViaRoute(base, WORLD, scene.id, "Existing read-aloud already written by hand.");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  // The grid still renders (the place has a description) but the draft link must not.
  await root.locator('[data-testid="scene-place-description"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await root.locator('[data-testid="draft-read-aloud-link"]').count(), 0, "the draft link must not render when the narration is already non-empty");
  await page.close();
});
