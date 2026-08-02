// Phase 24 task 24.0 -- proactive e2e test, written BEFORE the Scenes tab UI
// exists, per this project's own "tests before implementation" discipline
// (same as every phase since 16.0 -- see session-planner-flush-on-navigate
// .e2e.mjs / session-planner-recenter-race.e2e.mjs for the identically-shaped
// precedent). EXPECTED TO FAIL right now with a Playwright "waiting for
// selector" / timeout error, since none of the DOM below exists yet (no
// `data-nav="scenes"` button, no #view-scenes section, no scenes-view.js) --
// that failure is the deliverable of this task, not a bug in this file.
//
// Phase 24 depends ONLY on the already-shipped Phase 22 (Scene Engine) --
// plans/phase-21-review.md §12's phasing decision explicitly calls Phase 24
// a SIBLING consumer of Phase 22's engine, not a downstream consumer of
// Phase 23 (scene-construction UI, planned separately). Nothing in this file
// or its sibling (scenes-tab-linkage.e2e.mjs) touches, imports, or assumes
// any Phase-23-only construction affordance (add/remove node, develop-scene,
// scene-local undo, etc.) -- only session-planner/scenes.mjs's
// listScenesForWorld/createScene (already shipped, Phase 16) and
// session-planner/scene-linkage.mjs's linkedScenesForScene (already shipped,
// Phase 22 task 22.1), consumed via the real, already-live
// `GET /api/scene-planning/linkage` route (Phase 22 task 22.7) and the real,
// already-live `POST /api/session-planner/scenes` route (Phase 16).
//
// ---------------------------------------------------------------------------
// DOM CONTRACT this test (and its sibling, scenes-tab-linkage.e2e.mjs) pins
// for Phase 24's implementation:
// ---------------------------------------------------------------------------
//
// NAV ENTRY:
//   - `.topnav [data-nav="scenes"][data-testid="scenes-nav"]` -- a new
//     top-nav button, sibling of the existing `data-nav="session-planner"`
//     ("Plan Session") and `data-nav="combat-planning"` ("Encounter
//     Builder") buttons in review-ui/public/index.html's `<nav
//     class="topnav">`, following those two buttons' EXACT
//     `data-nav`+`data-testid` pairing convention. Clicking it navigates
//     (app.js's existing `[data-nav]` click handler, unmodified) to the bare
//     `#scenes` hash route.
//   - `<section id="view-scenes" class="view">` -- the new view container,
//     sibling of `#view-session-planner`/`#view-combat-planning`, toggled
//     active by app.js's existing `renderCurrentView()` section-class-toggle
//     loop (unmodified) whenever `parseHash().view === "scenes"`.
//   - app.js's `renderCurrentView()` dispatch gains one new arm:
//     `else if (view === "scenes") renderScenesTab();`, sibling of the
//     existing `session-planner`/`combat-planning` arms -- imported from a
//     NEW standalone `review-ui/public/scenes-view.js`, mirroring
//     session-planner-view.js/combat-planning-view.js's own established
//     "deliberately standalone, zero imports from app.js, reads
//     `gmReview.world` from localStorage directly" convention (see either
//     file's own header comment) -- not re-litigated here, just followed.
//   - This is a WORLD-SCOPED BROWSE view, not a per-scene one (unlike
//     `#session-planner/<sceneId>`) -- the hash route takes no argument,
//     always `#scenes` bare, matching the browse/search intent (design
//     record plans/phase-21-review.md §2: "search/browse every previously-
//     prepared scene across the whole campaign").
//
// BROWSE LIST (`listScenesForWorld`-backed):
//   - `[data-testid="scenes-list"]` -- the list container.
//   - `[data-testid="scene-list-item"][data-scene-id="<id>"]` -- one per
//     scene in the current world. Each contains, at minimum:
//       - `[data-testid="scene-list-item-anchor-name"]` -- the scene's
//         anchor entity's NAME (never the raw entityId), resolved via the
//         same `GET /api/graph` entity-name lookup session-planner-view.js's
//         own `fetchEntityInfoMap()` already establishes as this project's
//         standard "scene -> anchor entity name" join (no new lookup
//         mechanism expected). A scene with `locationEntityId: null`
//         (untethered -- theoretically possible per scenes.mjs's own schema,
//         though this test's fixtures don't exercise it) is out of scope for
//         this file; not asserted either way here.
//       - `[data-testid="scene-list-item-objective"]` -- the scene's
//         `objectiveNote`, always rendered (present in the DOM even when the
//         note is null/absent -- this project's own "never blank space,
//         render an explicit empty state" discipline, e.g.
//         session-planner-view.js's `location-card-digest--empty`
//         precedent) rather than the element being conditionally omitted.
//       - `[data-testid="scene-list-item-open"]` -- the PRIMARY fast-re-
//         entry affordance (design record: "the actual point of the whole
//         tab... fast re-entry into any previously-prepared thread").
//         Clicking it navigates (via the hash router, same convention as
//         session-planner-view.js's `renderBootstrap`'s
//         `location.hash = ...` real-navigation precedent -- not a
//         history.replaceState side-navigation) to
//         `#session-planner/<sceneId>`, landing in the EXISTING Session
//         Planner view.
//
// SEARCH/FILTER INPUT:
//   - `[data-testid="scenes-search-input"]` -- a single always-visible text
//     input, narrowing the visible `scene-list-item` set by the anchor
//     entity's NAME (substring, case-insensitive), client-side over an
//     already-loaded list -- no new network round trip per keystroke.
//   - REUSE DECISION (documented per this task's own instruction to record
//     the reasoning either way): this file does NOT require reuse of
//     session-planner-view.js's `buildEntityPicker` component. That
//     component's entire contract is built around picking ONE graph ENTITY
//     from `GET /api/graph` (id/name/type triples, `onSelect(entity, btn)`
//     firing entity-shaped downstream calls like scene-fork/scene-bootstrap)
//     -- it has no concept of a SCENE at all, and two different scenes can
//     legitimately share the same anchor entity (e.g. a fork lineage, or two
//     independently-planned visits to the same place), which would collide
//     with buildEntityPicker's implicit one-row-per-entity-id shape. The
//     genuinely-shared, worth-reusing PATTERN (one list fetched once, every
//     keystroke re-filters the already-in-memory array, zero further
//     network calls) is exactly what this input follows -- just over a
//     scenes array, not buildEntityPicker's own entities array or DOM
//     structure. Implementers are free to factor a shared "client-side
//     substring filter over an in-memory list" helper out of the two
//     call sites later if that turns out clean; this test asserts the
//     BEHAVIOR (filtering works), not which internal helper produces it.
//
// EMPTY STATE:
//   - `[data-testid="scenes-empty-state"]` -- rendered instead of
//     `scenes-list` when `listScenesForWorld(world)` is `[]`. Carries a
//     real, non-blank message (not asserted verbatim by this file, just
//     required to exist and be visible).
//
// (The "selecting a scene surfaces its linked scenes, sorted by hop
// distance" contract, and the "clicking a linked-scene result also
// navigates to Session Planner" contract, are this file's sibling's
// responsibility: scenes-tab-linkage.e2e.mjs. Both files are read together
// as ONE DOM contract for implementers -- see that file's header for the
// `scene-list-item-linked-toggle` / `linked-scenes-panel` /
// `linked-scene-item` / `linked-scene-open` pieces this file does not
// exercise.)
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions: mirrors session-planner-resume-persistence
// .e2e.mjs exactly -- setupScratchEnv, a real in-process createReviewServer
// ({port:0}), real fixture seeding via the actual store/API functions (never
// hand-constructed scene/entity JSON): entities via
// graph-import/headless-apply.mjs's bootstrapSnapshot+applyHeadless (this
// project's own established "real snapshot, not a mock" convention), scenes
// via the real, already-live `POST /api/session-planner/scenes` route (Phase
// 16) -- not session-planner/scenes.mjs's createScene() called directly,
// specifically BECAUSE this file wants to prove the exact same server-side
// path a real browser session would use end to end.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-scenes-tab-");
const WORLD = "e2e-scenes-tab-world";
const EMPTY_WORLD = "e2e-scenes-tab-empty-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

