// Phase 20 task 20.2 -- regression test for Session Planner's zero-
// persistence bug. plans/phase-20-tasks.md 20.2's confirmed root cause: the
// scene id only ever lived in the hash-route arg, and the nav bar's "Plan
// Session" button (`data-nav="session-planner"`, no scene id ever encoded)
// routes to the bare `#session-planner` hash -- so clicking it (or any other
// bare navigation into this view) always fell through to the empty-state
// bootstrap screen, discarding whatever scene was in progress. Fixed via a
// new per-world `gmReview.sessionPlanner.<world>.lastSceneId` localStorage
// entry (session-planner-view.js's own naming/try-catch convention, mirrored
// from combat-planning-view.js's attendanceKey), written on every real
// scene-load/create/fork, and read by the bare route to resume instead of
// bootstrapping.
//
// Mirrors session-planner-flush-on-navigate.e2e.mjs's exact conventions:
// real in-process server, real fixture seeding via bootstrapSnapshot +
// applyHeadless, real headless Chromium, and (per this task's own
// instruction) a real nav-button CLICK for the return trip -- not a manually
// set location.hash, since the whole point is proving the actual nav
// button's real bare-route navigation survives.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-sp-resume-");
const WORLD = "e2e-sp-resume-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sp-resume-home", name: "Resume Test Home Base", type: "place", importance: 0.5 } }
]);

let server, base, browser, page, sceneId;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  // Seed the scene via the REAL API (matches this project's established
  // e2e/route-test convention: never hand-construct the scene JSON file).
  const sceneRes = await fetch(`${base}/api/session-planner/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, locationEntityId: "sp-resume-home" })
  });
  const sceneBody = await sceneRes.json();
  assert.equal(sceneRes.status, 200, "scene setup itself must succeed -- broken test setup, not the thing under test");
  sceneId = sceneBody.scene.id;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });

  // world selection is read from localStorage's "gmReview.world" key (both
  // app.js and session-planner-view.js's own header comment document this);
  // set it up front via a real page load so the nav bar's world-select is
  // already correctly seeded for every navigation below.
  await page.goto(`${base}/#queue`);
  await page.evaluate((world) => localStorage.setItem("gmReview.world", world), WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("Session Planner survives navigating away and back via the real nav button, resuming the same scene instead of the bootstrap screen", async () => {
  // Load the real scene directly (deep link), same as this project's other
  // session-planner e2e tests -- proves the scene itself, and confirms the
  // resume mechanism below is doing genuine work rather than the scene
  // simply always being trivially reachable anyway.
  await page.goto(`${base}/#session-planner/${sceneId}`);
  const anchorCard = page.locator('[data-testid="location-card"][data-card-role="anchor"]');
  await anchorCard.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await anchorCard.getAttribute("data-entity-id"), "sp-resume-home");

  // Navigate to a DIFFERENT view -- Graph -- via a real nav click.
  await page.locator('.topnav [data-nav="graph"]').click();
  await page.locator("#view-graph.active").waitFor({ state: "attached", timeout: 5000 });

  // Navigate back to Session Planner via the ACTUAL nav button (not
  // manually setting the hash) -- this is the exact button whose bare
  // `data-nav="session-planner"` (no scene id encoded) was the reported
  // bug's proximate trigger.
  await page.locator('.topnav [data-nav="session-planner"]').click();

  // The hash bar itself must now genuinely reflect the resumed scene
  // (history.replaceState kept it in sync), not just the in-page DOM --
  // proves this isn't a coincidental leftover render.
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#session-planner/${expected}`,
      sceneId,
      { timeout: 5000 }
    );
  }, "the URL hash must be updated to reflect the resumed scene, not left as the bare #session-planner route");

  const anchorCardAgain = page.locator('[data-testid="location-card"][data-card-role="anchor"]');
  await anchorCardAgain.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(
    await anchorCardAgain.getAttribute("data-entity-id"),
    "sp-resume-home",
    "clicking the real nav button after navigating away must resume the SAME in-progress scene, not fall through to the bootstrap screen"
  );

  // The bootstrap screen's own DOM must genuinely be absent -- not just "a
  // location card happens to be showing" (belt-and-suspenders against a
  // false pass where both bootstrap and brief somehow rendered at once).
  await assert.doesNotReject(async () => {
    const bootstrapCount = await page.locator('[data-testid="scene-bootstrap-location-input"]').count();
    assert.equal(bootstrapCount, 0);
  }, "the bootstrap flow must not be showing once the scene has resumed");
});

test('the "Start a new plan" affordance actually starts fresh, and does not get stuck resuming forever', async () => {
  // Resume the same persisted scene from a fresh page load first (sanity --
  // confirms persistence survived the previous test / a real reload).
  await page.goto(`${base}/#session-planner`);
  const anchorCard = page.locator('[data-testid="location-card"][data-card-role="anchor"]');
  await anchorCard.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await anchorCard.getAttribute("data-entity-id"), "sp-resume-home");

  // Click the explicit "start a new plan" escape hatch.
  const startNewBtn = page.locator('[data-testid="session-planner-start-new"]');
  await startNewBtn.waitFor({ state: "visible", timeout: 5000 });
  await startNewBtn.click();

  // Must land on the real bootstrap screen -- not the resumed brief.
  const bootstrapInput = page.locator('[data-testid="scene-bootstrap-location-input"]');
  await bootstrapInput.waitFor({ state: "visible", timeout: 15000 });

  // The critical "doesn't get stuck resuming forever" check: navigating to
  // the bare route AGAIN (e.g. the real nav button, exactly as a DM would)
  // must still land on bootstrap, not silently snap back to the old scene --
  // proves the persisted pointer was genuinely cleared, not just visually
  // bypassed for this one navigation.
  await page.locator('.topnav [data-nav="queue"]').click();
  await page.locator("#view-queue.active").waitFor({ state: "attached", timeout: 5000 });
  await page.locator('.topnav [data-nav="session-planner"]').click();
  await bootstrapInput.waitFor({ state: "visible", timeout: 15000 });

  await assert.doesNotReject(async () => {
    const oldAnchorCount = await page.locator('[data-testid="location-card"][data-entity-id="sp-resume-home"]').count();
    assert.equal(oldAnchorCount, 0);
  }, "after starting a new plan, the old scene must not silently resume again on a later bare navigation");
});
