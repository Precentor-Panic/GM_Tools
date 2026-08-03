// Phase 23 task 23.0, REQUIRED SCENARIO 9 -- "Mid-session '+' quick-gen
// path: types a name, submits, asserts exactly one LLM call fires (mocked)
// -- no multi-round Q&A UI involved, genuinely fast (one field, one
// button)." Read scene-construction-fixture.mjs's header first (§8 is this
// file's own section).
//
// ***UPDATED by Phase 26 task 26.0*** (plans/phase-26-tasks.md §26.A/§26.5,
// task 26.0 REQUIRED SCENARIO 2 -- "Quick-gen no longer produces an
// untethered scene... asserted against the real created scene's
// locationEntityId"). This file's ORIGINAL final assertion
// (`data-untethered === "true"`) is now WRONG under the new contract and has
// been corrected here, not left as a silently-contradictory frozen test --
// per plans/phase-26-tasks.md's own explicit instruction that this is
// expected/correct, not a regression. See phase26-fixture.mjs's header §4
// for the full new contract (`quick-add-scene-place-step`, reusing the
// shared place-step/link-step shape §3 there documents). The "exactly one
// LLM call, no multi-round Q&A" property THIS file's own scenario is named
// after is UNCHANGED and still the crux of what's tested below -- only the
// post-generation flow (now place-required) and the final scene-shape
// assertion changed.
//
// EXPECTED TO FAIL right now with a Playwright selector-not-found/timeout
// error -- none of `quick-add-scene-place-step` exists yet. That failure is
// the deliverable of this task, not a bug in this file.
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
  { op: "upsert_entity", data: { id: "quickgen-anchor", name: "Quick-Gen Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "quickgen-existing-place", name: "Quick-Gen Existing Place", type: "place", importance: 0.5 } }
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

test("quick-add: one field, one button, exactly one mocked LLM call, no multi-round Q&A UI -- but (Phase 26) the resulting scene is now REQUIRED to have a real place, never untethered", async () => {
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

  // The GENERATION step itself is still exactly one field, one button -- no
  // framing-card/reframe-shaped multi-round Q&A UI anywhere in this panel,
  // matching this scenario's own still-standing "genuinely fast" bar.
  const nameInput = panel.locator('[data-testid="quick-add-scene-name-input"]');
  await nameInput.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await panel.locator('[data-testid="develop-scene-review-framing-option"], .framing-cards, [data-testid*="reframe"]').count(), 0, "the quick-add panel must never involve the multi-round Q&A/reframe UI");

  await nameInput.fill("The Roadside Shrine");
  const submitBtn = panel.locator('[data-testid="quick-add-scene-submit-btn"]');
  await submitBtn.click();

  assert.equal(quickGenCalls.length, 1, "quick-add's generation step must make EXACTLY ONE call to the real quick-gen route -- no round-trip, unchanged from Phase 23");

  // Phase 26: the SAME place-step/link-step shape §26.A defines for every
  // scene-creation path now appears here too, prefixed `quick-add-scene`.
  const placeStep = panel.locator('[data-testid="quick-add-scene-place-step"]');
  await placeStep.waitFor({ state: "visible", timeout: 10000 });

  const existingInput = placeStep.locator('[data-testid="quick-add-scene-place-input"]');
  await existingInput.fill("Quick-Gen Existing Place");
  const option = placeStep.locator('[data-testid="quick-add-scene-place-option"][data-entity-id="quickgen-existing-place"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const linkStep = panel.locator('[data-testid="quick-add-scene-link-step"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });
  await linkStep.locator('[data-testid="quick-add-scene-link-no-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 2, { timeout: 10000 });
  }, "submitting the full quick-add flow (generate, then resolve a place) must append exactly one new scene to the chain");

  assert.equal(quickGenCalls.length, 1, "resolving the place step must NOT trigger any additional quick-gen LLM calls -- still exactly one, total");

  const items = page.locator('[data-testid="scene-chain-item"]');
  const newItem = items.last();
  const newSceneId = await newItem.getAttribute("data-scene-id");
  assert.notEqual(await newItem.getAttribute("data-untethered"), "true", "***Phase 26 fix***: a quick-gen scene must NEVER be marked untethered any more -- task 26.0 scenario 2's whole point (§26.A: 'every path that creates a scene must supply a place')");

  const brief = await (await fetch(`${base}/api/session-planner/brief?world=${WORLD}&sceneId=${newSceneId}`)).json();
  const anchorLoc = (brief.brief?.locations ?? []).find((l) => l.distance === 0);
  assert.equal(anchorLoc?.entityId, "quickgen-existing-place", "the quick-gen scene's real locationEntityId must be the resolved place -- asserted against the real created scene, not just DOM state, per scenario 2's own explicit wording");

  await page.unroute("**/api/scene-planning/quick-gen");
});
