// Phase 17 task 17.0 -- proactive e2e test, written BEFORE the Session
// Planner UI exists (tasks 17.1-17.5), per plans/phase-17-review.md §11
// item 2 and plans/phase-17-tasks.md task 17.0's second required scenario.
// Direct sibling of the already-fixed Phase 14.8 duplicate-batch-from-
// uncancelled-scan bug (review-ui/public/app.js's `activeScanController`/
// `cancelActiveScan()`) -- same fetch-then-mutate-then-refetch shape, one
// level up (fork a scene, then refetch its brief) instead of scan-then-
// create-batch. EXPECTED TO FAIL right now with a Playwright "waiting for
// selector" / timeout error, since none of the DOM below exists yet -- that
// failure is the deliverable, same as its sibling file.
//
// ---------------------------------------------------------------------------
// DOM CONTRACT this test relies on (mirrors
// session-planner-flush-on-navigate.e2e.mjs's header verbatim for the
// shared routing/brief-render pieces, so the two files never silently
// disagree; this file's own new pieces are the RE-CENTER control, task
// 17.5):
// ---------------------------------------------------------------------------
//
// ROUTING (task 17.1) -- same as the sibling file:
//   - `#session-planner/<sceneId>` hash route, `renderSessionPlanner(arg)`.
//   - `<section id="view-session-planner" class="view">` container.
//
// BRIEF RENDER (task 17.2):
//   - `[data-testid="location-card"][data-entity-id="<id>"][data-card-role="anchor"|"satellite"]`
//     -- plans/phase-17-review.md §3: the scene's own path location(s)
//     (`brief.locations[].distance === 0`) get `data-card-role="anchor"`;
//     everything else gets `"satellite"`. Since every scene in this test is
//     single-location (no multi-stop route), there is always EXACTLY ONE
//     `data-card-role="anchor"` card at a time -- this test's final
//     assertion reads that one card's `data-entity-id` to determine which
//     location the CURRENTLY rendered brief is centered on.
//
// RE-CENTER CONTROL (task 17.5, plans/phase-17-review.md §9) -- the actual
// subject of this test:
//   - `[data-testid="recenter-input"]` -- a single always-visible text
//     input (type-ahead/search-as-you-select per §9, explicitly NOT a plain
//     `<select>`, and explicitly NOT gated behind a separate reveal button
//     the way task 13.3's rarer "Link to existing instead" control is --
//     re-centering is a core, frequent action). Typing filters a
//     CLIENT-SIDE-cached full entity list (reusing the exact pattern
//     app.js's existing `buildLinkToExistingControl` already established:
//     ONE `GET /api/graph?filter=all` fetched once when the control first
//     mounts, then every keystroke re-filters that already-in-memory list
//     with zero additional network round trips) -- this is why typing a
//     SECOND, different query immediately after selecting a first result
//     produces a fresh, fully-populated, fully-enabled results list with no
//     network delay of its own; only the fork+refetch triggered BY
//     selecting a result is network-bound, and this test controls that
//     specific timing via Playwright route interception (see below).
//   - `[data-testid="recenter-results"]` -- the filtered `<ul>` of matches,
//     re-rendered on every `input` event.
//   - `[data-testid="recenter-option"][data-entity-id="<id>"]` -- one
//     `<button>` per matched entity. Clicking one is the entire
//     "select-as-action" gesture (no separate submit button, matching "type-
//     ahead/search-as-you-select" verbatim) and, per task 17.5's spec:
//       1. Replaces the shared `activeRecenterController` slot (mirroring
//          `activeScanController`'s EXACT single-slot pattern) with a fresh
//          `AbortController`, calling `cancelActiveRecenter()` first --
//          which `.abort()`s any still-in-flight PREVIOUS recenter
//          sequence's controller.
//       2. Disables (defense-in-depth, in ADDITION to the abort-slot guard,
//          never instead of it) the specific `recenter-option` button just
//          clicked -- but NOT the `recenter-input`, and NOT sibling
//          `recenter-option` buttons from a since-superseded results list,
//          both of which stay live so a DM correcting a fat-fingered pick
//          can immediately search+select a different location without
//          waiting -- this is deliberately what makes the race in this
//          test possible to drive via genuine, realistic user actions
//          rather than a synthetic bypass of the UI.
//       3. Calls `POST /api/session-planner/scenes/:currentSceneId/fork
//          {world, locationEntityId}` (session-planner/scenes.mjs's
//          forkScene, already shipped in Phase 16) with `signal:
//          controller.signal`, THEN (same generation's controller, same
//          signal, sequential awaits in ONE async function so a single
//          `.abort()` call cancels whichever step hasn't resolved yet)
//          `GET /api/session-planner/brief?...sceneId=<newSceneId>`, THEN
//          replaces the 17.2 container render with the new brief and
//          updates the "current scene" the view is tracking. An
//          `AbortError` from either fetch is caught and silently swallowed
//          (matching `handleScanMentionsFromPopover`'s exact
//          `err.name === "AbortError"` convention) -- an aborted recenter
//          sequence must never render, never throw, and never leave the
//          view showing a stale intermediate state.
//   - `[data-testid="recenter-status"]` -- small inline indicator (e.g.
//     "Recentering…") while a recenter sequence is in flight. Not asserted
//     directly by this test, documented for implementers.
//   - Extending app.js's existing `hashchange`/`renderCurrentView()`
//     cancellation step: a parallel `cancelActiveRecenter()` call alongside
//     the existing `cancelActiveScan()` call in `renderCurrentView()` --
//     NOT exercised by this test (which never navigates away mid-recenter),
//     but part of the same contract task 17.5 must implement; noted here so
//     17.5's own implementation doesn't have to re-derive it from a second
//     source.
//
// ---------------------------------------------------------------------------
// WHY THIS TEST NEEDS ROUTE INTERCEPTION (per task 17.0's own instruction:
// "use Playwright's route interception to delay the first fork/brief
// request deterministically" -- none of this project's existing
// review-ui/test/e2e/*.e2e.mjs files intercept routes; this is new):
// ---------------------------------------------------------------------------
// On a fast local in-process server, two real clicks issued back-to-back
// from a test would very likely have the FIRST fork request complete before
// the SECOND one is even issued -- which would make the "final state
// reflects the second click" assertion trivially true even with NO
// abort-guard at all (the second request would just naturally be the only
// one in flight by the time it's sent), and would never actually exercise
// -- or regress-test -- the abort-slot mechanism itself. To make the race
// REAL and deterministic rather than hoping timing works out, this test
// intercepts (`page.route`) only the FIRST `POST .../scenes/:id/fork`
// request and holds it in flight for a fixed delay before letting it
// proceed -- long enough that the second click's OWN fork request (left
// unintercepted-delay) is issued and can complete first. If task 17.5's
// abort-slot guard is implemented correctly, the held-back first request's
// `route.continue()` call (attempted after the artificial delay) will throw
// because the page's own `fetch()` for it was already aborted client-side
// -- caught and treated as the SUCCESS signal, not a test-infra failure. If
// the guard is missing or broken, `route.continue()` succeeds, the first
// request reaches the real server, and a SECOND scene fork gets created --
// which this test's "exactly one new fork" assertion below then correctly
// fails on.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-sp-recenter-");
const WORLD = "e2e-sp-recenter-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { listScenesForWorld } = await import("../../../session-planner/scenes.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sp-recenter-home", name: "Recenter Test Home Base", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sp-recenter-alpha", name: "Recenter Alpha Cave", type: "place", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "sp-recenter-beta", name: "Recenter Beta Ruins", type: "place", importance: 0.4 } }
]);

