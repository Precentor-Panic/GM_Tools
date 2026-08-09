// Phase 36 task 36.0 -- QE-first e2e contract, part 1: the stage-it TOGGLE
// (route contract + UI presence). Read phase36-fixture.mjs FIRST (§1-§3,
// §7).
//
// ORIGINAL EXPECTED-RED reasons (task 36.0, pre-36.2):
//   - `POST /api/session-planner/scenes/:id/stage` appeared nowhere in
//     server.mjs's route table -> a genuine 404.
//   - `[data-testid="scene-stage-toggle"]`/`[data-testid="scene-stage-
//     status-line"]` appeared nowhere in session-planner-view.js -> genuine
//     zero-count Playwright assertions.
// POST-36.2 UPDATE: the two UI tests below were FLIPPED from absence to
// presence assertions once the toggle/status-line actually shipped, per
// this file's own original inline instruction on those tests ("if this is
// >0, 36.2 has already shipped it and this test should be flipped to a
// presence assertion").
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  stageSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase36-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-p36stage-");
const WORLD = "e2e-p36-stage-toggle";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { markScenePushed } = await import("../../../session-planner/scenes.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base, browser, scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Stake out the ferry landing." });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// Route-level: POST /api/session-planner/scenes/:id/stage
// ---------------------------------------------------------------------------

