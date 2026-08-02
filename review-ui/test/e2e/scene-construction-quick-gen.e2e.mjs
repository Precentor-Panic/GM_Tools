// Phase 23 task 23.0, REQUIRED SCENARIO 9 -- "Mid-session '+' quick-gen
// path: types a name, submits, asserts exactly one LLM call fires (mocked)
// -- no multi-round Q&A UI involved, genuinely fast (one field, one
// button)." Read scene-construction-fixture.mjs's header first (§8 is this
// file's own section). EXPECTED TO FAIL right now with a Playwright
// selector-not-found/timeout error -- none of this DOM exists yet. That
// failure is the deliverable of this task, not a bug in this file.
//
// The real `POST /api/scene-planning/quick-gen` route is MOCKED via
// page.route() -- mutation-engine/quick-gen.mjs's quickGenerate is a real
// LLM call (callModelDetailed), and this environment has no
// ANTHROPIC_API_KEY (this suite's own established convention, see
// scene-construction-develop.e2e.mjs's header for the identical reasoning).
// The mock is a call-count spy, which is the entire point of this scenario.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-quickgen-");
const WORLD = "e2e-scconstruct-quickgen-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "quickgen-anchor", name: "Quick-Gen Anchor", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "quickgen-anchor" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("quick-add: one field, one button, exactly one mocked LLM call, no multi-round Q&A UI, a new untethered scene appended to the chain", async () => {
  const quickGenCalls = [];
  await page.route("**/api/scene-planning/quick-gen", async (route) => {
    quickGenCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "A dusty roadside shrine, half-collapsed, still smelling faintly of incense.", truncated: false })
    });
  });

  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 1, { timeout: 15000 });

  const quickAddBtn = page.locator('[data-testid="quick-add-scene-btn"]');
  await quickAddBtn.waitFor({ state: "visible", timeout: 10000 });
  await quickAddBtn.click();

  const panel = page.locator('[data-testid="quick-add-scene-panel"]');
  await panel.waitFor({ state: "visible", timeout: 5000 });

  // Exactly ONE field, one button -- no framing-card / reframe-shaped
  // multi-round Q&A UI anywhere in this panel.
  const nameInput = panel.locator('[data-testid="quick-add-scene-name-input"]');
  await nameInput.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await panel.locator("textarea, input").count(), 1, "the quick-add panel must expose exactly one text field");
  assert.equal(await panel.locator('[data-testid="develop-scene-review-framing-option"], .framing-cards, [data-testid*="reframe"]').count(), 0, "the quick-add panel must never involve the multi-round Q&A/reframe UI");

  await nameInput.fill("The Roadside Shrine");
  const submitBtn = panel.locator('[data-testid="quick-add-scene-submit-btn"]');
  await submitBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 10000 });
  }, "submitting the quick-add form must append exactly one new scene to the chain");

  assert.equal(quickGenCalls.length, 1, "quick-add must make EXACTLY ONE call to the real quick-gen route -- no round-trip");

  const items = page.locator('[data-testid="scene-chain-item"]');
  const newItem = items.last();
  assert.equal(await newItem.getAttribute("data-untethered"), "true", "a quick-gen scene has no real-world anchor -- it must be marked untethered and appended at the end of the chain");

  await page.unroute("**/api/scene-planning/quick-gen");
});
