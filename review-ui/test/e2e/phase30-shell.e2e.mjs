// Phase 30 task 30.0 -- the SHELL contract (app-shell visibility switch,
// topbar toggle/breadcrumb/world-select, planner rail with plans+scene-
// library+add-to-plan). Read phase30-fixture.mjs's header FIRST. EXPECTED TO
// FAIL right now: `[data-testid="app-shell"]` does not exist anywhere in
// index.html (confirmed by direct read), so every locator below times out.
// That failure is the deliverable of this task, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p30-shell-");
const WORLD = "e2e-p30-shell-world";
const WORLD_B = "e2e-p30-shell-world-b";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
applyHeadless(snapshotFilePath(dataDir, WORLD), [
  { op: "upsert_entity", data: { id: "shell-place-a", name: "The Gilded Cistern", type: "place", importance: 0.5 } }
]);
bootstrapSnapshot(snapshotFilePath(dataDir, WORLD_B), { worldId: WORLD_B });

let server, base, browser;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// Phase 37 task 37.3: this test's old "legacy hash" example was `#queue`,
// which now hash-redirects into the shell (#chronicle). Retargeted to `#graph`
// -- a surviving legacy (non-shell) hash -- so the shell-vs-legacy-chrome
// visibility switch this test actually exercises is unchanged.
test("app-shell is hidden on a legacy hash (#graph) and visible with legacy chrome hidden on #planner/plans", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.goto(`${base}/#graph`);
  await page.locator("header.topbar").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="app-shell"]').isVisible().catch(() => false), false, "app-shell must be hidden on a legacy hash");

  await page.goto(`${base}/#planner/plans`);
  const shell = page.locator('[data-testid="app-shell"][data-surface="planner"]');
  await shell.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator("header.topbar").isVisible().catch(() => false), false, "legacy topbar must be hidden inside the shell");
  assert.equal(await page.locator("main").isVisible().catch(() => false), false, "legacy main must be hidden inside the shell");
  await page.close();
});

test("surface toggle switches planner <-> world, updating the hash and swapping main-column roots", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="shell-surface-toggle-world"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#world", { timeout: 10000 });
  }, "clicking the World toggle must navigate to bare #world");
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="shell-rail-planner"]').count(), 0, "the planner rail must not remain mounted on the World surface");

  // Amended Decision 4 (2026-10-07): the toggle returns to the REMEMBERED
  // planner route. Here the only planner route ever visited was the shelf, so
  // the expected hash is unchanged from the original Decision 4 -- the
  // first-visit case still lands exactly where it always did. The scene case
  // is the next test.
  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#planner/plans", { timeout: 10000 });
  }, "with only the shelf ever visited, the Session planner toggle must still navigate to #planner/plans");
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="world-surface-root"]').count(), 0);
  await page.close();
});

// ---------------------------------------------------------------------------
// Amended Decision 4 (navigation round, 2026-10-07). This REPLACES the old
// contract, which the test above used to pin verbatim: "the toggle ALWAYS
// navigates to the surface's canonical entry (never a remembered last-visited
// sub-route)."
//
// Russell, at the table: "it would be great if the session runner remembered
// the last scene if I had to jump to the World tab to find a name." Leaving
// the planner to look up a name and coming back to the plans shelf cost him
// two clicks and a re-find, every time. World/Chronicle/Library/Briefing keep
// the original rule; only the planner remembers.
// ---------------------------------------------------------------------------
test("amended Decision 4: the planner toggle returns to the last scene, in the view it was left in, per world", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  const sceneId = scene.id;

  await page.goto(`${base}/#planner/scene/${sceneId}`);
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 15000 });

  // Leave the scene in RUN -- the second half of the complaint was coming back
  // to a scene re-opened in Prep.
  await page.locator('[data-testid="mode-run-btn"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="planner-scene-view"] .scene-page')?.getAttribute("data-mode") === "run",
    { timeout: 10000 }
  );

  await page.locator('[data-testid="shell-surface-toggle-world"]').click();
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });

  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => location.hash === `#planner/scene/${id}`,
      sceneId,
      { timeout: 10000 }
    );
  }, "the Session planner toggle must return to the scene the GM was last on");
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 10000 });

  assert.equal(
    await page.locator('[data-testid="planner-scene-view"] .scene-page').getAttribute("data-mode"),
    "run",
    "the scene must come back in Run -- jumping to World to look up a name must not reset the view"
  );

  // Both rails still come back CLOSED. layout-stability asserts Run's geometry
  // is identical whichever view you arrive from, which only holds while their
  // default is deterministic -- so this half of resetScenePageMode stays.
  assert.equal(
    await page.locator('[data-testid="planner-scene-view"] .scene-page').getAttribute("data-partyrail"),
    "closed",
    "the party rail must come back closed"
  );

  // Per-world: the remembered route is a world-scoped id, so switching worlds
  // must not try to open world A's scene inside world B.
  await page.evaluate((w) => localStorage.setItem("gmReview.world", w), WORLD_B);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="shell-surface-toggle-world"]').click();
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#planner/plans", { timeout: 10000 });
  }, "a second world must not inherit the first world's remembered scene");

  await page.close();
});

