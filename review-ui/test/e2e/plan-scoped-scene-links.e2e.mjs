// Phase 27 task 27.0 -- "Plan-scoped link/unlink with graph push/break"
// (F4, F12). Read phase27-fixture.mjs's header FIRST (§3 is this file's own
// section). EXPECTED TO FAIL right now -- `plan-scene-links-list`/
// `plan-scene-link-item`/`plan-scene-link-toggle-btn`/`plan-scene-link-
// confirm-panel` don't exist yet (the CURRENT code still renders the OLD
// `buildConnectExistingSceneZone` green auto-link zone in this exact DOM
// position), and `linkScenes` doesn't accept/store a `graphEdgeId` yet
// (session-planner/scene-links.mjs, confirmed fresh against the real file).
// Both are the deliverable of this task, not a bug in this file.
//
// FIXTURE: three place entities with DELIBERATELY ZERO edges between any of
// them (mirrors scene-links-roundtrip.e2e.mjs's own "genuinely NOT
// graph-linked" fixture reasoning) -- so a graph edge appearing later can
// only be explained by this file's own "push a graph link" confirm step,
// never pre-existing adjacency.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase27Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase27-fixture.mjs";

const { scratchDir, dataDir } = setupPhase27Env("gm-tools-e2e-planlinks-");
const WORLD = "e2e-planlinks-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "planlinks-a", name: "Plan-Links Place A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "planlinks-b", name: "Plan-Links Place B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "planlinks-c", name: "Plan-Links Place C", type: "place", importance: 0.5 } }
  // deliberately: ZERO edges.
]);

let server, base, browser, page;
let sceneA, sceneB, sceneC, plan;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "planlinks-a" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "planlinks-b" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "planlinks-c" });
  plan = await createPlanViaRoute(base, WORLD, "Plan-Scoped Links Check");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneA.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneB.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneC.id);

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function openSceneItem(sceneId) {
  await page.goto(`${base}/#session-planner/plan/${plan.id}`);
  const item = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${sceneId}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });
  if (!(await item.evaluate((el) => el.open))) {
    await item.locator('[data-testid="scene-chain-toggle"]').click();
  }
  return item;
}

test("scenes in a plan start with NO links -- the other plan-scenes list shows every OTHER scene, all unlinked", async () => {
  const item = await openSceneItem(sceneA.id);
  const list = item.locator(`[data-testid="plan-scene-links-list"][data-scene-id="${sceneA.id}"]`);
  await list.waitFor({ state: "visible", timeout: 10000 });

  const bItem = list.locator(`[data-testid="plan-scene-link-item"][data-scene-id="${sceneB.id}"]`);
  const cItem = list.locator(`[data-testid="plan-scene-link-item"][data-scene-id="${sceneC.id}"]`);
  await bItem.waitFor({ state: "visible", timeout: 5000 });
  await cItem.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await bItem.getAttribute("data-linked"), "false", "a scene must start unlinked from every other scene in the plan (F4)");
  assert.equal(await cItem.getAttribute("data-linked"), "false", "a scene must start unlinked from every other scene in the plan (F4)");

  assert.equal(await item.locator('[data-testid="connect-existing-scene-list"]').count(), 0, "the OLD green auto-link zone must be gone from this scene's body");
});

test("LINK, choosing to push a graph edge: creates a real edge (addEdgeOp) and stores its id on the scene-link record", async () => {
  const item = await openSceneItem(sceneA.id);
  const bToggle = item.locator(`[data-testid="plan-scene-link-toggle-btn"][data-scene-id="${sceneB.id}"][data-linked="false"]`);
  await bToggle.waitFor({ state: "visible", timeout: 10000 });
  await bToggle.click();

  const confirmPanel = item.locator(`[data-testid="plan-scene-link-confirm-panel"][data-scene-id="${sceneA.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="plan-scene-link-graph-yes-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="plan-scene-link-item"][data-scene-id="${id}"]`)?.getAttribute("data-linked") === "true",
      sceneB.id,
      { timeout: 10000 }
    );
  }, "choosing to push a graph link must result in the two scenes showing as linked");

  const { snapshot } = loadSnapshot(dataDir, WORLD);
  const edge = snapshot.edges.find(
    (e) => (e.sourceId === "planlinks-a" && e.targetId === "planlinks-b") ||
           (e.sourceId === "planlinks-b" && e.targetId === "planlinks-a")
  );
  assert.ok(edge, "confirming the graph push must create a REAL graph edge between the two scenes' own anchor places");

  const linked = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  const entry = linked.linked.find((l) => l.sceneId === sceneB.id);
  assert.ok(entry, "the scene-link record itself must exist");
  assert.equal(entry.graphEdgeId, edge.id, "the scene-link record must store the SAME edge id the graph push actually created, so a later unlink can target it precisely");
});

