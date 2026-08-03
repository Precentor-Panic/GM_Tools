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
// expected/correct, not a regression.
//
// ***UPDATED AGAIN by Phase 27 task 27.0*** (F5/F6: the CONSTRUCTION VIEW's
// own top-level "+ Quick add scene" -- `quick-add-scene-btn`/-panel/-name-
// input/-submit-btn/-status, the exact control this file's own tests used
// to drive -- is RETIRED ENTIRELY, folded into the single plan-level
// "+Scene" control (see phase27-fixture.mjs's header §7). This file's OLD
// positive-behavior test (drive quick-add-scene-btn, assert a scene gets
// created) is RETIRED, replaced below by a DOM-absence assertion for the
// whole construction-view quick-add mechanism. Table Mode's OWN, SEPARATE
// `table-quick-gen-*` control (buildTableQuickGenControl, a different
// control that always was) is UNTOUCHED by F5/F6 and is now where this
// file's F2 naming-fix coverage lives instead (§6 of phase27-fixture.mjs's
// header: the SURVIVING objectiveNote bug site is Table Mode's own, not the
// retired construction-view one). EXPECTED TO FAIL right now: the CURRENT
// code still renders `quick-add-scene-btn` live in the construction view
// (confirmed fresh against the real session-planner-view.js's
// buildQuickAddScenePanel, still called from loadAndRenderChain) -- so the
// absence assertion below currently fails; and Table Mode's own quick-gen
// still sets `objectiveNote: \`${name} — ${genRes.text}\`` (line ~2980,
// confirmed fresh) -- so the naming-fix assertion below currently fails
// too. Both are the deliverable of this task, not a bug in this file.
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

test("Phase 27 (F5/F6): the construction view's top-level '+ Quick add scene' mechanism is retired entirely -- real DOM-absence", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 1, { timeout: 15000 });

  for (const testid of ["quick-add-scene-btn", "quick-add-scene-panel", "quick-add-scene-name-input", "quick-add-scene-submit-btn", "quick-add-scene-status"]) {
    const count = await page.evaluate((t) => document.querySelectorAll(`[data-testid="${t}"]`).length, testid);
    assert.equal(count, 0, `${testid} must be COMPLETELY REMOVED from the construction view (F5/F6) -- folded into the single plan-level +Scene control`);
  }
});

test("Phase 27 (F2): Table Mode's OWN, surviving quick-gen never taints the created scene's display with LLM-generated text -- it must show the real place name", async () => {
  const quickGenCalls = [];
  await page.route("**/api/scene-planning/quick-gen", async (route) => {
    quickGenCalls.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "A dusty roadside shrine, half-collapsed, still smelling faintly of incense.", truncated: false })
    });
  });

  await page.goto(`${base}/#session-planner/${scene.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const quickGenBtn = page.locator('[data-testid="table-quick-gen-btn"]');
  await quickGenBtn.waitFor({ state: "visible", timeout: 10000 });
  await quickGenBtn.click();

  const panel = page.locator('[data-testid="table-quick-gen-panel"]');
  await panel.waitFor({ state: "visible", timeout: 5000 });
  const nameInput = panel.locator('[data-testid="table-quick-gen-name-input"]');
  await nameInput.waitFor({ state: "visible", timeout: 5000 });
  await nameInput.fill("The Roadside Shrine");
  await panel.locator('[data-testid="table-quick-gen-submit-btn"]').click();

  assert.equal(quickGenCalls.length, 1, "Table Mode's quick-gen must still make exactly one real quick-gen call, unchanged");

  const placeStep = panel.locator('[data-testid="table-quick-gen-place-step"]');
  await placeStep.waitFor({ state: "visible", timeout: 10000 });
  const existingInput = placeStep.locator('[data-testid="table-quick-gen-place-input"]');
  await existingInput.fill("Quick-Gen Existing Place");
  const option = placeStep.locator('[data-testid="table-quick-gen-place-option"][data-entity-id="quickgen-existing-place"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const linkStep = panel.locator('[data-testid="table-quick-gen-link-step"]');
  await linkStep.waitFor({ state: "visible", timeout: 10000 });
  await linkStep.locator('[data-testid="table-quick-gen-link-no-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => (document.querySelector(sel)?.textContent ?? "").length > 0,
      '[data-testid="table-quick-gen-status"]',
      { timeout: 10000 }
    );
  }, "Table Mode's quick-gen flow must report success feedback once the scene is created");

  const scenesRes = await fetch(`${base}/api/scene-planning/scenes?world=${WORLD}`);
  const scenesBody = await scenesRes.json();
  const newScene = scenesBody.scenes.find((s) => s.locationEntityId === "quickgen-existing-place");
  assert.ok(newScene, "the quick-gen scene must be a real, persisted scene anchored to the resolved place");

  // ***THE F2 FIX ITSELF***: neither `name` nor `objectiveNote` may carry
  // the LLM-generated text -- resolveSceneDisplayName must be free to fall
  // back to the real place name (Quick-Gen Existing Place), never
  // `"The Roadside Shrine — A dusty roadside shrine..."`.
  assert.ok(
    !newScene.name || !newScene.name.includes(quickGenCalls.length ? "dusty roadside shrine" : ""),
    "the created scene's own `name` must never contain the LLM-generated quick-gen text"
  );
  assert.ok(
    !newScene.objectiveNote || !newScene.objectiveNote.includes("dusty roadside shrine"),
    `the created scene's objectiveNote must never be set to LLM-generated text (the F2 bug: objectiveNote: \`\${name} — \${genRes.text}\`) -- got objectiveNote=${JSON.stringify(newScene.objectiveNote)}`
  );

  await page.unroute("**/api/scene-planning/quick-gen");
});
