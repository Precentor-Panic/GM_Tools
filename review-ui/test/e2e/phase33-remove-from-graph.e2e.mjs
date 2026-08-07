// Phase 33 task 33.0 -- QE-first e2e contract for Part B of the design record
// (`.claude/plans/ok-i-m-back-with-dazzling-newt.md` -- read that first): a
// "Remove from graph" action in the World node inspector, recycling the
// dead `wv-inspector-openfull` span slot (`world-view.js:760`, currently an
// inert `<span>Open full page →</span>`, no handler/cursor -- de-advertised
// in Phase 31, never wired).
//
// DECISIONS LOCKED (Russell, 2026-08-06/07): guarded delete
// (`deleteNodeOp`, `wf-mcp-server/lib/manual-edit-ops.mjs:465`) --
// warn-and-leave-references by DEFAULT, with an explicit opt-in checkbox
// "also remove it from all N scenes" (unchecked by default).
//
// ===========================================================================
// CONTRACT THIS FILE LOCKS (33.2 implements to match -- exact testids/shapes
// chosen here per this task's own charter: "pick + document"):
// ===========================================================================
//   - `[data-testid="world-remove-from-graph-btn"][data-entity-id]` --
//     occupies the `.wv-inspector-openfull` slot in the inspector header
//     (`world-view.js:760`). Click opens the confirm panel below.
//   - `[data-testid="world-remove-from-graph-confirm-panel"][data-entity-id]
//     [data-cascade-edge-count]` -- the guarded confirm. Unlike the
//     beyond-room-drawer precedent this mirrors the NAMING of
//     (`data-cascade-edge-count`, `session-planner-view.js`'s
//     `buildBeyondRoomDrawer`, which only learns the count AFTER the
//     destructive DELETE call completes), THIS panel shows the cascade-edge
//     count BEFORE the delete: `deleteNodeOp`'s cascade set is simply "every
//     edge where entityId is source or target"
//     (`manual-edit-ops.mjs:470`) -- data the World surface's OWN already-
//     loaded graph cache can compute client-side with zero extra route call,
//     so warning with the real number pre-delete is strictly better UX than
//     the beyond-room drawer's post-hoc reveal, and is what "warns with a
//     cascade-edge count" (this task's own charter text) calls for. Its
//     `textContent` must also read "used in N scene(s)" (N from the
//     ALREADY-LOADED `scenesForEntity` appearances the inspector's own
//     "Appears in" section already fetches -- `world-view.js:814`).
//   - `[data-testid="world-remove-from-graph-confirm-btn"]` (danger) /
//     `[data-testid="world-remove-from-graph-cancel-btn"]` -- mirrors the
//     beyond-room-drawer's confirm/cancel pair naming.
//   - `[data-testid="world-remove-from-all-scenes-checkbox"]` -- the opt-in,
//     UNCHECKED by default (warn-and-leave-references is the default per the
//     locked decision).
//   - Confirming (checkbox OFF): `DELETE /api/graph/nodes/:entityId` fires;
//     the node's row disappears from `[data-testid="world-tree"]` via a
//     FRESH render (not a stale DOM snapshot -- polled via
//     `page.waitForFunction`); a scene that referenced it via a `kind:
//     "graph"` element still exists, and that element's row still renders on
//     the Planner scene page (dangling `graphEntityId` tolerated per
//     `session-planner-view.js:1181/2761`).
//   - Confirming (checkbox ON): additionally strips the node's `kind:"graph"`
//     elements from every scene that referenced it (asserted via a fresh
//     `GET .../elements` on the seeded scene) BEFORE/around the same delete.
//     The NEW backend piece this needs (`removeEntityFromAllScenes` + a
//     route) does not exist yet -- pinned below as a dedicated route-level
//     test asserting today's real 404 (server.mjs's generic
//     "No route: METHOD path" fallback), per this task's own charter ("a
//     real 404 IS acceptable red"). Chosen route shape for 33.2 to match:
//     `POST /api/graph/nodes/:entityId/remove-from-scenes { world }`.
//
// EXPECTED-RED reasons (today's build): NONE of `world-remove-from-graph-
// btn` / `-confirm-panel` / `-confirm-btn` / `-cancel-btn` / `-checkbox`
// exist anywhere -- `world-view.js:760` renders only the inert
// `wv-inspector-openfull` span. Every UI-level test below times out locating
// the button (a clean, specific selector-not-found reason, not a fixture
// error) -- confirmed by direct run, quoted in this task's own completion
// report.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p33b-");
const WORLD = "e2e-p33b-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p33b-root", name: "The Salt Cistern", type: "place", importance: 0.6 } },
  // p33b-node: used by the button-presence + confirm-panel + cancel tests
  // (never deleted, so it's safe to select repeatedly across tests).
  { op: "upsert_entity", data: { id: "p33b-node", name: "Corwin Ashgrave", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "p33b-friend", name: "Wren Voss", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p33b-e-node-root", sourceId: "p33b-node", targetId: "p33b-root", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "p33b-e-node-friend", sourceId: "p33b-node", targetId: "p33b-friend", relationshipType: "ally" } },
  // p33b-nodeA: dedicated to the checkbox-OFF delete test (destructive).
  { op: "upsert_entity", data: { id: "p33b-nodeA", name: "Hale Duskmere", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p33b-e-nodeA-root", sourceId: "p33b-nodeA", targetId: "p33b-root", relationshipType: "containment" } },
  // p33b-nodeB: dedicated to the checkbox-ON delete test (destructive).
  { op: "upsert_entity", data: { id: "p33b-nodeB", name: "Ione Marrow", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p33b-e-nodeB-root", sourceId: "p33b-nodeB", targetId: "p33b-root", relationshipType: "containment" } }
]);

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

async function attachNodeAsElement(sceneId, entityId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/from-graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, entityId })
  });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, `fixture setup: attaching a graph element must succeed (existing, shipped route) -- got ${res.status}: ${JSON.stringify(body)}`);
  return body.element;
}

