// Aureus table wave B1 (G3) -- the scene LIFECYCLE surfaces end to end:
// Activate (Prep chip row + Run header, same shared builder), the unstage
// "remove from Foundry" offer line, the scene-delete "also remove" checkbox
// + orphan capture, and the Settings "Foundry scene cleanup" stale-scene
// sweep. Fakes the Foundry-side watcher exactly like wf-mcp-server/test/
// scene-lifecycle-ops.test.mjs does (a timer that reads the real ops file,
// writes results, clears ops) rather than a live Foundry client -- same
// pattern foundry-push-routes.test.mjs's own setInterval fake watcher uses
// for a browser-driven request whose own opId isn't known in advance.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase36Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  seedSceneStaged,
  DESKTOP_VIEWPORT
} from "./phase36-fixture.mjs";

const { scratchDir, dataDir } = setupPhase36Env("gm-tools-e2e-scene-lifecycle-");
// Aureus table wave B1's own new store -- not part of setupPhase36Env's
// chain (no prior phase needed it), same scratch-isolation convention as
// review-ui/test/scene-lifecycle-routes.test.mjs.
process.env.GM_TOOLS_FOUNDRY_ORPHANS_DIR = join(scratchDir, "foundry-orphans");

const WORLD = "e2e-scene-lifecycle-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { getScene } = await import("../../../session-planner/scenes.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

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

function opsPath(world) { return join(dataDir, "worlds", world, "world-fabric-foundry-ops.json"); }
function resultsPath(world) { return join(dataDir, "worlds", world, "world-fabric-foundry-results.json"); }

function readOps(world) {
  const p = opsPath(world);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8").trim();
  if (!raw || raw === "[]") return [];
  try { return JSON.parse(raw); } catch { return []; } // mid-write -- try again next poll
}

/**
 * One-shot fake watcher, mirroring wf-mcp-server/test/scene-lifecycle-ops.
 * test.mjs's armCapturingWatcher: polls the REAL ops file (interval, not a
 * single fixed-delay timeout, since a browser click's own timing to the
 * write isn't known in advance -- same reasoning as foundry-push-routes.
 * test.mjs's own setInterval fake watcher) until at least one op appears,
 * answers every op in that batch ok:true, then clears the ops file --
 * exactly what "Foundry applied it" looks like from the store's point of
 * view. Returns the interval handle so a caller can clearInterval() it as a
 * safety net once its own await resolves.
 */
function armWatcher(world, { intervalMs = 20 } = {}) {
  const iv = setInterval(() => {
    const ops = readOps(world);
    if (!ops.length) return;
    clearInterval(iv);
    const results = ops.map((o) => ({ opId: o.opId, ok: true, foundryUuid: o.data?.sceneUuid ?? `Scene.e2e-${o.opId}` }));
    writeFileSync(resultsPath(world), JSON.stringify(results), "utf8");
    writeFileSync(opsPath(world), "[]", "utf8");
  }, intervalMs);
  return iv;
}

