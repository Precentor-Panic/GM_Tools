// Phase 25 task 25.0, REQUIRED SCENARIO 3 -- "Adjacent-scenes strip: seed a
// real multi-scene chain, assert the immediate hop-1 neighbors render as
// single-tap targets, no picker/no intermediate step." Read table-mode-
// fixture.mjs's header FIRST (§3 is this file's own section). EXPECTED TO
// FAIL right now -- none of `table-nav-zone`/`table-adjacent-strip` exists
// yet. That failure is the deliverable of this task, not a bug in this
// file.
//
// ***UPDATED by Phase 26 task 26.0*** (plans/phase-26-tasks.md §26.8, task
// 26.0 REQUIRED SCENARIO 7 -- "Table Mode is Plan-scoped... replaces the old
// flat 'all scenes' list contract from table-mode-navigation.e2e.mjs/
// table-mode-search.e2e.mjs"). This file ORIGINALLY (Phase 25 task 25.0)
// also carried "REQUIRED SCENARIO 5" (the collapsed `table-full-list`
// flat-scene-list tests) -- THOSE TWO TESTS ARE REMOVED HERE, since
// `table-full-list` itself is removed entirely by Phase 26 §26.8 (superseded
// by the new Plan-scoped browse structure -- see table-mode-plan-scoped
// .e2e.mjs for its replacement contract, including its own explicit
// `table-full-list` DOM-absence assertion). The adjacent-scenes-strip tests
// below are UNCHANGED and UNAFFECTED by Plan-scoping (a separate,
// independent navigation mechanism, per phase26-fixture.mjs's header §7
// "adjacent-scenes strip stays UNCHANGED") -- kept here as-is, not moved,
// since their own contract never mentioned the flat list.
//
// FIXTURE: a straight-line chain of 4 place entities (a-b-c-d), matching
// scene-construction-chain-display.e2e.mjs's / scenes-tab-linkage.e2e.mjs's
// own established chain-fixture shape exactly. This suite enters Table Mode
// on scene B specifically (the middle of the chain, NOT an endpoint) so it
// has TWO real hop-1 neighbors (A and C) -- proving the strip surfaces every
// immediate neighbor, not just "the next one" -- while D (hop-2 from B)
// must NOT appear in the adjacent strip, only in the full list.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoTableMode,
  DESKTOP_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-nav-");
const WORLD = "e2e-tablemode-nav-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmnav-a", name: "Nav Chain A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmnav-b", name: "Nav Chain B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmnav-c", name: "Nav Chain C", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmnav-d", name: "Nav Chain D", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "tmnav-e0", sourceId: "tmnav-a", targetId: "tmnav-b", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "tmnav-e1", sourceId: "tmnav-b", targetId: "tmnav-c", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "tmnav-e2", sourceId: "tmnav-c", targetId: "tmnav-d", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC, sceneD;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  // Scrambled creation order, matching this project's established
  // "an implementation that just echoes creation order would be caught"
  // reasoning (scene-construction-chain-display.e2e.mjs / scenes-tab-
  // linkage.e2e.mjs's own precedent).
  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-a" });
  sceneD = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-d" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-b" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnav-c" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("the adjacent-scenes strip shows exactly the hop-1 neighbors (A, C) of scene B, and NOT the hop-2 neighbor (D) or scene B itself", async () => {
  await gotoTableMode(page, base, sceneB.id);

  const strip = page.locator('[data-testid="table-adjacent-strip"]');
  await strip.waitFor({ state: "visible", timeout: 15000 });

  const items = strip.locator('[data-testid="table-adjacent-scene-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length === 2,
      '[data-testid="table-adjacent-strip"] [data-testid="table-adjacent-scene-item"]',
      { timeout: 10000 }
    );
  }, "expected exactly 2 adjacent-scene items (A and C) for scene B");
  assert.equal(await items.count(), 2);

  const ids = await items.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.deepEqual(new Set(ids), new Set([sceneA.id, sceneC.id]), "the adjacent strip must contain exactly scene A and scene C, the two real hop-1 neighbors of scene B");
  assert.ok(!ids.includes(sceneB.id), "scene B must never list itself as its own adjacent neighbor");
  assert.ok(!ids.includes(sceneD.id), "scene D is hop-2 from B -- must not appear in the adjacent strip");
});

test("clicking an adjacent-scene item is a single tap that jumps directly to that scene, staying in Table Mode", async () => {
  await gotoTableMode(page, base, sceneB.id);

  const itemC = page.locator(`[data-testid="table-adjacent-strip"] [data-testid="table-adjacent-scene-item"][data-scene-id="${sceneC.id}"]`);
  await itemC.waitFor({ state: "visible", timeout: 15000 });
  await itemC.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}?mode=table`,
      sceneC.id,
      { timeout: 5000 }
    );
  }, "clicking an adjacent-scene item must navigate straight to that scene's own Table Mode URL, no intermediate picker step");

  const tableView = page.locator('[data-testid="table-mode-view"]');
  await tableView.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await tableView.getAttribute("data-scene-id"), sceneC.id);
});

// ***REMOVED by Phase 26 task 26.0***: this file originally had two more
// tests here ("the full scene list renders as a collapsed <details> by
// default..." / "expanding the full list reveals all 4 scenes..."),
// asserting Phase 25's `table-full-list` flat "all scenes" contract.
// `table-full-list` is removed entirely by Phase 26 §26.8 (superseded by
// Plan-scoped browsing) -- see table-mode-plan-scoped.e2e.mjs for its own
// explicit `table-full-list` DOM-absence assertion plus the full replacement
// contract (table-start-new-plan-btn / table-active-plan-list / table-other-
// plans-list). Deleting rather than rewriting those two tests here (as
// opposed to scene-construction-insert-between.e2e.mjs's own "rewrite to
// assert absence" approach) since a dedicated absence assertion already
// lives in table-mode-plan-scoped.e2e.mjs and duplicating it here would add
// nothing; `sceneD` stays declared/seeded above since it remains useful
// fixture context (confirms the adjacent-strip's hop-2 exclusion in the
// first test above) even though it's no longer independently exercised by
// a full-list test.