async function fetchSceneElements(sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements?world=${encodeURIComponent(WORLD)}`);
  const body = await res.json();
  return body.elements || [];
}

// ---------------------------------------------------------------------------
// 1. The recycled slot: a "Remove from graph" button, not the dead span.
// ---------------------------------------------------------------------------
test('World inspector: selecting a node renders a "Remove from graph" button in the recycled "Open full page" slot', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p33b-node`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p33b-node"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  await inspector
    .locator('[data-testid="world-remove-from-graph-btn"][data-entity-id="p33b-node"]')
    .waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

// ---------------------------------------------------------------------------
// 2. Guarded confirm: cascade-edge-count + used-in-N-scenes + opt-in
//    checkbox, unchecked by default.
// ---------------------------------------------------------------------------
test('clicking "Remove from graph" opens a guarded confirm panel warning the REAL cascade-edge count and used-in-N-scenes count, with an opt-in "remove from all scenes" checkbox that defaults UNCHECKED', async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p33b-root" });
  await attachNodeAsElement(scene.id, "p33b-node");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p33b-node`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p33b-node"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  await inspector.locator('[data-testid="world-remove-from-graph-btn"]').click();

  const panel = page.locator('[data-testid="world-remove-from-graph-confirm-panel"][data-entity-id="p33b-node"]');
  await panel.waitFor({ state: "visible", timeout: 10000 });

  // p33b-node has exactly 2 edges touching it (containment -> root, ally ->
  // friend) -- the SAME edge set deleteNodeOp will cascade
  // (manual-edit-ops.mjs:470's `e.sourceId === entityId || e.targetId ===
  // entityId` filter), so the panel's warning must read 2, not a placeholder.
  assert.equal(
    await panel.getAttribute("data-cascade-edge-count"),
    "2",
    `the confirm panel must warn with the REAL cascade-edge count (2 edges touch p33b-node) -- got ${await panel.getAttribute("data-cascade-edge-count")}`
  );
  assert.match(
    (await panel.textContent()) || "",
    /used in 1 scene/i,
    'the confirm panel must warn how many scenes reference this node ("used in 1 scene(s)"), sourced from the already-loaded scenesForEntity appearances'
  );

  await page.locator('[data-testid="world-remove-from-graph-confirm-btn"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="world-remove-from-graph-cancel-btn"]').waitFor({ state: "visible", timeout: 5000 });

  const checkbox = page.locator('[data-testid="world-remove-from-all-scenes-checkbox"]');
  await checkbox.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    await checkbox.isChecked(),
    false,
    'the opt-in "remove from all scenes" checkbox must default UNCHECKED (warn-and-leave-references is the locked default)'
  );
  await page.close();
});

