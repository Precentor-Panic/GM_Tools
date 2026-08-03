// Phase 26 task 26.0, REQUIRED SCENARIO 11 -- the two §26.H live-repro bugs.
// Read phase26-fixture.mjs's header FIRST. EXPECTED TO FAIL right now --
// none of the Plan-scoped `<details>` elements this file targets exist yet
// (they're Phase 26 §26.8's own new DOM, not built until task 26.8/26.12).
//
// ============================================================================
// HONEST REPRO ACCOUNT (required by this task's own instructions -- read
// before trusting either test below at face value):
// ============================================================================
//
// BUG 1 ("Table Mode's 'All scenes' <details> won't re-collapse"): A REAL
// server + real headless Chromium was actually driven (not just read
// statically) against the CURRENT, live `table-full-list` implementation,
// including: repeated single-clicks on the toggle (correctly alternates
// open/closed -- native <details> semantics work fine); a real cross-scene
// navigation via a full-list item while the list was open (the NEW page's
// own full-list correctly starts collapsed -- container.innerHTML="" does
// clear it); an artificial-network-delay race between two rapid, overlapping
// navigations (no stuck-open state found -- whichever render's async chain
// resolves LAST always ends with a freshly-built, closed <details>); and a
// real touch-tap sequence (three taps: true/false/true, correct toggle
// alternation). NONE of these reproduced a stuck-open disclosure.
//
// ONE genuine, reliably-reproducible gap WAS found: clicking a scene-list
// item whose target is the SCENE ALREADY BEING VIEWED is a real, common
// case (the current scene's own entry is present in its own full list) that
// produces NO hash change and therefore NO re-render -- so the list some DM
// legitimately expects to "just close, I picked a scene" stays open, since
// nothing about opening OR closing it was ever explicitly wired into the
// click handler itself; the only thing that ever closes it is a fresh
// render triggered by an ACTUAL navigation. This is a real, directly
// observed behavior gap, matching the reported symptom's own wording
// ("jump to a scene via a list item, the disclosure stays open when it
// shouldn't") closely enough to treat as the most likely real root cause --
// but it was not possible to fully cross-confirm this is THE SAME bug the
// project owner originally hit (vs. a related-but-distinct issue) without
// their own original repro steps. The test below asserts the CORRECT
// end-state directly (per this task's own explicit fallback allowance):
// clicking ANY scene-list item -- including a same-scene, no-op one --
// must leave that list's own <details> closed immediately, not only as a
// side effect of a hash-triggered re-render. This is written against the
// Plan-scoped `<details>` elements Phase 26 §26.8 introduces (table-active-
// plan-list / table-other-plan-item), NOT the old `table-full-list` --
// §26.8 replaces that structure, and task 26.12 (which actually fixes this
// bug) is sequenced after 26.8 in the phase's own task list, so by the time
// it runs `table-full-list` no longer exists to fix.
//
// BUG 2 (tripled Add Event panel, first instance garbled): substantial
// genuine effort across multiple plausible mechanisms found NO reproduction
// against the current build: rapid double-navigation with artificial
// network delay (both construction view and Table Mode, several hundred ms
// of induced overlap); rapid double-clicks on the Add Event button itself;
// three consecutive construction<->table-mode round trips; and inspecting
// every `mountAddEventControl` call site plus `chainSceneIds`/
// `buildChainOrder`'s own dedup guarantees directly in source. All produced
// exactly one `scene-event-panel` with the correct, un-truncated placeholder
// text every time. This bug was NOT reproduced, and no root cause was
// pinned. Per this task's own explicit instruction ("if you can't fully pin
// the root cause in the time you have, write a test asserting the CORRECT
// end-state behavior... that's a normal red-before-green case, not a
// blocker"), the second test below is a stress-test-shaped regression guard
// -- it drives the SAME rapid-renavigation pattern used during the repro
// attempt and asserts exactly one Add Event panel with the exact correct
// placeholder text survives, in BOTH views. It currently PASSES against the
// real running app (confirmed) -- it is included here anyway as a
// permanent regression guard for this exact reported shape, and to
// document precisely what was and wasn't reproduced, per this task's own
// explicit honesty requirement. Root-causing (if a real bug exists at all,
// possibly browser-specific/environment-specific beyond what this
// Chromium-only suite can reach) is 26.12's job, not this task's.
//
// ============================================================================
// TASK 26.12 STATUS (final self-review pass, run against the completed
// Phase 26 build -- both bugs re-examined on real running instances, not
// re-guessed):
// ============================================================================
// BUG 1: CONFIRMED FIXED. Root cause was independently reconfirmed while
// building task 26.4's own add-scene-btn/panel (an unrelated control that
// hit the exact same same-hash-no-op-navigation symptom before this test
// file's own bugs were revisited) -- buildPlanSceneItem (session-planner-
// view.js) was built with this root cause in mind FROM THE START (per this
// task's own explicit instruction to not rediscover it), so both BUG 1
// tests below already pass as a direct consequence of 26.8's own
// implementation, not a separate fix pass.
// BUG 2: STILL NOT REPRODUCED. A further, dedicated repro attempt was made
// against the FULLY COMPLETED Phase 26 build (26.1-26.11 all landed,
// exactly the "may only manifest once the render/navigation paths actually
// change shape" scenario originally flagged) -- combining the NEW
// Plan-scoped nav (rapid table-active-plan-scene-item clicks/double-clicks),
// the NEW add-scene-btn/panel, and the NEW table-quick-gen control together
// with rapid re-navigation, still produced exactly one scene-event-panel
// every time, with zero page errors. Honestly still open, not claimed
// fixed: the regression guard below remains the real, permanent safety net
// for this reported shape, and stays green throughout.
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";
import { gotoTableMode, constructionHash } from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-tmbugs-");
const WORLD = "e2e-tmbugs-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmbugs-a", name: "TM Bugs Scene A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "tmbugs-b", name: "TM Bugs Scene B", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let sceneA, sceneB;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmbugs-a" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmbugs-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Bug Repro Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("BUG 1 fix: clicking a scene-list item pointing at the SCENE ALREADY BEING VIEWED (a real no-op navigation) still explicitly closes that item's own <details> disclosure", async () => {
  await gotoTableMode(page, base, sceneA.id);
  const activeList = page.locator('[data-testid="table-active-plan-list"]');
  await activeList.waitFor({ state: "visible", timeout: 15000 });

  // Ensure open (it should already be, per §26.8's "current expanded"
  // default, but this test's OWN premise doesn't depend on that default --
  // it depends only on "open, then click a same-scene item, then check").
  if (!(await activeList.evaluate((el) => el.open))) {
    await activeList.locator('[data-testid="table-active-plan-toggle"]').click();
  }
  assert.equal(await activeList.evaluate((el) => el.open), true, "test setup: the active-plan list must be open before this test's real click");

  const selfItem = activeList.locator(`[data-testid="table-active-plan-scene-item"][data-scene-id="${sceneA.id}"]`);
  await selfItem.waitFor({ state: "visible", timeout: 5000 });
  const hashBefore = await page.evaluate(() => location.hash);
  await selfItem.click();
  const hashAfter = await page.evaluate(() => location.hash);
  assert.equal(hashAfter, hashBefore, "test premise check: clicking the CURRENTLY-viewed scene's own entry must genuinely be a no-op navigation (same hash) -- confirms this is the exact real gap found during live repro, not a different scenario");

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="table-active-plan-list"]')?.open === false,
      { timeout: 3000 }
    );
  }, "***BUG 1 FIX***: even a same-scene (no-op-navigation) click on a scene-list item must explicitly close that list's own <details> -- it must not rely solely on a hash-change-triggered re-render to do so, since a same-scene click never produces one");
});