// How long the FIRST fork request is held in flight before we let it
// proceed -- comfortably longer than a real second click + its own
// (unintercepted-delay) fork+refetch round trip against a fast local
// in-process server should ever take, so the race is deterministic rather
// than a coin flip on CI/local timing.
const FIRST_REQUEST_DELAY_MS = 700;
// Extra buffer AFTER the delayed first request's fate is settled, to let
// any trailing follow-up request it might have triggered (e.g. a brief GET
// chained after a fork POST that a buggy implementation didn't actually
// guard) fully resolve before this test reads final state.
const SETTLE_BUFFER_MS = 300;

let server, base, browser, page, sceneId, baselineSceneCount;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  const sceneRes = await fetch(`${base}/api/session-planner/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, locationEntityId: "sp-recenter-home" })
  });
  const sceneBody = await sceneRes.json();
  assert.equal(sceneRes.status, 200, "scene setup itself must succeed -- broken test setup, not the thing under test");
  sceneId = sceneBody.scene.id;
  baselineSceneCount = listScenesForWorld(WORLD).length;
  assert.equal(baselineSceneCount, 1, "sanity: exactly the one root scene created above, before any recenter happens");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("selecting a second re-center location before the first's fork+refetch settles: exactly one new fork, final brief reflects the SECOND location", async () => {
  let firstForkRequestSeen = false;
  let resolveFirstForkHandled;
  const firstForkHandled = new Promise((resolve) => { resolveFirstForkHandled = resolve; });

  await page.route("**/api/session-planner/scenes/*/fork", async (route) => {
    if (!firstForkRequestSeen) {
      firstForkRequestSeen = true;
      await new Promise((resolve) => setTimeout(resolve, FIRST_REQUEST_DELAY_MS));
      try {
        await route.continue();
      } catch {
        // Expected in the PASSING case: the app's own AbortController
        // already canceled this in-flight request (its `signal` was wired
        // into fetch()) by the time we tried to let it through here.
        // route.continue() throws once the underlying request is gone --
        // that's the success signal for the abort-slot guard, not test
        // infra breaking.
      } finally {
        resolveFirstForkHandled();
      }
    } else {
      await route.continue();
    }
  });

  await page.goto(`${base}/#session-planner/${sceneId}`);

  const anchorCard = page.locator('[data-testid="location-card"][data-card-role="anchor"]');
  await anchorCard.waitFor({ state: "visible", timeout: 15000 });
  await assert.doesNotReject(
    async () => assert.equal(await anchorCard.getAttribute("data-entity-id"), "sp-recenter-home"),
    "sanity: initial brief is centered on the scene's real starting location"
  );

  const recenterInput = page.locator('[data-testid="recenter-input"]');
  await recenterInput.waitFor({ state: "visible", timeout: 5000 });

  // --- First click: select "Alpha" (this fork request will be held by the
  // route interception above). ---
  await recenterInput.fill("Alpha");
  const alphaOption = page.locator('[data-testid="recenter-option"][data-entity-id="sp-recenter-alpha"]');
  await alphaOption.waitFor({ state: "visible", timeout: 5000 });
  await alphaOption.click();

  // --- Immediately, WITHOUT waiting for Alpha's fork to settle: select a
  // DIFFERENT location, "Beta". Per the DOM contract above, `recenter-input`
  // and any NEW results list stay fully live during another selection's
  // in-flight fetch, so this is a genuine, realistic fast-double-action
  // (typing a correction + picking again), not a synthetic bypass. ---
  await recenterInput.fill("Beta");
  const betaOption = page.locator('[data-testid="recenter-option"][data-entity-id="sp-recenter-beta"]');
  await betaOption.waitFor({ state: "visible", timeout: 5000 });
  await betaOption.click();

  // Wait for the deliberately-delayed first (Alpha) request to be fully
  // resolved one way or the other, then a small settle buffer for any
  // trailing effects, before reading final state.
  await firstForkHandled;
  await new Promise((resolve) => setTimeout(resolve, SETTLE_BUFFER_MS));

  // Beta's own (undelayed) fork+refetch should be long since complete by
  // now (well under FIRST_REQUEST_DELAY_MS on a local server) -- confirm
  // the view has actually re-rendered around it before asserting.
  await assert.doesNotReject(async () => {
    await page.locator('[data-testid="location-card"][data-card-role="anchor"][data-entity-id="sp-recenter-beta"]')
      .waitFor({ state: "visible", timeout: 5000 });
  }, "the final rendered brief must be centered on Beta (the SECOND, later selection), not stuck on or reverted to Alpha");

  const finalAnchorId = await page.locator('[data-testid="location-card"][data-card-role="anchor"]').getAttribute("data-entity-id");
  assert.equal(
    finalAnchorId,
    "sp-recenter-beta",
    "the final rendered brief must reflect the SECOND click's target location -- a stale, slower first response must never win the race and overwrite it"
  );

  // Exactly ONE new scene fork must exist for this whole recenter sequence
  // -- not two (one for Alpha that should have been aborted before it ever
  // reached the server, one for Beta).
  const scenesAfter = listScenesForWorld(WORLD);
  assert.equal(
    scenesAfter.length,
    baselineSceneCount + 1,
    `expected exactly one new scene fork from this recenter sequence (root + 1); got ${scenesAfter.length} total scenes: ${JSON.stringify(scenesAfter)}`
  );
  const newScene = scenesAfter.find((s) => s.parentSceneId === sceneId);
  assert.ok(newScene, "the one new scene must be a fork of the original root scene");
  assert.equal(
    newScene.locationEntityId,
    "sp-recenter-beta",
    "the one real fork that was created must be Beta's, not Alpha's -- confirms Alpha's request was genuinely aborted client-side before ever creating a scene, not merely out-raced in rendering"
  );
});