test("UNLINK, choosing to break the graph link: deletes that SPECIFIC edge (deleteEdgeOp) and removes the scene-link", async () => {
  const item = await openSceneItem(sceneA.id);
  const bToggle = item.locator(`[data-testid="plan-scene-link-toggle-btn"][data-scene-id="${sceneB.id}"][data-linked="true"]`);
  await bToggle.waitFor({ state: "visible", timeout: 10000 });
  await bToggle.click();

  const confirmPanel = item.locator(`[data-testid="plan-scene-link-confirm-panel"][data-scene-id="${sceneA.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="plan-scene-link-break-yes-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="plan-scene-link-item"][data-scene-id="${id}"]`)?.getAttribute("data-linked") === "false",
      sceneB.id,
      { timeout: 10000 }
    );
  }, "confirming the graph break must result in the two scenes showing as unlinked again");

  const { snapshot } = loadSnapshot(dataDir, WORLD);
  const edge = snapshot.edges.find(
    (e) => (e.sourceId === "planlinks-a" && e.targetId === "planlinks-b") ||
           (e.sourceId === "planlinks-b" && e.targetId === "planlinks-a")
  );
  assert.ok(!edge, "confirming the graph break must delete the real graph edge, not just the scene-link record");

  const linked = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  assert.ok(!linked.linked.some((l) => l.sceneId === sceneB.id), "the scene-link record itself must be removed too");
});

test("LINK declining the graph push: links the scenes with NO graph edge at all (tied together in the plan, regardless of adjacency)", async () => {
  const item = await openSceneItem(sceneA.id);
  const cToggle = item.locator(`[data-testid="plan-scene-link-toggle-btn"][data-scene-id="${sceneC.id}"][data-linked="false"]`);
  await cToggle.waitFor({ state: "visible", timeout: 10000 });
  await cToggle.click();

  const { snapshot: before1 } = loadSnapshot(dataDir, WORLD);
  const edgeCountBefore = before1.edges.length;

  const confirmPanel = item.locator(`[data-testid="plan-scene-link-confirm-panel"][data-scene-id="${sceneA.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="plan-scene-link-graph-no-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="plan-scene-link-item"][data-scene-id="${id}"]`)?.getAttribute("data-linked") === "true",
      sceneC.id,
      { timeout: 10000 }
    );
  }, "declining the graph push must still link the two scenes");

  const { snapshot: after1 } = loadSnapshot(dataDir, WORLD);
  assert.equal(after1.edges.length, edgeCountBefore, "declining the graph push must create ZERO new edges");

  const linked = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  const entry = linked.linked.find((l) => l.sceneId === sceneC.id);
  assert.ok(entry, "the scene-link record must exist even with no graph edge");
  assert.ok(!entry.graphEdgeId, "a scene-link created without a graph push must carry no graphEdgeId");
});

test("UNLINK declining the graph break (when a graphEdgeId WAS stored): removes the scene-link only, the graph edge survives", async () => {
  // Re-establish a graph-backed link between A and B for this scenario.
  const item = await openSceneItem(sceneA.id);
  const bToggle = item.locator(`[data-testid="plan-scene-link-toggle-btn"][data-scene-id="${sceneB.id}"][data-linked="false"]`);
  await bToggle.waitFor({ state: "visible", timeout: 10000 });
  await bToggle.click();
  await item.locator(`[data-testid="plan-scene-link-confirm-panel"][data-scene-id="${sceneA.id}"] [data-testid="plan-scene-link-graph-yes-btn"]`).click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-scene-link-item"][data-scene-id="${id}"]`)?.getAttribute("data-linked") === "true",
    sceneB.id,
    { timeout: 10000 }
  );

  const { snapshot: before1 } = loadSnapshot(dataDir, WORLD);
  const edgeCountBefore = before1.edges.length;

  const bToggleLinked = item.locator(`[data-testid="plan-scene-link-toggle-btn"][data-scene-id="${sceneB.id}"][data-linked="true"]`);
  await bToggleLinked.click();
  const confirmPanel = item.locator(`[data-testid="plan-scene-link-confirm-panel"][data-scene-id="${sceneA.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
  await confirmPanel.locator('[data-testid="plan-scene-link-break-no-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="plan-scene-link-item"][data-scene-id="${id}"]`)?.getAttribute("data-linked") === "false",
      sceneB.id,
      { timeout: 10000 }
    );
  }, "declining the graph break must still remove the scene-link");

  const { snapshot: after1 } = loadSnapshot(dataDir, WORLD);
  assert.equal(after1.edges.length, edgeCountBefore, "declining the graph break must leave every existing edge completely untouched");
});
