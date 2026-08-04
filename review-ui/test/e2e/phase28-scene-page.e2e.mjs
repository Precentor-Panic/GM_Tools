// Phase 28 task 28.0 -- The one Scene page (place header + this-scene
// narration + only-non-empty element fields + breadcrumb/prev-next). Read
// phase28-fixture.mjs's header FIRST (§3/§4/§5 are this file's own
// sections). EXPECTED TO FAIL right now: `#session-planner/<sceneId>` still
// renders the OLD chain view (session-planner-view.js's renderSessionPlanner
// is completely unmodified by this task), so `[data-testid="scene-page"]`
// never appears -- every locator below times out. The narration/elements
// scenarios ALSO depend on brand-new routes (`POST .../narration`,
// `POST .../elements`) that don't exist yet, so those fail even earlier,
// with a real 404 surfaced through this file's own assert.equal(status, 200)
// checks. Both failure shapes are the deliverable of this task, not a bug in
// this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase28Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  createSceneElementViaRoute,
  saveNarrationViaRoute,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase28-fixture.mjs";

const { scratchDir, dataDir } = setupPhase28Env("gm-tools-e2e-scene-page-");
const WORLD = "e2e-scene-page-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sp-place-a", name: "The Weeping Tower", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sp-place-b", name: "Millbrook Crossing", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sp-place-c", name: "Cinder Hollow", type: "place", importance: 0.5 } }
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

test("scene page renders one scene-page root with a click-to-edit place name; focus alone does NOT enter edit; a click does, and the edit persists via the real graph route", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sp-place-a" });

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const nameEl = root.locator(`[data-testid="scene-place-name"][data-entity-id="sp-place-a"]`);
  await nameEl.waitFor({ state: "visible", timeout: 5000 });
  assert.equal((await nameEl.textContent()).trim(), "The Weeping Tower");

  // Focus alone must NOT enter edit mode (deliberate click-to-edit, not
  // focus-to-edit -- a tablet scroll/tab-through must never mangle prep).
  await nameEl.focus();
  assert.equal(await page.locator('[data-testid="scene-place-name-input"]').count(), 0, "focus alone must not swap in the edit textarea");

  // A real click DOES enter edit.
  await nameEl.click();
  const input = page.locator('[data-testid="scene-place-name-input"]');
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill("The Weeping Tower (renamed)");
  await input.blur();

  let renamed = false;
  for (let i = 0; i < 40 && !renamed; i++) {
    const res = await fetch(`${base}/api/graph?world=${WORLD}&filter=all`);
    const { nodes } = await res.json();
    renamed = nodes.some((n) => n.id === "sp-place-a" && n.name === "The Weeping Tower (renamed)");
    if (!renamed) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(renamed, "the renamed place must persist via the real POST /api/graph/nodes/:entityId route (autosave), not just in-page DOM state");
  await page.close();
});

test("this-scene narration is click-to-edit and autosaves via the new scene-scoped narration route", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sp-place-b" });

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const narration = page.locator(`[data-testid="scene-narration"][data-scene-id="${scene.id}"]`);
  await narration.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="scene-narration-input"]').count(), 0, "narration must be invisible-at-rest, no textarea chrome before interaction");

  await narration.click();
  const input = page.locator('[data-testid="scene-narration-input"]');
  await input.waitFor({ state: "visible", timeout: 5000 });
  const text = "The floorboards creak underfoot; dust motes drift in a shaft of grey light.";
  await input.fill(text);
  await input.blur();

  let persisted = false;
  for (let i = 0; i < 40 && !persisted; i++) {
    const res = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/narration?world=${WORLD}`);
    if (res.status === 200) {
      const body = await res.json();
      persisted = body?.narration?.text === text;
    }
    if (!persisted) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(persisted, "the typed narration must autosave via POST .../narration and be readable back via GET .../narration");
  await page.close();
});

test("element field-lines: only NON-EMPTY fields render -- an element with just trigger set shows exactly one field-line, never an empty box for looks/means/function/wants/secret", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sp-place-c" });

  const { status, body } = await createSceneElementViaRoute(base, WORLD, scene.id, {
    name: "A rusted iron lockbox",
    fields: { trigger: "Party pries it open with a tool or DC 12 Strength check.", gives: "" }
  });
  assert.equal(status, 200, `element creation itself must succeed for this DOM scenario to be meaningful (got ${status}: ${JSON.stringify(body)})`);
  const elementId = body.element.id;

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const row = page.locator(`[data-testid="scene-element-row"][data-element-id="${elementId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });

  const triggerField = row.locator('[data-testid="scene-element-field"][data-field="trigger"]');
  await triggerField.waitFor({ state: "visible", timeout: 5000 });

  for (const emptyField of ["looks", "means", "function", "wants", "secret", "checks"]) {
    const count = await row.locator(`[data-testid="scene-element-field"][data-field="${emptyField}"]`).count();
    assert.equal(count, 0, `an element with "${emptyField}" unset must render NO field-line for it -- never an empty box`);
  }
  await page.close();
});

test("breadcrumb back-btn returns to the scene's owning plan; prev/next step within that plan's own scene order and are absent at the ends", async () => {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "sp-place-a" });
  const sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "sp-place-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Breadcrumb Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);

  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${sceneA.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  assert.equal(await root.locator('[data-testid="scene-breadcrumb-prev-btn"]').count(), 0, "the FIRST scene in the plan must not offer a prev-btn");
  await root.locator('[data-testid="scene-breadcrumb-next-btn"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#session-planner/${id}`, sceneB.id, { timeout: 10000 });
  }, "next-btn must step to the next scene in this plan's own order");

  const rootB = page.locator(`[data-testid="scene-page"][data-scene-id="${sceneB.id}"]`);
  await rootB.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await rootB.locator('[data-testid="scene-breadcrumb-next-btn"]').count(), 0, "the LAST scene in the plan must not offer a next-btn");

  await rootB.locator('[data-testid="scene-breadcrumb-back-btn"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#plans/${id}`, plan.id, { timeout: 10000 });
  }, "the breadcrumb back-btn must return to this scene's owning plan");
  await page.close();
});
