// Phase 24 task 24.0 -- sibling of scenes-tab-browse-and-navigate.e2e.mjs;
// read that file's header first for the shared nav-entry/browse-list/
// search/empty-state contract and the Phase-22-only dependency statement
// (this file repeats none of that, only the linkage-specific pieces).
// EXPECTED TO FAIL right now with a Playwright "waiting for selector" /
// timeout error, since none of the DOM below exists yet -- that failure is
// the deliverable of this task, not a bug in this file.
//
// This is the test for the design record's core Scenes-tab requirement
// (plans/phase-21-review.md §2): "Scenes should be stored/queryable in a
// graph-like fashion specifically so that selecting one can surface other
// scenes linked to it (the path-based chain it belongs to)." Phase 22 task
// 22.1 already built and shipped exactly this query, DERIVED (never
// stored) -- session-planner/scene-linkage.mjs's
// `linkedScenesForScene(world, sceneId, snapshot, opts={maxHops})`, exposed
// live via `GET /api/scene-planning/linkage?world=&sceneId=&maxHops=`
// (review-ui/server.mjs, Phase 22 task 22.7, already shipped and already
// covered by review-ui/test/scene-planning-routes.test.mjs's own passing
// suite). This file proves the (not-yet-built) Scenes tab UI consumes THAT
// real route/function -- it does not re-derive or duplicate linkage logic of
// its own anywhere in this test.
//
// ---------------------------------------------------------------------------
// DOM CONTRACT this file pins (additive to scenes-tab-browse-and-navigate
// .e2e.mjs's `scene-list-item`/`scene-list-item-open` contract):
// ---------------------------------------------------------------------------
//
//   - `[data-testid="scene-list-item-linked-toggle"]` -- one per
//     `scene-list-item` (see sibling file), a SEPARATE control from
//     `scene-list-item-open`. This is the "selecting a scene" affordance the
//     design record's own §2 language refers to -- deliberately NOT the same
//     click target as `scene-list-item-open`'s fast-re-entry navigation,
//     because "select this scene to inspect its chain" and "jump straight
//     into planning this scene" are two different DM intents that must stay
//     independently reachable (this project's own standing §6 principle from
//     plans/phase-21-review.md, "never make a capability harder to find to
//     nudge toward another one," generalizes cleanly to this same shape:
//     collapsing select-to-inspect and open-to-navigate into one click would
//     make the FIRST one unreachable without also triggering the second).
//     Clicking it toggles open an inline linked-scenes panel FOR THAT SCENE,
//     without navigating away from the Scenes tab.
//
//   - `[data-testid="linked-scenes-panel"][data-scene-id="<selectedId>"]`
//     -- rendered once a scene's `linked-toggle` has been clicked, `<selectedId>`
//     identifying which scene it's currently showing linkage for. Backed by
//     a real `GET /api/scene-planning/linkage?world=...&sceneId=<selectedId>`
//     call (this file does not pin an exact maxHops value the UI must pass;
//     every scene in this file's fixture chain sits within
//     scene-linkage.mjs's own exported `DEFAULT_LINKAGE_MAX_HOPS` regardless
//     of whether the UI passes an explicit override or relies on that
//     default, so this file is correct either way).
//
//   - `[data-testid="linked-scene-item"][data-scene-id="<id>"]` -- one per
//     entry in `linkedScenesForScene`'s own returned array, in THE SAME
//     ORDER that array is documented (session-planner/scene-linkage.mjs's
//     own header/JSDoc, verified by reading the real shipped file) to
//     return: ascending by `hopDistance`. Each contains:
//       - `[data-testid="linked-scene-anchor-name"]` -- the linked scene's
//         anchor entity's name (`linkedScenesForScene`'s own
//         `anchorEntityName` field, already resolved server-side -- no
//         second graph lookup needed by the UI for this specific field).
//       - `[data-testid="linked-scene-hop-distance"]` -- some human-
//         readable rendering of `hopDistance` (this file only asserts the
//         raw number appears in the text somewhere, not exact copy).
//       - `[data-testid="linked-scene-open"]` -- mirrors
//         `scene-list-item-open`'s exact navigation contract (clicking routes
//         to `#session-planner/<thatLinkedSceneId>`, landing in the existing
//         Session Planner view for THAT scene) -- this is the "clicking a
//         scene... from a linked-scenes result" half of the design record's
//         "fast re-entry" requirement that scenes-tab-browse-and-navigate
//         .e2e.mjs's own last click-to-navigate test does not cover (that
//         file only exercises the main list's own open control).
//   - `[data-testid="linked-scenes-empty"]` -- rendered instead of any
//     `linked-scene-item`s when the panel is open for a scene with no linked
//     scenes at all (not exercised by this file's own fixture, which always
//     has real linkage; documented here for implementers as the sibling to
//     `scenes-empty-state`'s own "never blank space" precedent).
//
// ---------------------------------------------------------------------------
// FIXTURE: a straight chain of graph entities/edges, matching
// test/scene-planning/scene-linkage.test.mjs's OWN established chain-fixture
// shape exactly (same {id, name, type, importance} entity shape, same
// {id, sourceId, targetId, relationshipType} edge shape) -- not a new
// fixture convention invented for this file. Chain: a-b-c-d, hop distance
// from 'a' equal to its index (a=0, b=1, c=2, d=3). Every hop here is well
// within scene-linkage.mjs's own DEFAULT_LINKAGE_MAX_HOPS=4, so this fixture
// is correct regardless of whatever maxHops behavior the (not yet built) UI
// ends up choosing.
//
// Scenes are created via the real POST /api/session-planner/scenes route (a
// real chain of 4 scenes, i.e. "3+" per this task's own requirement) in a
// DELIBERATELY SCRAMBLED order (a, then d, then b, then c) -- specifically
// so that a UI implementation that accidentally just echoes creation/append
// order (listScenesForWorld's own documented order) instead of genuinely
// sorting by the linkage query's own hopDistance would be caught by this
// test's ordering assertion below, rather than passing by coincidence.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-scenes-tab-linkage-");
const WORLD = "e2e-scenes-tab-linkage-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "linkchain-a", name: "Chain Node A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "linkchain-b", name: "Chain Node B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "linkchain-c", name: "Chain Node C", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "linkchain-d", name: "Chain Node D", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "linkchain-e0", sourceId: "linkchain-a", targetId: "linkchain-b", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "linkchain-e1", sourceId: "linkchain-b", targetId: "linkchain-c", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "linkchain-e2", sourceId: "linkchain-c", targetId: "linkchain-d", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC, sceneD;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  async function createScene(locationEntityId) {
    const res = await fetch(`${base}/api/session-planner/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: WORLD, locationEntityId })
    });
    const body = await res.json();
    assert.equal(res.status, 200, `scene setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
    return body.scene;
  }

  // Deliberately scrambled creation order -- see header comment.
  sceneA = await createScene("linkchain-a");
  sceneD = await createScene("linkchain-d");
  sceneB = await createScene("linkchain-b");
  sceneC = await createScene("linkchain-c");

  // Sanity: the real, already-shipped Phase 22 linkage route itself agrees
  // with this fixture's own premise, independent of any UI at all -- if this
  // fails, the bug is in this test's fixture, not in the (not-yet-built) UI
  // under test below.
  const linkageRes = await fetch(`${base}/api/scene-planning/linkage?world=${WORLD}&sceneId=${sceneA.id}`);
  const linkageBody = await linkageRes.json();
  assert.equal(linkageRes.status, 200, `sanity check on the real Phase 22 linkage route failed: ${JSON.stringify(linkageBody)}`);
  assert.deepEqual(
    linkageBody.linked.map((l) => l.sceneId),
    [sceneB.id, sceneC.id, sceneD.id],
    "sanity: the real linkedScenesForScene route must already return b,c,d ascending by hop distance for this fixture -- confirms the fixture itself is sound before testing the UI"
  );

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await page.goto(`${base}/#queue`);
  await page.evaluate((world) => localStorage.setItem("gmReview.world", world), WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("selecting a scene (linked-toggle) surfaces its linked scenes, sorted ascending by hop distance", async () => {
  await page.goto(`${base}/#scenes`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 4, { timeout: 10000 });

  const toggle = page.locator(
    `[data-testid="scene-list-item"][data-scene-id="${sceneA.id}"] [data-testid="scene-list-item-linked-toggle"]`
  );
  await toggle.waitFor({ state: "visible", timeout: 5000 });
  await toggle.click();

  const panel = page.locator(`[data-testid="linked-scenes-panel"][data-scene-id="${sceneA.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 10000 });

  // Selecting scene A must NOT navigate away from the Scenes tab -- this is
  // an inline inspect action, distinct from scene-list-item-open.
  assert.equal(new URL(page.url()).hash, "#scenes", "selecting a scene to inspect its linkage must not navigate away from the Scenes tab");

  const linkedItems = panel.locator('[data-testid="linked-scene-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 3,
      '[data-testid="linked-scenes-panel"] [data-testid="linked-scene-item"]',
      { timeout: 10000 }
    );
  }, "expected exactly 3 linked scenes (b, c, d) for scene A -- scene A itself must never appear in its own linked list");
  assert.equal(await linkedItems.count(), 3);

  const orderedIds = await linkedItems.evaluateAll((els) => els.map((el) => el.getAttribute("data-scene-id")));
  assert.deepEqual(
    orderedIds,
    [sceneB.id, sceneC.id, sceneD.id],
    "linked scenes must render in ASCENDING hop-distance order (b=1, c=2, d=3), matching linkedScenesForScene's own documented sort -- not creation order (which was deliberately scrambled a,d,b,c in this fixture) and not any other order"
  );

  const firstAnchorName = (await linkedItems.nth(0).locator('[data-testid="linked-scene-anchor-name"]').textContent()).trim();
  assert.equal(firstAnchorName, "Chain Node B", "the closest linked scene's anchor entity name must be resolved and shown, not a raw entity id");

  const firstHopText = (await linkedItems.nth(0).locator('[data-testid="linked-scene-hop-distance"]').textContent()).trim();
  assert.match(firstHopText, /1/, "the closest linked scene's rendered hop distance must reflect its real hop count (1)");
  const lastHopText = (await linkedItems.nth(2).locator('[data-testid="linked-scene-hop-distance"]').textContent()).trim();
  assert.match(lastHopText, /3/, "the furthest linked scene in this fixture (scene D) must show hop distance 3");
});

test("clicking a linked-scene result navigates into the existing Session Planner view for THAT linked scene", async () => {
  await page.goto(`${base}/#scenes`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 4, { timeout: 10000 });

  const toggle = page.locator(
    `[data-testid="scene-list-item"][data-scene-id="${sceneA.id}"] [data-testid="scene-list-item-linked-toggle"]`
  );
  await toggle.waitFor({ state: "visible", timeout: 5000 });
  await toggle.click();

  const panel = page.locator(`[data-testid="linked-scenes-panel"][data-scene-id="${sceneA.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 10000 });

  // Click the middle linked result (scene C) specifically -- proves the
  // navigation targets the CLICKED row's own scene id, not e.g. always the
  // first result or the originally-selected scene A.
  const sceneCResult = panel.locator(`[data-testid="linked-scene-item"][data-scene-id="${sceneC.id}"] [data-testid="linked-scene-open"]`);
  await sceneCResult.waitFor({ state: "visible", timeout: 5000 });
  await sceneCResult.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}`,
      sceneC.id,
      { timeout: 5000 }
    );
  }, "clicking a linked-scene result must route to #session-planner/<thatLinkedSceneId>");

  await page.locator("#view-session-planner.active").waitFor({ state: "attached", timeout: 5000 });
  const anchorCard = page.locator('[data-testid="location-card"][data-card-role="anchor"]');
  await anchorCard.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(
    await anchorCard.getAttribute("data-entity-id"),
    "linkchain-c",
    "must land on scene C specifically (the clicked linked result), not scene A (the originally-selected scene) or any other scene"
  );
});
