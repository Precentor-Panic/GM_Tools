// Phase 17 task 17.0 -- proactive e2e test, written BEFORE the Session
// Planner UI exists (tasks 17.1-17.5), per plans/phase-17-review.md §11
// item 1 and plans/phase-17-tasks.md task 17.0's first required scenario.
// Direct sibling of Phase 15.3's mobile-drawer-close-on-hashchange fix
// (review-ui/public/app.js's `window.addEventListener("hashchange", ...)`
// block) -- this test is EXPECTED TO FAIL right now with a Playwright
// "waiting for selector" / timeout error, since none of the DOM below
// exists yet. That failure is the deliverable: it proves the test is real
// and wired to run, and the selectors below ARE the implementation contract
// tasks 17.1-17.3 must build to match, not re-derive independently.
//
// ---------------------------------------------------------------------------
// DOM CONTRACT this test relies on (full session-planner selector contract;
// mirrored verbatim in session-planner-recenter-race.e2e.mjs's header so the
// two files never silently disagree about a shared selector):
// ---------------------------------------------------------------------------
//
// ROUTING (task 17.1):
//   - New hash route `#session-planner/<sceneId>`, matching this app's
//     existing `#review/<batchId>` view/arg convention exactly
//     (parseHash()/navigate() in app.js already split on "/" generically --
//     this route needs no changes to that mechanism, only a new
//     `else if (view === "session-planner") renderSessionPlanner(arg);`
//     branch in renderCurrentView()'s dispatch chain).
//   - Nav button in .topnav: `<button data-nav="session-planner"
//     data-testid="session-planner-nav">...</button>`, same list as
//     Queue/New Import/Deferred Debt/Graph in index.html.
//   - View container: `<section id="view-session-planner" class="view">`,
//     same `.view`/`#view-${view}` active-toggle convention every other
//     view already uses.
//   - This test navigates DIRECTLY to `#session-planner/<sceneId>` (a scene
//     created via a real API call in setup below, matching this project's
//     "seed via the real API, don't hand-construct fixture JSON" test
//     convention) rather than driving 17.1's empty-state bootstrap flow --
//     that flow has its own acceptance criteria under task 17.1 and isn't
//     this test's concern. The `<sceneId>` hash-arg deep-link IS part of
//     the routing contract this test specifies, though.
//
// BRIEF RENDER (task 17.2):
//   - `[data-testid="location-card"][data-entity-id="<entityId>"]` -- one
//     per `brief.locations[]` entry (session-planner/brief.mjs's real
//     shipped output shape, plans/phase-17-review.md §2).
//
// NOTES / INLINE-EXPAND AUTOSAVE (task 17.3, plans/phase-17-review.md §5-6)
// -- the actual subject of this test:
//   - `[data-testid="location-note-toggle"]` -- one small icon-affordance
//     PER location card (scoped inside that card's own
//     `[data-testid="location-card"][data-entity-id=...]`), NEVER the
//     entity's name/digest text itself (§5's explicit anti-accidental-edit
//     requirement). Clicking it toggles open/closed an inline panel
//     beneath that row -- no popover, no positioning/clamping code, per
//     §5's corrected design.
//   - `[data-testid="location-note-panel"]` -- the inline-expand region
//     itself, appended/removed from that card on toggle.
//   - `[data-testid="location-note-entry"]` -- ZERO OR MORE, one per
//     already-captured SessionNote for that entity (session-planner/
//     session-notes.mjs's real `{id, text, timestamp, consumed}` shape),
//     rendered read-only inside the panel. THIS test's persistence check
//     re-opens the panel after a fresh page load and asserts a
//     `location-note-entry` containing the typed text exists.
//   - `[data-testid="location-note-textarea"]` -- ONE per panel, the
//     zero-ceremony single-field composer for a NEW note (design record §6:
//     "one text field, autosave on blur"). Wired to the
//     `createFlushableDebounce` helper specified in
//     test/session-planner/debounced-save.test.mjs
//     (review-ui/public/debounced-save.mjs, task 17.3):
//       - `input` on this textarea -> `debounce.onInput(textarea.value)`
//         (~500ms debounce, per plans/phase-17-review.md §6, comfortably
//         under graph-view.js's existing withSlowNotice ~1.5s threshold so
//         the two never perceptually compete).
//       - `blur` on this textarea -> `debounce.onBlur(textarea.value)`
//         (immediate, no extra debounce).
//       - GUARANTEED FLUSH ON HASHCHANGE -- the actual behavior under test
//         here: app.js's existing `window.addEventListener("hashchange",
//         ...)` block (which already calls `cancelActiveScan()`) gains a
//         parallel, unconditional call to a module-level
//         `flushActiveNoteSave()` function (session-planner-view.js, task
//         17.3) that calls `.flush()` on whichever `createFlushableDebounce`
//         instance is currently the "active" one (a single shared slot per
//         design record §6's cross-entity-misattribution requirement,
//         mirroring `activeScanController`'s exact single-slot convention)
//         -- a safe no-op if no note editor is open, per
//         debounced-save.test.mjs's own "flush() with nothing pending"
//         contract. Each flush results in a real
//         `POST /api/session-planner/notes {world, text, anchorEntityId,
//         sceneId}` (session-planner/session-notes.mjs's captureNote,
//         already shipped in Phase 16 -- task 17.3 wires the call, doesn't
//         build new server logic). Save success updates
//         `[data-testid="location-note-status"]`'s text (e.g. "Saved") --
//         NOT asserted directly by this test, but per plans/phase-17-review.md
//         §10 this save-success handler must NEVER call the 17.2
//         container-level rebuild function (a future test's concern, noted
//         here for implementers, not re-tested here).
//
// The critical design point this test is built to prove, spelled out
// (design record §6): "an in-progress, not-yet-saved note must never be
// silently lost just because the DM navigated away via the hash-router
// before the debounce timer fired." This test types a note, navigates via
// the hash router within milliseconds (well under the ~500ms debounce
// window), and confirms the text survived -- verified TWO independent ways
// per task 17.0's own instruction not to rely on "a network request was
// observed": (1) the real `POST /api/session-planner/notes` response
// actually completing (page.waitForResponse, asserting status 200), (2) the
// underlying session-planner/session-notes.mjs store, read DIRECTLY (not
// via HTTP) from this test's own Node process against the SAME
// GM_TOOLS_SESSION_NOTES_DIR the running server uses, and (3) a completely
// fresh page load re-rendering the note from that same durable store.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-sp-flush-");
const WORLD = "e2e-sp-flush-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { listPendingNotes } = await import("../../../session-planner/session-notes.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sp-flush-home", name: "Flush Test Home Base", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sp-flush-neighbor", name: "Flush Test Neighbor", type: "person", importance: 0.4 } },
  { op: "upsert_edge", data: { sourceId: "sp-flush-home", targetId: "sp-flush-neighbor", relationshipType: "presence" } }
]);

