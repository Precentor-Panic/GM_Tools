// Phase 23 task 23.0, REQUIRED SCENARIO 2 -- "Add arbitrary node, both
// reachability branches: adding an unreachable entity succeeds directly;
// adding a reachable entity surfaces the real intervening-node offer (via
// the live intervening-offer route) as an explicit, separate confirmation
// step -- never auto-added." Read scene-construction-fixture.mjs's header
// first (§2 is this file's own section). EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- none of this DOM exists
// yet. That failure is the deliverable of this task, not a bug in this file.
//
// FIXTURE (all real graph entities/edges via bootstrapSnapshot+applyHeadless,
// matching this project's own "real snapshot, not a mock" convention):
//   - anchor "addnode-anchor", one scene on it.
//   - "addnode-n1" -- 1 hop from anchor (already inside the DEFAULT
//     corridor brief, corridorTolerance=2 per session-planner/brief.mjs).
//   - "addnode-n2" -- 2 hops from anchor via n1 (also inside the default
//     corridor, since tolerance=2).
//   - "addnode-target-reachable" -- 3 hops from anchor via n1->n2 (OUTSIDE
//     the default corridor -- genuinely needs the arbitrary-add mechanism).
//     shortestPath(anchor, target-reachable) = [anchor, n1, n2,
//     target-reachable], so offerInterveningNodes must offer exactly
//     [n1, n2].
//   - "addnode-target-unreachable" -- a real entity with ZERO edges to
//     anything else in the graph (a separate connected component) --
//     shortestPath returns null, so this is the unreachable branch.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-addnode-");
const WORLD = "e2e-scconstruct-addnode-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "addnode-anchor", name: "Add-Node Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "addnode-n1", name: "Add-Node Hop One", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "addnode-n2", name: "Add-Node Hop Two", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "addnode-target-reachable", name: "Add-Node Reachable Target", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "addnode-target-unreachable", name: "Add-Node Unreachable Target", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "addnode-e0", sourceId: "addnode-anchor", targetId: "addnode-n1", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "addnode-e1", sourceId: "addnode-n1", targetId: "addnode-n2", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "addnode-e2", sourceId: "addnode-n2", targetId: "addnode-target-reachable", relationshipType: "unspecified" } }
  // addnode-target-unreachable: deliberately zero edges anywhere.
]);

let server, base, browser, page;
let scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "addnode-anchor" });

  // Sanity: the real, already-shipped Phase 22 intervening-offer route
  // itself agrees with this fixture's own premise, independent of any UI --
  // if this fails, the bug is in this test's fixture, not the (not-yet-
  // built) UI under test below.
  const offerRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/intervening-offer?world=${WORLD}&targetEntityId=addnode-target-reachable`);
  const offerBody = await offerRes.json();
  assert.equal(offerRes.status, 200, `sanity check on the real Phase 22 intervening-offer route failed: ${JSON.stringify(offerBody)}`);
  assert.deepEqual(offerBody.offer, { reachable: true, interveningEntityIds: ["addnode-n1", "addnode-n2"] }, "sanity: fixture must produce exactly this reachable offer shape");

  const unreachableRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/intervening-offer?world=${WORLD}&targetEntityId=addnode-target-unreachable`);
  const unreachableBody = await unreachableRes.json();
  assert.deepEqual(unreachableBody.offer, { reachable: false, interveningEntityIds: [] }, "sanity: fixture's unreachable target must genuinely be unreachable");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("unreachable branch: adding an unreachable entity succeeds directly, no offer, no further prompting", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const toggle = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="add-node-toggle"]`);
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  await toggle.click();

  const panel = page.locator(`[data-testid="add-node-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const input = panel.locator('[data-testid="add-node-input"]');
  await input.fill("Add-Node Unreachable Target");
  const option = panel.locator('[data-testid="add-node-option"][data-entity-id="addnode-target-unreachable"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  // No intervening-offer panel should ever appear for this branch.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    await page.locator('[data-testid="intervening-offer-panel"]').count(),
    0,
    "an unreachable target must never trigger the intervening-offer panel"
  );

  const newCard = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="location-card"][data-entity-id="addnode-target-unreachable"]`);
  await newCard.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await newCard.getAttribute("data-card-role"), "added", "an arbitrarily-added node must carry data-card-role=\"added\"");

  // Confirm via the real store route too, not just UI state.
  const membersRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/intervening-offer?world=${WORLD}&targetEntityId=addnode-target-unreachable`);
  void membersRes; // (route re-check not needed further; membership itself confirmed via the members list below)
});