// --- WORLD: three scenes anchored to three distinctly-named places. ---
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "scenes-tab-riverside", name: "Riverside Market", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "scenes-tab-ashenkeep", name: "Ashen Keep", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "scenes-tab-willowbrook", name: "Willowbrook Grove", type: "place", importance: 0.5 } }
]);

// --- EMPTY_WORLD: bootstrapped, but genuinely zero scenes ever created. ---
const emptySnapPath = snapshotFilePath(dataDir, EMPTY_WORLD);
bootstrapSnapshot(emptySnapPath, { worldId: EMPTY_WORLD });

let server, base, browser, page;
let sceneRiverside, sceneAshenKeep, sceneWillowbrook;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  async function createScene(world, locationEntityId, objectiveNote) {
    const res = await fetch(`${base}/api/session-planner/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world, locationEntityId, objectiveNote })
    });
    const body = await res.json();
    assert.equal(res.status, 200, `scene setup itself must succeed -- broken test setup, not the thing under test (got ${res.status}: ${JSON.stringify(body)})`);
    return body.scene;
  }

  sceneRiverside = await createScene(WORLD, "scenes-tab-riverside", "Investigate the missing caravan");
  sceneAshenKeep = await createScene(WORLD, "scenes-tab-ashenkeep", null);
  sceneWillowbrook = await createScene(WORLD, "scenes-tab-willowbrook", "Meet the druid circle");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });

  // world selection is read from localStorage's "gmReview.world" key (both
  // app.js and every standalone view's own header comment document this) --
  // set it up front via a real page load, matching every sibling e2e file's
  // own established setup convention.
  await page.goto(`${base}/#queue`);
  await page.evaluate((world) => localStorage.setItem("gmReview.world", world), WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("a new Scenes nav entry exists and navigates to a dedicated #scenes view, separate from Plan Session", async () => {
  await page.goto(`${base}/#queue`);

  const scenesNav = page.locator('.topnav [data-nav="scenes"][data-testid="scenes-nav"]');
  await scenesNav.waitFor({ state: "visible", timeout: 10000 });
  await scenesNav.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#scenes", { timeout: 5000 });
  }, "clicking the Scenes nav button must route to the bare #scenes hash");

  await page.locator("#view-scenes.active").waitFor({ state: "attached", timeout: 5000 });

  // Genuinely a DIFFERENT view from Session Planner -- not just an alias.
  const sessionPlannerSection = page.locator("#view-session-planner");
  assert.equal(
    await sessionPlannerSection.evaluate((el) => el.classList.contains("active")),
    false,
    "#view-session-planner must not also be active while on the Scenes tab -- these are two separate views"
  );
});

test("the browse list shows every scene in the world, each with its anchor entity's name and objective note", async () => {
  await page.goto(`${base}/#scenes`);

  const list = page.locator('[data-testid="scenes-list"]');
  await list.waitFor({ state: "visible", timeout: 10000 });

  const items = page.locator('[data-testid="scene-list-item"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 3, { timeout: 10000 });
  }, "expected exactly the 3 seeded scenes to render as list items");
  assert.equal(await items.count(), 3);

  const riversideItem = page.locator(`[data-testid="scene-list-item"][data-scene-id="${sceneRiverside.id}"]`);
  await riversideItem.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    (await riversideItem.locator('[data-testid="scene-list-item-anchor-name"]').textContent()).trim(),
    "Riverside Market",
    "must show the anchor ENTITY's real name (resolved from the graph), not the raw locationEntityId"
  );
  assert.match(
    (await riversideItem.locator('[data-testid="scene-list-item-objective"]').textContent()).trim(),
    /Investigate the missing caravan/
  );

  // A scene created with objectiveNote: null must still render the testid
  // element (never silently omitted) -- this project's "never blank space"
  // discipline, per session-planner-view.js's location-card-digest--empty
  // precedent cited in this file's header.
  const ashenKeepItem = page.locator(`[data-testid="scene-list-item"][data-scene-id="${sceneAshenKeep.id}"]`);
  await ashenKeepItem.waitFor({ state: "visible", timeout: 5000 });
  const objectiveCount = await ashenKeepItem.locator('[data-testid="scene-list-item-objective"]').count();
  assert.equal(objectiveCount, 1, "the objective-note element must be present even when the note itself is null");
});