async function waitUntil(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

async function pushSceneViaFetch(sceneId) {
  const res = await fetch(`${base}/api/foundry/push-scene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId, mapSrc: "scenes/e2e-fixture.webp" })
  });
  return res.json();
}

test("Activate (Prep + Run), unstage's Foundry-removal offer, and a confirmed Remove clearing the ref", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  await primeWorldSelection(page, base, WORLD);

  // --- push-scene a fixture scene via route (arm watcher) ---
  const sceneA = await createSceneViaRoute(base, WORLD, { objectiveNote: "Lifecycle e2e scene A" });
  let watcher = armWatcher(WORLD);
  const pushResult = await pushSceneViaFetch(sceneA.id);
  clearInterval(watcher);
  assert.equal(pushResult.status, "applied", `push must apply -- got ${JSON.stringify(pushResult)}`);
  assert.equal(pushResult.ok, true, `push must confirm ok -- got ${JSON.stringify(pushResult)}`);
  assert.ok(pushResult.foundryUuid, "push must return a real foundryUuid");

  // Seed stagedForFoundry:true directly (phase36-fixture's own seedSceneStaged
  // raw-fs convention) so the Prep toggle starts CHECKED without going
  // through the /stage route -- that route restamps `updatedAt`, which for
  // an already-pushed scene would make it look dirty and schedule an
  // unwanted auto-flush right when this test needs the ops channel quiet.
  const afterPush = getScene(WORLD, sceneA.id);
  seedSceneStaged(WORLD, sceneA.id, {
    stagedForFoundry: true,
    lastPushedAt: afterPush.lastPushedAt,
    foundrySceneRef: afterPush.foundrySceneRef
  });

  // --- Activate button + "in Foundry" pill appear on the Prep chip row ---
  await page.goto(`${base}/#planner/scene/${sceneA.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneA.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-activate-foundry-btn"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="scene-in-foundry-pill"]').waitFor({ state: "visible", timeout: 5000 });

  // --- the SAME affordance appears in the Run header (a different testid) ---
  await page.locator('[data-testid="mode-run-btn"]').click();
  await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="run-activate-foundry-btn"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="run-in-foundry-pill"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="mode-prep-btn"]').click();
  await root.waitFor({ state: "visible", timeout: 10000 });

  // --- click Activate (Prep) -> the ops file carries an activate_scene op ---
  await page.locator('[data-testid="scene-activate-foundry-btn"]').click();
  const gotActivate = await waitUntil(() => readOps(WORLD).some((o) => o.kind === "activate_scene"));
  assert.ok(gotActivate, `expected the Activate click to write an activate_scene op -- ops on disk: ${JSON.stringify(readOps(WORLD))}`);
  // No watcher answers this one on purpose (the required scenario only
  // checks the op landed) -- clear it by hand so the pending request settles
  // quickly and the channel is quiet again for the next step.
  writeFileSync(resultsPath(WORLD), "[]", "utf8");
  writeFileSync(opsPath(WORLD), "[]", "utf8");

  // --- unstage (flip-only) -> the inline, non-modal offer line appears ---
  const stageToggle = page.locator('[data-testid="scene-stage-toggle"]');
  await stageToggle.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await stageToggle.getAttribute("data-staged"), "true", "seeded staged:true -- the toggle must reflect it on load");
  await stageToggle.click(); // -> unstage
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scene-stage-toggle"]')?.getAttribute("data-staged") === "false",
    { timeout: 10000 }
  );
  const offer = page.locator('[data-testid="scene-unstage-foundry-offer"]');
  await offer.waitFor({ state: "visible", timeout: 10000 });

  // --- Remove from Foundry… -> a real confirm() dialog -> ref cleared ---
  watcher = armWatcher(WORLD);
  await offer.locator('[data-testid="scene-unstage-remove-foundry-btn"]').click();
  const cleared = await waitUntil(() => !getScene(WORLD, sceneA.id).foundrySceneRef);
  clearInterval(watcher);
  assert.ok(cleared, "expected the confirmed Remove from Foundry to clear the scene's foundrySceneRef (asserted via a fresh scene GET-equivalent read)");
  assert.ok(dialogs.some((m) => /remove/i.test(m)), `expected a real confirm() dialog to fire for the Remove action -- saw: ${JSON.stringify(dialogs)}`);

  await page.close();
});

test("Settings stale-scene sweep: deleting a pushed scene WITHOUT the checkbox orphans it; the sweep removes it and the panel empties", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  page.on("dialog", async (d) => { await d.accept(); });
  await primeWorldSelection(page, base, WORLD);

  const sceneB = await createSceneViaRoute(base, WORLD, { objectiveNote: "Lifecycle e2e scene B" });
  let watcher = armWatcher(WORLD);
  const pushResult = await pushSceneViaFetch(sceneB.id);
  clearInterval(watcher);
  assert.equal(pushResult.status, "applied", `scene B push must apply -- got ${JSON.stringify(pushResult)}`);
  assert.equal(pushResult.ok, true);

  // Delete scene B via the real planner-rail flow, leaving "Also remove the
  // pushed Foundry scene" UNCHECKED (default OFF) -- the orphan-capture path.
  await page.goto(`${base}/#planner/plans`);
  const item = page.locator(`[data-testid="shell-scene-library-item"][data-scene-id="${sceneB.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.locator('[data-testid="shell-scene-library-item-delete-btn"]').click();
  const confirmPanel = item.locator(`[data-testid="shell-scene-library-item-delete-confirm-panel"][data-scene-id="${sceneB.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  const alsoCheckbox = confirmPanel.locator('[data-testid="scene-delete-also-foundry"]');
  await alsoCheckbox.waitFor({ state: "visible", timeout: 5000 });
  assert.ok(!(await alsoCheckbox.isChecked()), "the 'also remove from Foundry' checkbox must default OFF");
  await confirmPanel.locator('[data-testid="shell-scene-library-item-delete-confirm-btn"]').click();
  await page.waitForFunction(
    (id) => document.querySelectorAll(`[data-testid="shell-scene-library-item"][data-scene-id="${id}"]`).length === 0,
    sceneB.id,
    { timeout: 10000 }
  );

  // Settings' "Foundry scene cleanup" panel lists it as an orphan.
  await page.goto(`${base}/#settings`);
  const stalePanel = page.locator('[data-testid="stale-scenes-panel"]');
  await stalePanel.waitFor({ state: "visible", timeout: 10000 });
  const row = stalePanel.locator('[data-testid="stale-scene-row"][data-kind="orphan"]');
  await row.waitFor({ state: "visible", timeout: 10000 });

  // Sweep removes it (arm watcher) -> the panel empties to the honest empty state.
  watcher = armWatcher(WORLD);
  await row.locator('input[type="checkbox"]').check();
  await stalePanel.locator('[data-testid="stale-scenes-remove-btn"]').click();
  await stalePanel.locator('[data-testid="stale-scenes-empty"]').waitFor({ state: "visible", timeout: 15000 });
  clearInterval(watcher);
  assert.equal(await stalePanel.locator('[data-testid="stale-scene-row"]').count(), 0, "no stale rows must remain once the sweep confirms removal");

  await page.close();
});