test("POST /api/session-planner/scenes/:id/stage {world,staged:true} -> {scene} with stagedForFoundry:true (404 today)", async () => {
  const r = await stageSceneViaRoute(base, WORLD, scene.id, true);
  assert.equal(r.status, 200, `expected the v2-contract stage route to exist and succeed -- got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.scene.stagedForFoundry, true);
  assert.equal(r.body.scene.id, scene.id);
});

test("the staged scene also gained lastPushedAt:null as a field (additive, per §1) once staging exists", async () => {
  const r = await stageSceneViaRoute(base, WORLD, scene.id, true);
  assert.equal(r.status, 200, `expected the v2-contract stage route to exist -- got ${r.status}`);
  assert.ok("lastPushedAt" in r.body.scene, "Scene record must carry lastPushedAt once the additive field lands");
  assert.equal(r.body.scene.lastPushedAt, null, "a freshly-staged, never-pushed scene has lastPushedAt:null");
});

// CONTRACT CORRECTION (flagged, not silently absorbed): the fixture's §2
// text asserts unknown-sceneId is "the same 'No scene found' 404 every
// other scene route already produces (statusForError's `/not found/i`
// rule)". Re-checked directly against review-ui/server.mjs's real
// statusForError: `/not found/i` matches the literal substring "not
// found", which "No scene found" does NOT contain ("scene found", not "not
// found") -- and `/no (batch|region|entity|world|snapshot) found/i` doesn't
// list "scene" either. scenes.mjs's "No scene found" error has THUS ALWAYS
// fallen through to the default 400, everywhere in this codebase --
// confirmed by the ALREADY-PASSING, already-shipped
// review-ui/test/foundry-push-routes.test.mjs's own "unknown sceneId -> 400
// (matches the existing getScene error convention, same as every other
// session-planner route)" test. The fixture's 404 claim is the bug, not
// this route -- asserting 400 here (matching the REAL, established,
// everywhere-else convention) rather than either "fixing" statusForError
// (which would break that other, already-green regression test) or forking
// a special case just for the /stage route.
test("staging an unknown sceneId 400s with a clear error -- matches the REAL, established 'No scene found' convention every other scene route already uses (see this test's own comment: the fixture's stated '404' was checked against a statusForError rule that doesn't actually match this message)", async () => {
  const r = await stageSceneViaRoute(base, WORLD, "scene_does_not_exist", true);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No scene found/);
});

// ---------------------------------------------------------------------------
// UI-level: the scene page's stage toggle (Playwright)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UI presence, post-36.2 -- flipped from the original absence assertions per
// this suite's own inline instruction ("if this is >0, 36.2 has already
// shipped it and this test should be flipped to a presence assertion").
// ---------------------------------------------------------------------------

test("scene page has the stage-it toggle, reflecting stagedForFoundry via data-staged, and toggling it round-trips through the /stage route", async () => {
  // A FRESH scene, deliberately NOT the shared `scene` above (the route-level
  // tests already staged that one) -- this test needs to observe the
  // toggle's own starting-unstaged state.
  const fresh = await createSceneViaRoute(base, WORLD, { objectiveNote: "Fresh, never-staged scene." });
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${fresh.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${fresh.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const toggle = page.locator('[data-testid="scene-stage-toggle"]');
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await toggle.count(), 1, "exactly one stage-it toggle on the scene page");
  assert.equal(await toggle.getAttribute("data-staged"), "false", "this scene was never staged -- starts false");
  assert.ok(!(await toggle.evaluate((el) => el.checked)), "the checkbox itself must also start unchecked");

  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scene-stage-toggle"]')?.getAttribute("data-staged") === "true",
    { timeout: 15000 }
  );

  const getRes = await fetch(`${base}/api/session-planner/scenes/${encodeURIComponent(fresh.id)}?world=${encodeURIComponent(WORLD)}`);
  const { scene: reread } = await getRes.json();
  assert.equal(reread.stagedForFoundry, true, "the toggle click must have actually persisted through POST .../stage");

  await page.close();
});

test("scene page's 'in Foundry' status line is absent while unstaged, appears once staged, and never mentions push/sync (the quiet-line, not an action)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const unstaged = await createSceneViaRoute(base, WORLD, { objectiveNote: "Never staged." });
  await page.goto(`${base}/#planner/scene/${unstaged.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${unstaged.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="scene-stage-status-line"]').count(), 0, "no status line for a never-staged scene");

  await stageSceneViaRoute(base, WORLD, unstaged.id, true);
  // page.goto() to the SAME URL (identical hash) is a documented no-op in
  // this project's own e2e convention (phase35-library-tabs.e2e.mjs etc.) --
  // page.reload() is the real "re-fetch server state while already here" op.
  await page.reload();
  await root.waitFor({ state: "visible", timeout: 15000 });
  const line = page.locator('[data-testid="scene-stage-status-line"]');
  await line.waitFor({ state: "visible", timeout: 15000 });
  const text = (await line.textContent()) ?? "";
  assert.match(text, /in Foundry/i);
  assert.doesNotMatch(text.toLowerCase(), /push|sync now/, "the status line must never contain a push/sync-now verb -- it's a quiet line, not an action");

  await page.close();
});

// ---------------------------------------------------------------------------
// UI-level: the status line SELF-REFRESHES (Phase 36 task 36.4a, Russell's
// pass finding #1 -- "the update seemed slow"). markScenePushed advances
// lastPushedAt SERVER-SIDE (the real store function the quiet flush itself
// calls on a confirmed apply -- exactly what "the flush landed while you
// were looking at the page" looks like from the store's point of view); the
// test asserts the already-open page's status line reflects it WITHOUT a
// page.reload(), inside the bounded client poll window (~3s/8s/15s ticks --
// a generous timeout per this repo's own e2e discipline).
// ---------------------------------------------------------------------------

test("scene page's 'in Foundry' status line self-refreshes: markScenePushed advances lastPushedAt server-side, the already-open page's line updates within the poll window WITHOUT a reload", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const staged = await createSceneViaRoute(base, WORLD, { objectiveNote: "Self-refresh target." });
  await stageSceneViaRoute(base, WORLD, staged.id, true);

  await page.goto(`${base}/#planner/scene/${staged.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${staged.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  const line = page.locator('[data-testid="scene-stage-status-line"]');
  await line.waitFor({ state: "visible", timeout: 15000 });
  assert.match((await line.textContent()) ?? "", /not yet live/, "starts never-pushed");

  // The server-side confirm the quiet flush itself performs on an ok:true
  // apply -- no route call, no reload, just the store record changing under
  // the already-open page.
  markScenePushed(WORLD, staged.id, { foundrySceneRef: "Scene.selfRefresh1", lastPushedAt: new Date().toISOString() });

  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="scene-stage-status-line"]');
      return !!el && /updated/i.test(el.textContent || "") && !/not yet live/i.test(el.textContent || "");
    },
    { timeout: 20000 }
  );
  const updatedText = (await line.textContent()) ?? "";
  assert.match(updatedText, /in Foundry · updated/i);

  await page.close();
});