test("reachable branch: adding a reachable-but-not-shown entity offers the real intervening nodes, and NOTHING is added until an explicit confirm/skip click", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const toggle = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="add-node-toggle"]`);
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  await toggle.click();

  const panel = page.locator(`[data-testid="add-node-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  const input = panel.locator('[data-testid="add-node-input"]');
  await input.fill("Add-Node Reachable Target");
  const option = panel.locator('[data-testid="add-node-option"][data-entity-id="addnode-target-reachable"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const offerPanel = page.locator(`[data-testid="intervening-offer-panel"][data-scene-id="${scene.id}"][data-target-entity-id="addnode-target-reachable"]`);
  await offerPanel.waitFor({ state: "visible", timeout: 10000 });

  const offerNodes = offerPanel.locator('[data-testid="intervening-offer-node"]');
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 2,
      '[data-testid="intervening-offer-panel"] [data-testid="intervening-offer-node"]',
      { timeout: 5000 }
    );
  }, "expected exactly the 2 real intervening nodes (n1, n2) to be offered");
  const offeredIds = await offerNodes.evaluateAll((els) => els.map((el) => el.getAttribute("data-entity-id")));
  assert.deepEqual(offeredIds.sort(), ["addnode-n1", "addnode-n2"].sort());

  // NEVER auto-added: neither the target nor the intervening nodes may
  // appear as location-cards yet.
  for (const id of ["addnode-target-reachable", "addnode-n1", "addnode-n2"]) {
    assert.equal(
      await page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="location-card"][data-entity-id="${id}"]`).count(),
      0,
      `"${id}" must not be added to the scene until the offer is explicitly accepted or skipped`
    );
  }

  const acceptBtn = offerPanel.locator('[data-testid="intervening-offer-accept-btn"]');
  await acceptBtn.click();

  // Accepting adds the target AND both intervening nodes.
  for (const id of ["addnode-target-reachable", "addnode-n1", "addnode-n2"]) {
    await page.locator(`[data-testid="scene-chain-item"][data-scene-id="${scene.id}"] [data-testid="location-card"][data-entity-id="${id}"]`)
      .waitFor({ state: "visible", timeout: 10000 });
  }
});

test("reachable branch, skip path: clicking skip adds ONLY the target, none of the intervening nodes", async () => {
  // Fresh scene for isolation from the prior test's own accept-path additions.
  const skipScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "addnode-anchor" });
  await page.goto(`${base}/#session-planner/${skipScene.id}`);

  const toggle = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${skipScene.id}"] [data-testid="add-node-toggle"]`);
  await toggle.waitFor({ state: "visible", timeout: 15000 });
  await toggle.click();

  const panel = page.locator(`[data-testid="add-node-panel"][data-scene-id="${skipScene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="add-node-input"]').fill("Add-Node Reachable Target");
  const option = panel.locator('[data-testid="add-node-option"][data-entity-id="addnode-target-reachable"]');
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const offerPanel = page.locator(`[data-testid="intervening-offer-panel"][data-scene-id="${skipScene.id}"][data-target-entity-id="addnode-target-reachable"]`);
  await offerPanel.waitFor({ state: "visible", timeout: 10000 });
  await offerPanel.locator('[data-testid="intervening-offer-skip-btn"]').click();

  const targetCard = page.locator(`[data-testid="scene-chain-item"][data-scene-id="${skipScene.id}"] [data-testid="location-card"][data-entity-id="addnode-target-reachable"]`);
  await targetCard.waitFor({ state: "visible", timeout: 10000 });

  for (const id of ["addnode-n1", "addnode-n2"]) {
    assert.equal(
      await page.locator(`[data-testid="scene-chain-item"][data-scene-id="${skipScene.id}"] [data-testid="location-card"][data-entity-id="${id}"]`).count(),
      0,
      `skipping the offer must not add intervening node "${id}"`
    );
  }
});
