// Phase 28 task 28.0 -- Wrap: scene-scoped note-intake proposals (mocked
// LLM at the route boundary) + element-to-graph promotion proposals, both
// review-gated (proposes, never auto-writes). Read phase28-fixture.mjs's
// header FIRST (§6/§7 are this file's own sections). EXPECTED TO FAIL right
// now: `#session-planner/<sceneId>` still renders the OLD chain view, so
// `[data-testid="wrap-toggle-btn"]` never appears; the route-level test
// gets a real 404 from `POST .../propose-updates` (session-planner/
// plan-updates.mjs has no `proposeUpdatesForScene` yet). Both failure
// shapes are the deliverable of this task, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase28Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  proposeUpdatesForSceneViaRoute,
  DESKTOP_VIEWPORT
} from "./phase28-fixture.mjs";

const { scratchDir, dataDir } = setupPhase28Env("gm-tools-e2e-wrap-");
const WORLD = "e2e-wrap-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
// proposeUpdatesForScene doesn't exist yet (it's part of what THIS suite
// contracts, §6 of phase28-fixture.mjs) -- so a real, reachable batch for
// the UI-level test below is seeded by calling the EXISTING, unmodified
// importWriteup() directly (the exact same delegation target 28.1's own
// proposeUpdatesForScene will call), mirroring post-session-graph-update
// .e2e.mjs's own established "mock the route, not the downstream batch"
// pattern -- never a hand-built review-state batch record.
const { importWriteup } = await import("../../../graph-import/writeup-import.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "wrap-place-a", name: "The Drowned Chapel", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;

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

test("ROUTE LEVEL: POST .../scenes/:sceneId/propose-updates does not exist yet (404), the new contract this suite locks in", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "wrap-place-a" });
  const { status } = await proposeUpdatesForSceneViaRoute(base, WORLD, scene.id);
  // Deliberately asserting the CURRENT (red) state -- once 28.1 builds this
  // route, this specific assertion is expected to need updating to a real
  // 200/shape check; that update is 28.1's own acceptance criterion, not
  // this task's.
  assert.equal(status, 404, "this locks in that the scene-scoped propose-updates route is genuinely new, not accidentally already present under a different name");
});

test("UI: Wrap opens an inline panel (no navigation); running note-intake (mocked route) surfaces a REAL, reachable review batch -- proposes, never auto-writes", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "wrap-place-a" });

  // A REAL batch, produced by calling the EXISTING, unmodified
  // importWriteup() in-process with an injected LLM client (the SAME
  // `client: {messages: {create}}` shape this project's own dozen+ other
  // LLM-mocking tests use) -- the exact delegation target 28.1's own
  // proposeUpdatesForScene will call. The page.route() mock below only
  // stands in for the (external, slow) HTTP round trip itself.
  const { entities, edges, entityTypes } = loadSnapshot(dataDir, WORLD).snapshot;
  const seedResult = await importWriteup(
    WORLD,
    "The party found a gaunt sexton tending the drowned chapel's crypt.",
    { entities, edges, entityTypes },
    {
      llmOpts: {
        client: {
          messages: {
            async create() {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    entities: [{ tempId: "e1", name: "A gaunt sexton", type: "person", description: "Tends the drowned chapel's crypt.", rationale: "Proposed from this scene's notes." }],
                    edges: [],
                    summary: "Wrap note-intake proposal."
                  })
                }],
                stop_reason: "end_turn"
              };
            }
          }
        }
      }
    }
  );
  const realBatchId = seedResult.batchId;
  assert.ok(realBatchId, "test setup itself must produce a real batchId -- broken test setup, not the thing under test");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.route(`**/api/scene-planning/scenes/${scene.id}/propose-updates`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId: realBatchId,
        mutationCount: 1,
        importSummary: { entitiesCreated: 1, entitiesMerged: 0, edgesCreated: 0 },
        suggestions: [],
        headline: "1 new entity proposed from this scene's notes."
      })
    })
  );

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await root.locator('[data-testid="wrap-toggle-btn"]').click();
  const panel = page.locator(`[data-testid="wrap-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  // Opening Wrap must not navigate away from the scene page.
  assert.equal(await page.evaluate(() => location.hash), `#session-planner/${scene.id}`);

  await panel.locator('[data-testid="wrap-note-intake-run-btn"]').click();
  const result = panel.locator('[data-testid="wrap-note-intake-result"]');
  await result.waitFor({ state: "visible", timeout: 10000 });
  const link = result.locator(`[data-testid="wrap-review-batch-link"][data-batch-id="${realBatchId}"]`);
  await link.waitFor({ state: "visible", timeout: 5000 });

  await link.click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction((id) => location.hash === `#review/${id}`, realBatchId, { timeout: 10000 });
  }, "clicking the proposed-batch link must navigate to the EXISTING, unmodified #review/<batchId> screen");

  // Proposing must never silently write -- the entity is still only PENDING.
  const graphRes = await fetch(`${base}/api/graph?world=${WORLD}&filter=all`);
  const { nodes } = await graphRes.json();
  assert.ok(!nodes.some((n) => n.name === "A gaunt sexton"), "a proposed-but-not-yet-accepted entity must NOT appear in the live graph -- review-gated, never auto-written");
  await page.close();
});

test("UI: Wrap's element-promotion checklist is pre-selected but requires an explicit confirm -- unchecking an item leaves it local while a checked sibling promotes", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "wrap-place-a" });
  const keep = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A guttering candle" });
  const promote = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A blood-stamped ledger" });
  const keepId = keep.body?.element?.id;
  const promoteId = promote.body?.element?.id;
  assert.ok(keepId && promoteId, "test setup requires element creation to succeed");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await root.locator('[data-testid="wrap-toggle-btn"]').click();
  const panel = page.locator(`[data-testid="wrap-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const promoteList = panel.locator(`[data-testid="wrap-promote-list"][data-scene-id="${scene.id}"]`);
  await promoteList.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await promoteList.locator('[data-testid="wrap-promote-item"]').count(), 2, "every scene-local element must appear as a promotion candidate");

  const keepCheckbox = promoteList.locator(`[data-testid="wrap-promote-checkbox"][data-element-id="${keepId}"]`);
  assert.equal(await keepCheckbox.isChecked(), true, "candidates must be pre-selected by default (skimmable, reject-easy)");

  // Merely rendering the checklist must not have promoted anything yet.
  const beforeConfirm = await listSceneElementsViaRoute(base, WORLD, scene.id);
  assert.ok(beforeConfirm.body.elements.every((e) => e.kind === "local"), "opening Wrap and seeing the checklist must not itself promote anything -- confirm is required");

  await keepCheckbox.uncheck();
  await panel.locator('[data-testid="wrap-promote-confirm-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="scene-element-row"][data-element-id="${id}"]`)?.getAttribute("data-kind") === "graph",
      promoteId,
      { timeout: 10000 }
    );
  }, "confirming must promote the still-CHECKED element");

  const after = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const keptEl = after.body.elements.find((e) => e.id === keepId);
  const promotedEl = after.body.elements.find((e) => e.id === promoteId);
  assert.equal(keptEl.kind, "local", "an UNCHECKED item must stay local even after confirming the batch");
  assert.equal(promotedEl.kind, "graph", "a CHECKED item must be promoted to graph on confirm");
  await page.close();
});
