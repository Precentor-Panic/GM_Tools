// Phase 23 task 23.0, REQUIRED SCENARIO 1 -- "Scene chain display: a
// persisted, ordered sequence of scenes renders (not just the single
// current-scene view Phase 17 built)... each scene collapsible." Read
// scene-construction-fixture.mjs's header FIRST for the full shared DOM/
// route contract (§1 is this file's own section). EXPECTED TO FAIL right
// now with a Playwright selector-not-found/timeout error -- none of the
// `scene-chain`/`scene-chain-item` DOM exists yet (session-planner-view.js
// still renders Phase 17's single-scene brief only). That failure is the
// deliverable of this task, not a bug in this file.
//
// FIXTURE: a straight-line chain of 4 place entities (a-b-c-d, one edge per
// consecutive pair -- deliberately the SAME shape scene-linkage.mjs's own
// test fixture and scenes-tab-linkage.e2e.mjs already use, not a new
// topology convention), each anchoring one scene. This view is entered from
// scene A specifically -- an END of the chain -- so "ascending hop-distance
// from the loaded scene" (this file's header, §1) gives ONE unambiguous
// total order (a=0, b=1, c=2, d=3) with no ties, rather than entering from a
// middle scene where two chain neighbors would tie on hop-distance and the
// order would be implementation-dependent.
//
// Scenes are created in a DELIBERATELY SCRAMBLED order (a, then d, then b,
// then c) -- specifically so a UI that accidentally echoes creation/append
// order instead of genuinely sorting by hop distance would be caught by this
// file's ordering assertion, rather than passing by coincidence (mirrors
// scenes-tab-linkage.e2e.mjs's own established reasoning for the same
// scramble).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-chain-");
const WORLD = "e2e-scconstruct-chain-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "chaindisp-a", name: "Chain Display A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "chaindisp-b", name: "Chain Display B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "chaindisp-c", name: "Chain Display C", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "chaindisp-d", name: "Chain Display D", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "chaindisp-e0", sourceId: "chaindisp-a", targetId: "chaindisp-b", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "chaindisp-e1", sourceId: "chaindisp-b", targetId: "chaindisp-c", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "chaindisp-e2", sourceId: "chaindisp-c", targetId: "chaindisp-d", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC, sceneD;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  // Scrambled creation order -- see header.
  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "chaindisp-a", objectiveNote: "Scene at A" });
  sceneD = await createSceneViaRoute(base, WORLD, { locationEntityId: "chaindisp-d", objectiveNote: "Scene at D" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "chaindisp-b", objectiveNote: "Scene at B" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "chaindisp-c", objectiveNote: "Scene at C" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("entering the view on scene A renders all 4 chain scenes, in ascending hop-distance order (a,b,c,d), not creation order", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);

  const chain = page.locator('[data-testid="scene-chain"]');
  await chain.waitFor({ state: "visible", timeout: 15000 });

  const items = page.locator('[data-testid="scene-chain-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 4, { timeout: 10000 });
  }, "expected all 4 chained scenes to render");
  assert.equal(await items.count(), 4);

  const orderedIds = await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.deepEqual(
    orderedIds,
    [sceneA.id, sceneB.id, sceneC.id, sceneD.id],
    "chain must render in ascending hop-distance order from the loaded scene (a,b,c,d) -- NOT creation order (scrambled a,d,b,c above) and not any other order"
  );
});

test("the loaded scene's own chain item is marked current and starts expanded; the others start collapsed", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 4, { timeout: 15000 });

  const itemA = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneA.id}"]`);
  assert.equal(await itemA.getAttribute("data-current"), "true", "the loaded scene's own chain item must carry data-current=\"true\"");
  assert.equal(await itemA.evaluate((el) => el.open), true, "the current scene's <details> chain item must start expanded (open)");

  const itemB = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneB.id}"]`);
  assert.notEqual(await itemB.getAttribute("data-current"), "true", "a non-current scene must not carry data-current=\"true\"");
  assert.equal(await itemB.evaluate((el) => el.open), false, "a non-current scene's chain item must start collapsed");
});

test("each chain item is genuinely independently collapsible via its own <summary> toggle, and reveals that scene's own anchor card", async () => {
  await page.goto(`${base}/#session-planner/${sceneA.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"]').length === 4, { timeout: 15000 });

  const itemC = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneC.id}"]`);
  const toggleC = itemC.locator('[data-testid="scene-chain-toggle"]');
  await toggleC.waitFor({ state: "visible", timeout: 5000 });

  // Not yet expanded -- its own anchor card must not be visible/present yet
  // (collapsed <details> content is not rendered as "visible" to Playwright).
  const anchorCardC = itemC.locator('[data-testid="location-card"][data-card-role="anchor"]');
  assert.equal(await anchorCardC.isVisible().catch(() => false), false, "scene C's anchor card must not be visible while its chain item is collapsed");

  await toggleC.click();
  await anchorCardC.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await anchorCardC.getAttribute("data-entity-id"), "chaindisp-c", "expanding scene C's chain item must reveal SCENE C's own anchor card, not some other scene's");
  assert.equal(await itemC.evaluate((el) => el.open), true);

  // Collapsing again via the same toggle hides it -- genuinely a real
  // <details> toggle, not a one-way reveal.
  await toggleC.click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-testid="scene-chain-item"][data-scene-id="${id}"]`);
        return el && el.open === false;
      },
      sceneC.id,
      { timeout: 5000 }
    );
  }, "clicking the toggle a second time must collapse scene C's chain item again");

  // Scene A (the originally-current one, expanded independently of C) must
  // be totally unaffected by C's own expand/collapse -- proves each item
  // collapses independently, not as a single shared accordion.
  const itemA = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneA.id}"]`);
  assert.equal(await itemA.evaluate((el) => el.open), true, "scene A must remain expanded, unaffected by toggling scene C");
});