// ---------------------------------------------------------------------------
// 3. Cancel closes the panel and performs NO delete.
// ---------------------------------------------------------------------------
test('"Cancel" in the confirm panel closes it without deleting the node', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p33b-node`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p33b-node"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  await inspector.locator('[data-testid="world-remove-from-graph-btn"]').click();
  const panel = page.locator('[data-testid="world-remove-from-graph-confirm-panel"][data-entity-id="p33b-node"]');
  await panel.waitFor({ state: "visible", timeout: 10000 });

  await page.locator('[data-testid="world-remove-from-graph-cancel-btn"]').click();
  await panel.waitFor({ state: "hidden", timeout: 5000 }).catch(async () => {
    assert.equal(await panel.count(), 0, "Cancel must close (remove or hide) the confirm panel");
  });

  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(graph.nodes.some((n) => n.id === "p33b-node"), "Cancel must NOT delete the node -- it must still be a real graph node");
  await page.close();
});

// ---------------------------------------------------------------------------
// 4. Confirm, checkbox OFF: guarded delete, warn-and-leave-references.
// ---------------------------------------------------------------------------
test("confirming with the opt-in checkbox OFF deletes the node via DELETE /api/graph/nodes/:entityId -- it disappears from the World tree (fresh render), and a scene that referenced it still renders the now-dangling element (warn-and-leave-references default)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p33b-root" });
  const element = await attachNodeAsElement(scene.id, "p33b-nodeA");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p33b-nodeA`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p33b-nodeA"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  await inspector.locator('[data-testid="world-remove-from-graph-btn"]').click();
  await page.locator('[data-testid="world-remove-from-graph-confirm-panel"][data-entity-id="p33b-nodeA"]').waitFor({ state: "visible", timeout: 10000 });

  // Checkbox left OFF (default) -- straight confirm.
  await page.locator('[data-testid="world-remove-from-graph-confirm-btn"]').click();

  // The tree re-renders and the row is REALLY gone (polled, not a stale snapshot).
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="world-tree-row"][data-entity-id="p33b-nodeA"]'),
    null,
    { timeout: 10000 }
  );

  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(!graph.nodes.some((n) => n.id === "p33b-nodeA"), "the node must be REALLY deleted from the graph (DELETE /api/graph/nodes/:entityId), not just hidden client-side");

  // The scene that referenced it still exists, and its element row still
  // renders -- checkbox was OFF, so the dangling reference is left alone
  // (session-planner-view.js already tolerates a graphEntityId with no node).
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`[data-testid="scene-element-row"][data-element-id="${element.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

// ---------------------------------------------------------------------------
// 5. Confirm, checkbox ON: guarded delete PLUS scene-reference cleanup.
// ---------------------------------------------------------------------------
test('confirming with the opt-in "also remove from all N scenes" checkbox ON deletes the node AND strips its kind:"graph" elements from every scene that referenced it', async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p33b-root" });
  await attachNodeAsElement(scene.id, "p33b-nodeB");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p33b-nodeB`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p33b-nodeB"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  await inspector.locator('[data-testid="world-remove-from-graph-btn"]').click();
  await page.locator('[data-testid="world-remove-from-graph-confirm-panel"][data-entity-id="p33b-nodeB"]').waitFor({ state: "visible", timeout: 10000 });

  await page.locator('[data-testid="world-remove-from-all-scenes-checkbox"]').check();
  await page.locator('[data-testid="world-remove-from-graph-confirm-btn"]').click();

  await page.waitForFunction(
    () => !document.querySelector('[data-testid="world-tree-row"][data-entity-id="p33b-nodeB"]'),
    null,
    { timeout: 10000 }
  );

  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(!graph.nodes.some((n) => n.id === "p33b-nodeB"), "the node must be REALLY deleted from the graph");

  const elements = await fetchSceneElements(scene.id);
  assert.ok(
    !elements.some((e) => e.kind === "graph" && e.graphEntityId === "p33b-nodeB"),
    'opting in to "remove from all scenes" must ALSO strip the node\'s kind:"graph" elements from every scene that referenced it -- a fresh GET .../elements must no longer contain one'
  );
  await page.close();
});

// ---------------------------------------------------------------------------
// 6. Route-level: pins the NEW route the opt-in cleanup needs, which does
//    not exist yet -- a real 404 is the expected, documented red here.
// ---------------------------------------------------------------------------
test("route-level: POST /api/graph/nodes/:entityId/remove-from-scenes (the chosen contract for the NEW removeEntityFromAllScenes op 33.2 wires) does not exist yet -- today's real server 404 fallback", async () => {
  const res = await fetch(`${base}/api/graph/nodes/${encodeURIComponent("p33b-node")}/remove-from-scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD })
  });
  const body = await res.json().catch(() => null);
  assert.equal(
    res.status,
    404,
    `no route wires removeEntityFromAllScenes yet -- expected the server's generic "No route: METHOD path" 404 fallback (server.mjs's final handler), got ${res.status}: ${JSON.stringify(body)}`
  );
});