// QC round 2026-10-13. The round above brought the GM back to the right scene
// and view, but the page is rebuilt on the way back and reopened at the TOP --
// in a long Run spread that is still a re-find. The place in the scene comes
// back too, but only on a return from another surface: scene-to-scene
// navigation must keep opening a scene at its top.
test("the rail is collapsed in Run, the edge tab brings it back, and Prep always shows it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 15000 });
  const rail = page.locator('[data-testid="shell-rail-planner"]');
  const tab = page.locator('[data-testid="shell-rail-tab"]');
  const runLeft = () => page.locator('[data-testid="mode-run-btn"]').evaluate((el) => Math.round(el.getBoundingClientRect().left));

  assert.equal(await rail.isVisible(), true, "Prep shows the rail");
  assert.equal(await tab.isVisible(), false, "no edge tab in Prep");
  const left0 = await runLeft();

  await page.locator('[data-testid="mode-run-btn"]').click();
  await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible" });
  assert.equal(await rail.isVisible(), false, "Run hides the rail");
  assert.equal(await tab.isVisible(), true, "Run shows the edge tab");
  assert.equal(await runLeft(), left0, "the Run button stays under the pointer");

  await tab.click();
  assert.equal(await rail.isVisible(), true, "the tab brings the rail back");
  assert.equal(await runLeft(), left0, "and the view control still has not moved");
  await tab.click();
  assert.equal(await rail.isVisible(), false);

  await page.locator('[data-testid="mode-prep-btn"]').click();
  await rail.waitFor({ state: "visible" });
  await page.close();
});

test("returning to a scene from another surface restores the scroll position; opening a scene fresh does not", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 520 } });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  const other = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  for (const id of [scene.id, other.id]) {
    for (let i = 0; i < 14; i++) {
      const res = await fetch(`${base}/api/scene-planning/scenes/${id}/elements`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: WORLD, name: `Filler ${i}`, kind: "local", fields: { gives: "A line of text that makes the page tall enough to scroll. ".repeat(4) } })
      });
      assert.equal(res.ok, true);
    }
  }
  const top = () => page.evaluate(() => document.querySelector(".planner-scene-surface")?.scrollTop ?? -1);
  const scrollTo = (y) => page.evaluate((v) => { document.querySelector(".planner-scene-surface").scrollTop = v; }, y);

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => { const s = document.querySelector(".planner-scene-surface"); return s && s.scrollHeight - s.clientHeight > 500; }, null, { timeout: 10000 });
  await scrollTo(400);
  // The offset is recorded from the scroll EVENT, which the browser dispatches
  // on the next frame -- wait for the record, not just for the property.
  await page.waitForFunction(() => Object.entries(sessionStorage).some(([k, v]) => k.startsWith("gmReview.sceneScroll:") && v === "400"), null, { timeout: 5000 });

  await page.locator('[data-testid="shell-surface-toggle-world"]').click();
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 10000 });
  // Within a few pixels: the browser's own scroll anchoring nudges the offset
  // as late content settles above the fold.
  await page.waitForFunction(() => Math.abs((document.querySelector(".planner-scene-surface")?.scrollTop ?? 0) - 400) <= 24, null, { timeout: 8000 }).catch(() => {});
  const back = await top();
  assert.ok(Math.abs(back - 400) <= 24, `coming back from World must put the scene back where it was scrolled to (got ${back}, wanted about 400)`);

  // A different scene opened from inside the planner starts at its top...
  await page.goto(`${base}/#planner/scene/${other.id}`);
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(600);
  assert.equal(await top(), 0, "a scene opened from inside the planner must open at the top");
  // ...and so does the first scene when it is navigated to rather than returned to.
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(600);
  assert.equal(await top(), 0, "navigating to a scene (not returning to it) must open at the top");

  await page.close();
});

test("amended Decision 4: a remembered scene that no longer exists falls back to the shelf", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  // Forge a remembered route pointing at a scene id that was never created --
  // the same state the GM reaches by deleting the scene they were last on.
  await page.evaluate(
    (w) => localStorage.setItem(`gmReview.lastPlannerRoute:${w}`, "scene/scene_does_not_exist"),
    WORLD
  );
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  // First click honours the stale value and lands on the dead scene, which
  // reports honestly rather than rendering a blank page...
  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await page.waitForFunction(() => location.hash.startsWith("#planner/scene/"), { timeout: 10000 });

  // ...and renderShell FORGETS it, so the route cannot stay poisoned.
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (w) => localStorage.getItem(`gmReview.lastPlannerRoute:${w}`) === null,
      WORLD,
      { timeout: 10000 }
    );
  }, "a remembered route naming a missing scene must be cleared");

  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="shell-surface-toggle-planner"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#planner/plans", { timeout: 10000 });
  }, "after the stale route is forgotten the toggle must fall back to the shelf");

  await page.close();
});