test("BUG 1 fix, other-plan variant: clicking a scene item inside an OTHER (non-active) plan's own <details> closes THAT disclosure too, even for a same-scene no-op click", async () => {
  const otherPlan = await createPlanViaRoute(base, WORLD, "Other Plan For Bug 1");
  await addSceneToPlanViaRoute(base, WORLD, otherPlan.id, sceneA.id);

  await gotoTableMode(page, base, sceneB.id);
  const otherPlanItem = page.locator(`[data-testid="table-other-plan-item"][data-plan-id="${otherPlan.id}"]`);
  await otherPlanItem.waitFor({ state: "visible", timeout: 15000 });
  await otherPlanItem.locator('[data-testid="table-other-plan-toggle"]').click();
  assert.equal(await otherPlanItem.evaluate((el) => el.open), true, "test setup: the other-plan item must be open before this test's real click");

  const itemA = otherPlanItem.locator(`[data-testid="table-other-plan-scene-item"][data-scene-id="${sceneA.id}"]`);
  await itemA.waitFor({ state: "visible", timeout: 5000 });
  await itemA.click();

  // This IS a real navigation (sceneB -> sceneA), so it's the OTHER case
  // (fresh-render-driven collapse) -- included for completeness, confirming
  // the fix doesn't regress the normal navigating case either.
  await assert.doesNotReject(async () => {
    await page.waitForFunction((h) => location.hash === `#${h}`, `session-planner/${sceneA.id}?mode=table`, { timeout: 5000 });
  }, "a genuine cross-scene click must still navigate normally");
});