const NOTE_TEXT = "The neighbor mentioned strange lights over the old mill last night.";

let server, base, browser, page, sceneId;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  // Seed the scene via the REAL API (server.mjs's already-shipped Phase 16
  // route), not by hand-constructing a scene JSON file -- matches this
  // project's established e2e/route-test convention.
  const sceneRes = await fetch(`${base}/api/session-planner/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, locationEntityId: "sp-flush-home" })
  });
  const sceneBody = await sceneRes.json();
  assert.equal(sceneRes.status, 200, "scene setup itself must succeed -- a failure here would be broken test setup, not the thing under test");
  sceneId = sceneBody.scene.id;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("typing a note then navigating away before the debounce fires still durably saves the note (guaranteed flush on hashchange)", async () => {
  await page.goto(`${base}/#session-planner/${sceneId}`);

  const neighborCard = page.locator('[data-testid="location-card"][data-entity-id="sp-flush-neighbor"]');
  await neighborCard.waitFor({ state: "visible", timeout: 15000 });

  await neighborCard.locator('[data-testid="location-note-toggle"]').click();
  const textarea = neighborCard.locator('[data-testid="location-note-textarea"]');
  await textarea.waitFor({ state: "visible", timeout: 5000 });

  // Set up the wait BEFORE triggering the actions that produce it, so we
  // can't miss a response that resolves faster than we'd otherwise notice.
  const savePromise = page.waitForResponse(
    (res) => res.url().includes("/api/session-planner/notes") && res.request().method() === "POST",
    { timeout: 5000 }
  );

  // .fill() dispatches a single real `input` event with the final value --
  // deterministic and fast, so the subsequent nav click reliably lands well
  // under the ~500ms debounce window (no reliance on exact timer-tuning
  // constants staying in sync between this test and the implementation).
  await textarea.fill(NOTE_TEXT);

  // Trigger a hash navigation via a DIFFERENT nav item, exactly the way a
  // DM would actually navigate away mid-note -- immediately, no waiting for
  // the debounce window.
  //
  // IMPLEMENTATION NOTE (flagged per this project's own instruction to flag
  // rather than silently patch a test that looks wrong once deep in real
  // implementation): a bare `[data-nav="queue"]` selector is genuinely
  // ambiguous against this app's REAL, PRE-EXISTING DOM (unrelated to
  // anything Phase 17 added) -- index.html has THREE elements carrying
  // data-nav="queue" at all times regardless of which view is active: the
  // ".brand" logo button, the actual topnav "Queue" button, and the Review
  // view's own "<- Back to Queue" link (present in the DOM, just hidden,
  // whenever #view-review isn't the active section). Playwright's strict
  // mode correctly refuses to guess between them. Scoped to `.topnav` here
  // to unambiguously target the real topnav Queue button the comment above
  // actually describes -- not a loosened assertion, every assertion below
  // this line is unchanged.
  await page.locator('.topnav [data-nav="queue"]').click();

  // (1) The guaranteed-flush POST must have actually fired and succeeded --
  // not just "a request was observed" but a real 200 response.
  const saveResponse = await savePromise;
  assert.equal(saveResponse.status(), 200, "the flush-on-hashchange save must actually succeed, not just fire-and-hope");

  // Sanity: navigation itself completed correctly (the flush didn't throw
  // and block/break the hash-router's own render).
  await page.locator("#view-queue.active").waitFor({ state: "attached", timeout: 5000 });

  // (2) Direct, DOM-independent verification: read the REAL underlying
  // store this test's own Node process shares with the running server
  // (same GM_TOOLS_SESSION_NOTES_DIR, set by setupScratchEnv() above)
  // -- proves durable persistence, not just an in-memory/optimistic UI
  // state that would vanish on reload.
  const notes = listPendingNotes(WORLD);
  const savedNote = notes.find((n) => n.anchorEntityId === "sp-flush-neighbor" && n.text === NOTE_TEXT);
  assert.ok(
    savedNote,
    `expected a durably-persisted session note for sp-flush-neighbor with the typed text; got: ${JSON.stringify(notes)}`
  );

  // (3) A completely fresh page load (not just re-showing already-loaded
  // DOM) re-renders the note from that same durable store -- the
  // strongest possible proof this isn't an artifact of in-page state
  // surviving the hashchange by accident.
  await page.goto(`${base}/#session-planner/${sceneId}`);
  const neighborCardAgain = page.locator('[data-testid="location-card"][data-entity-id="sp-flush-neighbor"]');
  await neighborCardAgain.waitFor({ state: "visible", timeout: 15000 });
  await neighborCardAgain.locator('[data-testid="location-note-toggle"]').click();
  const noteEntry = neighborCardAgain.locator('[data-testid="location-note-entry"]', { hasText: NOTE_TEXT });
  await noteEntry.waitFor({ state: "visible", timeout: 5000 });
});
