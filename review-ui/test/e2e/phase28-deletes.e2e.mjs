// Phase 28 task 28.0 -- Deletes: delete-plan (new route + UI, scenes
// survive) and guarded delete-node-from-graph (warns if referenced, via the
// scene page's "beyond this room" drawer). The other two delete verbs are
// covered elsewhere: remove-from-plan is covered by
// phase28-navigation-spine.e2e.mjs (its own §2 scenario, since it's a
// `#plans/<planId>` row action); delete-scene is the EXISTING, unchanged
// Scenes-tab flow, kept green by the (trimmed, not retired) scene-delete
// .e2e.mjs. Read phase28-fixture.mjs's header FIRST (§9/§10 are this file's
// own sections). EXPECTED TO FAIL right now: `DELETE /api/scene-planning/
// plans/:planId` doesn't exist yet (real 404); `#plans`/`#session-planner/
// <sceneId>`'s new "beyond this room" drawer don't exist in the DOM yet
// either. Both failure shapes are the deliverable of this task.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase28Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  deletePlanViaRoute,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase28-fixture.mjs";

const { scratchDir, dataDir } = setupPhase28Env("gm-tools-e2e-deletes-");
const WORLD = "e2e-deletes-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "del-place-a", name: "Blackmarsh Waystation", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "del-neighbor-unreferenced", name: "An unremarkable signpost", type: "object", importance: 0.2 } },
  { op: "upsert_entity", data: { id: "del-neighbor-referenced", name: "A referenced shrine", type: "place", importance: 0.3 } },
  { op: "upsert_entity", data: { id: "del-neighbor-other-side", name: "Something else entirely", type: "place", importance: 0.2 } },
  { op: "upsert_edge", data: { id: "del-edge-scene-to-unref", sourceId: "del-place-a", targetId: "del-neighbor-unreferenced", relationshipType: "adjacent" } },
  { op: "upsert_edge", data: { id: "del-edge-scene-to-ref", sourceId: "del-place-a", targetId: "del-neighbor-referenced", relationshipType: "adjacent" } },
  // A SECOND edge on del-neighbor-referenced (from something other than the
  // scene's own anchor) so deleting it genuinely cascades >1 edge --
  // proving the "warns if referenced elsewhere" contract against the
  // engine's real cascadeEdgeCount, not a guess.
  { op: "upsert_edge", data: { id: "del-edge-other-to-ref", sourceId: "del-neighbor-other-side", targetId: "del-neighbor-referenced", relationshipType: "adjacent" } }
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

test("ROUTE LEVEL: DELETE /api/scene-planning/plans/:planId removes ONLY the plan record -- its scenes survive, still fetchable and still members of any OTHER plan", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "del-place-a" });
  const doomedPlan = await createPlanViaRoute(base, WORLD, "Doomed Plan");
  const survivingPlan = await createPlanViaRoute(base, WORLD, "Surviving Sibling Plan");
  await addSceneToPlanViaRoute(base, WORLD, doomedPlan.id, scene.id);
  await addSceneToPlanViaRoute(base, WORLD, survivingPlan.id, scene.id);

  const { status, body } = await deletePlanViaRoute(base, WORLD, doomedPlan.id);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.deleted, true);

  const listRes = await (await fetch(`${base}/api/scene-planning/plans?world=${WORLD}`)).json();
  assert.ok(!listRes.plans.some((p) => p.id === doomedPlan.id), "the deleted plan must be genuinely gone from the world's plan list");

  const sceneRes = await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.equal(sceneRes.status, 200, "deleting a plan must never delete any scene it referenced");

  const survivingAfter = await (await fetch(`${base}/api/scene-planning/plans/${survivingPlan.id}?world=${WORLD}`)).json();
  assert.ok(survivingAfter.plan.sceneIds.includes(scene.id), "the SAME scene's membership in an untouched sibling plan must be completely unaffected");

  const { status: idempotentStatus } = await deletePlanViaRoute(base, WORLD, doomedPlan.id);
  assert.notEqual(idempotentStatus, 500, "deleting an already-deleted plan must not crash the server");
});

test("UI: the plan shelf's delete-btn requires a real confirm step before calling the route", async () => {
  const plan = await createPlanViaRoute(base, WORLD, "Shelf Delete UI Check");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#plans`);

  const item = page.locator(`[data-testid="plan-shelf-item"][data-plan-id="${plan.id}"]`);
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.locator('[data-testid="plan-shelf-delete-btn"]').click();

  const confirmPanel = item.locator(`[data-testid="plan-shelf-delete-confirm-panel"][data-plan-id="${plan.id}"]`);
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });

  // Not yet deleted merely from clicking delete -- confirm is required.
  const stillThere = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.ok(stillThere.plan, "clicking delete (before confirming) must not have called the route yet");

  await confirmPanel.locator('[data-testid="plan-shelf-delete-confirm-btn"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="plan-shelf-item"][data-plan-id="${id}"]`).length === 0,
      plan.id,
      { timeout: 10000 }
    );
  }, "confirming must remove the plan-shelf-item from the DOM");
  await page.close();
});

test("guarded delete-node-from-graph: reached from the scene page's 'beyond this room' drawer, requires a real confirm, and the resulting status reflects the ENGINE's own real cascadeEdgeCount (warns if referenced)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "del-place-a" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await root.locator('[data-testid="beyond-room-drawer-toggle"]').click();
  const drawer = page.locator(`[data-testid="beyond-room-drawer"][data-scene-id="${scene.id}"]`);
  await drawer.waitFor({ state: "visible", timeout: 5000 });

  const refItem = drawer.locator('[data-testid="beyond-room-neighbor-item"][data-entity-id="del-neighbor-referenced"]');
  await refItem.waitFor({ state: "visible", timeout: 10000 });
  await refItem.locator('[data-testid="beyond-room-neighbor-delete-btn"]').click();

  const confirmPanel = drawer.locator('[data-testid="beyond-room-neighbor-delete-confirm-panel"][data-entity-id="del-neighbor-referenced"]');
  await confirmPanel.waitFor({ state: "visible", timeout: 5000 });

  // Not yet deleted merely from clicking delete -- a real confirm is required.
  let graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(graph.nodes.some((n) => n.id === "del-neighbor-referenced"), "clicking delete (before confirming) must not have called the real delete route yet");

  await confirmPanel.locator('[data-testid="beyond-room-neighbor-delete-confirm-btn"]').click();

  const status = drawer.locator('[data-testid="beyond-room-neighbor-delete-status"]');
  await status.waitFor({ state: "visible", timeout: 10000 });
  const cascadeCount = Number(await status.getAttribute("data-cascade-edge-count"));
  assert.ok(cascadeCount >= 1, "deleting a node that had other edges must report a real, non-zero cascadeEdgeCount -- the 'warns if referenced elsewhere' contract, sourced from the engine's own real response, not a guess");

  graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(!graph.nodes.some((n) => n.id === "del-neighbor-referenced"), "confirming must actually call the real DELETE /api/graph/nodes/:entityId route -- the node is genuinely gone");
  await page.close();
});