test("the search input narrows the visible list by anchor entity name, client-side", async () => {
  await page.goto(`${base}/#scenes`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 3, { timeout: 10000 });

  const search = page.locator('[data-testid="scenes-search-input"]');
  await search.waitFor({ state: "visible", timeout: 5000 });
  await search.fill("Ashen");

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 1, { timeout: 5000 });
  }, "typing a query matching exactly one scene's anchor name must narrow the list to exactly that one item");

  const remaining = page.locator('[data-testid="scene-list-item"]');
  assert.equal(await remaining.getAttribute("data-scene-id"), sceneAshenKeep.id);

  // Clearing the query restores the full list -- proves this is a live
  // client-side filter over an already-loaded set, not a one-shot narrowing
  // network call with no way back without a reload.
  await search.fill("");
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 3, { timeout: 5000 });
  }, "clearing the search input must restore every scene to the visible list");
});

test("clicking a scene in the main list navigates into the EXISTING Session Planner view for that exact scene", async () => {
  await page.goto(`${base}/#scenes`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-list-item"]').length === 3, { timeout: 10000 });

  const willowbrookOpen = page.locator(
    `[data-testid="scene-list-item"][data-scene-id="${sceneWillowbrook.id}"] [data-testid="scene-list-item-open"]`
  );
  await willowbrookOpen.waitFor({ state: "visible", timeout: 5000 });
  await willowbrookOpen.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}`,
      sceneWillowbrook.id,
      { timeout: 5000 }
    );
  }, "clicking a scene's open control must route to #session-planner/<thatSceneId>");

  await page.locator("#view-session-planner.active").waitFor({ state: "attached", timeout: 5000 });
  const anchorCard = page.locator('[data-testid="location-card"][data-card-role="anchor"]');
  await anchorCard.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(
    await anchorCard.getAttribute("data-entity-id"),
    "scenes-tab-willowbrook",
    "the Session Planner view that loads must be the SAME scene clicked from the Scenes tab, not some other/default scene"
  );
});

test("empty state: a world with zero scenes shows an explicit empty-state, not a blank/broken list", async () => {
  await page.goto(`${base}/#queue`);
  await page.evaluate((world) => localStorage.setItem("gmReview.world", world), EMPTY_WORLD);
  await page.goto(`${base}/#scenes`);

  const emptyState = page.locator('[data-testid="scenes-empty-state"]');
  await emptyState.waitFor({ state: "visible", timeout: 10000 });
  assert.notEqual((await emptyState.textContent()).trim(), "", "the empty state must carry a real, non-blank message");

  const items = page.locator('[data-testid="scene-list-item"]');
  assert.equal(await items.count(), 0, "no scene-list-item elements should render for a world with zero scenes");

  // Restore world selection for any test file execution ordering assumptions
  // elsewhere in this process (defensive; each e2e file also gets its own
  // fresh browser context in this project's actual npm run test:e2e
  // invocation, so this is belt-and-suspenders only).
  await page.evaluate((world) => localStorage.setItem("gmReview.world", world), WORLD);
});