test("breadcrumb: no standalone Plans crumb on the bare plans-list route; Plans leads once a plan/scene is open; scene segment is a non-navigating leaf", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Breadcrumb Check Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="planner-plans-view"]').waitFor({ state: "visible", timeout: 15000 });
  // QA W3 finding 1: the standalone "Plans" crumb is redundant on the
  // plans-list route itself (the Session planner tab already says where you
  // are) -- it no longer renders here at all.
  assert.equal(await page.locator('[data-testid="shell-breadcrumb-plans"]').count(), 0, "no standalone Plans crumb on the bare shelf");
  assert.equal(await page.locator('[data-testid="shell-breadcrumb-plan"]').count(), 0, "no plan segment on the bare shelf");

  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const planCrumb = page.locator(`[data-testid="shell-breadcrumb-plan"][data-plan-id="${plan.id}"]`);
  await planCrumb.waitFor({ state: "visible", timeout: 15000 });
  // Once a plan is open, "Plans" leads the trail as a clickable parent again.
  await page.locator('[data-testid="shell-breadcrumb-plans"]').waitFor({ state: "visible", timeout: 15000 });

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const sceneCrumb = page.locator(`[data-testid="shell-breadcrumb-scene"][data-scene-id="${scene.id}"]`);
  await sceneCrumb.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="shell-breadcrumb-plans"]').waitFor({ state: "visible", timeout: 15000 });
  await sceneCrumb.click();
  await page.waitForTimeout(300);
  assert.equal(page.url().includes(`#planner/scene/${scene.id}`) || (await page.evaluate(() => location.hash)) === `#planner/scene/${scene.id}`, true, "clicking the leaf scene crumb must not navigate away");

  await page.goto(`${base}/#world`);
  assert.equal(await page.locator('[data-testid="shell-breadcrumb"]').count(), 0, "breadcrumb is planner-surface-only");
  await page.close();
});

test("deep link: #planner/scene/<id> opens the scene directly with no prior click", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.close();
});

test("rail: plans list + scene library render; scene-library row + adds to the open plan, with dedupe notice and undo", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });
  const plan = await createPlanViaRoute(base, WORLD, "Rail Add Check Plan");

  await page.goto(`${base}/#planner/plan/${plan.id}`);
  const railPlanItem = page.locator(`[data-testid="shell-plan-item"][data-plan-id="${plan.id}"]`);
  await railPlanItem.waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await railPlanItem.locator('[data-testid="shell-plan-item-name"]').textContent()).trim(), "Rail Add Check Plan");

  const libItem = page.locator(`[data-testid="shell-scene-library-item"][data-scene-id="${scene.id}"]`);
  await libItem.waitFor({ state: "visible", timeout: 15000 });
  await libItem.locator('[data-testid="shell-scene-library-item-add-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="undo-toast"]') !== null, { timeout: 10000 });
  }, "adding a scene not already in the open plan must call the real route and show an undo toast");

  let planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.deepEqual(planAfter.plan.sceneIds, [scene.id]);

  // Clicking + again on the same (now-member) scene: dedupe notice, no second toast/route effect.
  await libItem.locator('[data-testid="shell-scene-library-item-add-btn"]').click();
  const dedupe = page.locator(`[data-testid="shell-add-to-plan-dedupe-notice"][data-plan-id="${plan.id}"]`);
  await dedupe.waitFor({ state: "visible", timeout: 10000 });
  assert.match((await dedupe.textContent()) || "", /already in/i);
  assert.match((await dedupe.textContent()) || "", /Rail Add Check Plan/);

  planAfter = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.deepEqual(planAfter.plan.sceneIds, [scene.id], "dedupe must not add the scene a second time");
  await page.close();
});

test("rail: + with no open plan (on the bare shelf) shows a no-target notice and calls no route", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "shell-place-a" });

  await page.goto(`${base}/#planner/plans`);
  const libItem = page.locator(`[data-testid="shell-scene-library-item"][data-scene-id="${scene.id}"]`);
  await libItem.waitFor({ state: "visible", timeout: 15000 });
  await libItem.locator('[data-testid="shell-scene-library-item-add-btn"]').click();

  const notice = page.locator('[data-testid="shell-add-to-plan-no-target-notice"]');
  await notice.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="undo-toast"]').count(), 0);
  await page.close();
});

test("shell world select writes localStorage[gmReview.world] and re-renders the rail for the newly selected world", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const planWorldA = await createPlanViaRoute(base, WORLD, "World A Only Plan");
  const planWorldB = await createPlanViaRoute(base, WORLD_B, "World B Only Plan");

  await page.goto(`${base}/#planner/plans`);
  await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${planWorldA.id}"]`).waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="shell-world-select"]').selectOption(WORLD_B);
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => localStorage.getItem("gmReview.world") === "e2e-p30-shell-world-b", { timeout: 10000 });
  }, "changing the shell world select must write localStorage[gmReview.world]");
  await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${planWorldB.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(`[data-testid="shell-plan-item"][data-plan-id="${planWorldA.id}"]`).count(), 0, "world A's plan must not remain listed after switching to world B");
  await page.close();
});