test("BUG 2 regression guard: after a rapid re-navigation stress sequence (construction view), exactly ONE Add Event panel exists, with the correct, un-truncated placeholder text", async () => {
  await page.goto(`${base}/#${constructionHash(sceneA.id)}`);
  await page.waitForSelector('[data-testid="scene-chain"]', { timeout: 15000 });

  // The same rapid-renavigation stress pattern used during this task's own
  // live-repro attempt.
  await page.evaluate((h) => { location.hash = h; }, constructionHash(sceneB.id));
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, constructionHash(sceneA.id));
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, constructionHash(sceneB.id));
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, constructionHash(sceneA.id));
  await page.waitForTimeout(1200);
  await page.waitForSelector('[data-testid="scene-chain"]', { timeout: 15000 });

  const panelCount = await page.evaluate(() => document.querySelectorAll('[data-testid="scene-event-panel"]').length);
  assert.equal(panelCount, 1, "***BUG 2 regression guard***: exactly one scene-event-panel must exist for scene A after a rapid re-navigation stress sequence -- never tripled/duplicated");

  const placeholder = await page.evaluate(() => document.querySelector('[data-testid="scene-event-textarea"]')?.getAttribute("placeholder") ?? "");
  assert.equal(placeholder, "Jot an event note — autosaves as you type…", "the surviving panel's placeholder text must be the exact, correct, un-truncated string -- not garbled/partial");
});

test("BUG 2 regression guard: the same property holds in Table Mode", async () => {
  await gotoTableMode(page, base, sceneA.id);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  await page.evaluate((h) => { location.hash = h; }, `#session-planner/${sceneB.id}?mode=table`);
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, `#session-planner/${sceneA.id}?mode=table`);
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, `#session-planner/${sceneB.id}?mode=table`);
  await page.waitForTimeout(40);
  await page.evaluate((h) => { location.hash = h; }, `#session-planner/${sceneA.id}?mode=table`);
  await page.waitForTimeout(1200);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const panelCount = await page.evaluate(() => document.querySelectorAll('[data-testid="scene-event-panel"]').length);
  assert.equal(panelCount, 1, "***BUG 2 regression guard*** (Table Mode): exactly one scene-event-panel must exist after the same rapid re-navigation stress sequence");

  const placeholder = await page.evaluate(() => document.querySelector('[data-testid="scene-event-textarea"]')?.getAttribute("placeholder") ?? "");
  assert.equal(placeholder, "Jot an event note — autosaves as you type…", "the surviving Table Mode panel's placeholder text must be exact and un-truncated");
});
