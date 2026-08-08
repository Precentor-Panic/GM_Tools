// Phase 34 task 34.0 -- QE-first e2e contract, part 2: the delta-fixes on the
// two shipped surfaces (D4 named prev/next, D5-D8 hybrid remove-from-graph,
// D9-D12 cosmetics). Read phase34-fixture.mjs §5-§7 FIRST (the full contract
// this file locks in, including the reasoning for reusing vs introducing
// testids). Authored QE-first: every test below is RED against today's build
// (34.3 is what turns it green) for the reasons quoted in this task's own
// completion report.
//
// This file SUPERSEDES parts of phase33-remove-from-graph.e2e.mjs (the
// confirm-panel-specific assertions) -- see that file's own trimmed header
// for exactly what was retired and why, in the SAME commit as this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase34Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  fetchGraphViaRoute,
  removeReparentUpViaRoute,
  DESKTOP_VIEWPORT
} from "./phase34-fixture.mjs";

const { scratchDir, dataDir } = setupPhase34Env("gm-tools-e2e-p34delta-");
const WORLD = "e2e-p34delta-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p34d-root", name: "The Salt Cistern", type: "place", importance: 0.6 } },
  // --- D5-D8 fixture data ---
  // A 3-level containment chain root -> mid -> node -> {childA, childB}, so
  // deleting `node` must reparent its children to `mid` (NOT root, NOT
  // "become new roots") -- the genuine "reparent UP ONE LEVEL, not to root"
  // test this contract cares about.
  { op: "upsert_entity", data: { id: "p34d-mid", name: "The Under-Cistern", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "p34d-e-mid-root", sourceId: "p34d-mid", targetId: "p34d-root", relationshipType: "containment" } },
  // p34d-bare: the ALL-ZERO-COUNTS case -- no children, no non-containment
  // edges, not used in any scene.
  { op: "upsert_entity", data: { id: "p34d-bare", name: "Corwin Ashgrave", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p34d-e-bare-mid", sourceId: "p34d-bare", targetId: "p34d-mid", relationshipType: "containment" } },
  // p34d-node: the NONZERO-COUNTS case -- 2 children (K=2), 1 non-containment
  // edge (M=1), used in 1 scene (N=1, attached in the test body once the
  // scene exists).
  { op: "upsert_entity", data: { id: "p34d-node", name: "Ione Marrow", type: "person", importance: 0.4 } },
  { op: "upsert_edge", data: { id: "p34d-e-node-mid", sourceId: "p34d-node", targetId: "p34d-mid", relationshipType: "containment" } },
  { op: "upsert_entity", data: { id: "p34d-childA", name: "Wren Voss", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p34d-e-childA-node", sourceId: "p34d-childA", targetId: "p34d-node", relationshipType: "containment" } },
  { op: "upsert_entity", data: { id: "p34d-childB", name: "Hale Duskmere", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p34d-e-childB-node", sourceId: "p34d-childB", targetId: "p34d-node", relationshipType: "containment" } },
  { op: "upsert_entity", data: { id: "p34d-ally", name: "The Verdigris Compact", type: "faction", importance: 0.4 } },
  { op: "upsert_edge", data: { id: "p34d-e-node-ally", sourceId: "p34d-node", targetId: "p34d-ally", relationshipType: "ally" } },
  // p34d-nodeC / p34d-nodeD: dedicated destructive-execute fixtures (one per
  // execute test, so tests don't interfere with each other).
  { op: "upsert_entity", data: { id: "p34d-nodeC", name: "Rasha Tell", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p34d-e-nodeC-mid", sourceId: "p34d-nodeC", targetId: "p34d-mid", relationshipType: "containment" } },
  { op: "upsert_entity", data: { id: "p34d-childC", name: "Sorin Ashgrave", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p34d-e-childC-nodeC", sourceId: "p34d-childC", targetId: "p34d-nodeC", relationshipType: "containment" } },
  { op: "upsert_entity", data: { id: "p34d-nodeD", name: "Talia Reyne", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p34d-e-nodeD-mid", sourceId: "p34d-nodeD", targetId: "p34d-mid", relationshipType: "containment" } }
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
  assert.equal(res.status, 200, `fixture setup: attaching a graph element must succeed -- got ${res.status}: ${JSON.stringify(body)}`);
  return body.element;
}

async function fetchSceneElements(sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements?world=${encodeURIComponent(WORLD)}`);
  const body = await res.json();
  return body.elements || [];
}

// createSceneViaRoute (phase34-fixture.mjs's re-export) does NOT forward a
// `name` -- every scene it creates falls back to the anchor place's own name
// (resolveSceneDisplayName, app-shell.js:82-88), which is useless for D4's
// "distinct neighbor names" assertions when all scenes share one anchor. The
// underlying route DOES accept `name` (server.mjs:1570) -- this local helper
// uses it directly, D4-tests-only.
async function createNamedSceneViaRoute(name, locationEntityId) {
  const res = await fetch(`${base}/api/session-planner/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, locationEntityId, name })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `named-scene setup must succeed -- got ${res.status}: ${JSON.stringify(body)}`);
  return body.scene;
}

// ---------------------------------------------------------------------------
// D4: named prev/next + Start/End of plan disabled ends
// ---------------------------------------------------------------------------
test('D4: the scene page\'s prev/next controls render the NEIGHBOR SCENE\'S NAME, not generic "‹ Prev"/"Next ›"', async () => {
  const a = await createNamedSceneViaRoute("The Drowned Vault", "p34d-root");
  const b = await createNamedSceneViaRoute("The Gladiator Pit", "p34d-root");
  const c = await createNamedSceneViaRoute("The Under-Cistern Watch", "p34d-root");
  const plan = await createPlanViaRoute(base, WORLD, "D4 Plan");
  for (const s of [a, b, c]) await addSceneToPlanViaRoute(base, WORLD, plan.id, s.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${b.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${b.id}"]`).waitFor({ state: "visible", timeout: 15000 });

  const prevBtn = page.locator('[data-testid="scene-breadcrumb-prev-btn"]');
  const nextBtn = page.locator('[data-testid="scene-breadcrumb-next-btn"]');
  await prevBtn.waitFor({ state: "visible", timeout: 10000 });
  await nextBtn.waitFor({ state: "visible", timeout: 10000 });

  assert.equal((await prevBtn.textContent()).trim(), `← ${a.name}`, "prev button must read the ACTUAL previous scene's name, not generic text");
  assert.equal((await nextBtn.textContent()).trim(), `${c.name} →`, "next button must read the ACTUAL next scene's name, not generic text");
  await page.close();
});

test('D4: "Start of plan" / "End of plan" render DISABLED at the plan\'s ends (not omitted)', async () => {
  const a = await createSceneViaRoute(base, WORLD, { locationEntityId: "p34d-root" });
  const b = await createSceneViaRoute(base, WORLD, { locationEntityId: "p34d-root" });
  const plan = await createPlanViaRoute(base, WORLD, "D4 Ends Plan");
  for (const s of [a, b]) await addSceneToPlanViaRoute(base, WORLD, plan.id, s.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  // First scene: prev must be "Start of plan", disabled.
  await page.goto(`${base}/#planner/scene/${a.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${a.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  const startBtn = page.locator('[data-testid="scene-breadcrumb-prev-btn"]');
  await startBtn.waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await startBtn.textContent()).trim(), "Start of plan");
  assert.equal(await startBtn.isDisabled(), true, "the Start-of-plan prev control must be a real disabled control, not just omitted");
  const hashBefore = await page.evaluate(() => location.hash);
  await startBtn.click({ force: true }).catch(() => {});
  assert.equal(await page.evaluate(() => location.hash), hashBefore, "clicking the disabled Start-of-plan control must not navigate");

  // Last scene: next must be "End of plan", disabled.
  await page.goto(`${base}/#planner/scene/${b.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${b.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  const endBtn = page.locator('[data-testid="scene-breadcrumb-next-btn"]');
  await endBtn.waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await endBtn.textContent()).trim(), "End of plan");
  assert.equal(await endBtn.isDisabled(), true, "the End-of-plan next control must be a real disabled control, not just omitted");
  await page.close();
});

// ---------------------------------------------------------------------------
// D5-D8: HYBRID remove-from-graph
// ---------------------------------------------------------------------------
test('D5-D8: bare case (K=M=N=0) -- first click arms with JUST "remove — sure?", no consequence line, no checkbox', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p34d-bare`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p34d-bare"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  const btn = inspector.locator('[data-testid="world-remove-from-graph-btn"]');
  await btn.waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await btn.textContent()).trim(), "Remove from graph");

  await btn.click();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="world-remove-from-graph-btn"]')?.textContent || "").trim() === "remove — sure?",
    null,
    { timeout: 5000 }
  );
  assert.equal(
    await inspector.locator('[data-testid="world-remove-consequence-line"]').count(),
    0,
    "an all-zero-counts node must show NO consequence line -- bare arm only"
  );
  assert.equal(
    await inspector.locator('[data-testid="world-remove-from-all-scenes-checkbox"]').count(),
    0,
    "an all-zero-counts node must show NO opt-in checkbox"
  );

  // Node must still exist -- only ARMED, not yet deleted.
  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(graph.nodes.some((n) => n.id === "p34d-bare"), "arming must not delete anything");
  await page.close();
});

test('D5-D8: nonzero case -- first click arms AND shows "reparents K inside · drops M links · used in N scenes" + the opt-in checkbox (unchecked by default)', async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p34d-root" });
  await attachNodeAsElement(scene.id, "p34d-node");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p34d-node`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p34d-node"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  await inspector.locator('[data-testid="world-remove-from-graph-btn"]').click();
  const line = inspector.locator('[data-testid="world-remove-consequence-line"][data-entity-id="p34d-node"]');
  await line.waitFor({ state: "visible", timeout: 10000 });

  const text = (await line.textContent()) || "";
  assert.match(text, /reparents 2\b.*inside/i, `must warn 2 children reparent up -- got: "${text}"`);
  assert.match(text, /drops 1\b.*links?/i, `must warn 1 non-containment link drops -- got: "${text}"`);
  assert.match(text, /used in 1 scenes?/i, `must warn used-in-1-scene -- got: "${text}"`);

  const checkbox = inspector.locator('[data-testid="world-remove-from-all-scenes-checkbox"]');
  await checkbox.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await checkbox.isChecked(), false, 'the opt-in "remove from all scenes" checkbox must default UNCHECKED');
  await page.close();
});

test('D5-D8: clicking elsewhere in the inspector DISARMS -- label reverts, consequence line/checkbox disappear, no route call', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p34d-node`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p34d-node"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  const btn = inspector.locator('[data-testid="world-remove-from-graph-btn"]');
  await btn.click();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="world-remove-from-graph-btn"]')?.textContent || "").trim() === "remove — sure?",
    null,
    { timeout: 5000 }
  );

  await inspector.locator('[data-testid="world-inspector-appears-in"]').click({ force: true });
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="world-remove-from-graph-btn"]')?.textContent || "").trim() === "Remove from graph",
    null,
    { timeout: 5000 }
  );
  assert.equal(await inspector.locator('[data-testid="world-remove-consequence-line"]').count(), 0);

  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(graph.nodes.some((n) => n.id === "p34d-node"), "clicking elsewhere must NOT delete the node");
  await page.close();
});

test('D5-D8: second click EXECUTES -- children reparent to the GRANDPARENT (not root, not orphaned), the non-containment link drops, checkbox OFF leaves scene refs alone', async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p34d-root" });
  const element = await attachNodeAsElement(scene.id, "p34d-nodeC");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p34d-nodeC`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p34d-nodeC"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  const btn = inspector.locator('[data-testid="world-remove-from-graph-btn"]');
  await btn.click();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="world-remove-from-graph-btn"]')?.textContent || "").trim() === "remove — sure?",
    null,
    { timeout: 5000 }
  );
  // Checkbox left OFF (default).
  await btn.click();

  await page.waitForFunction(
    () => !document.querySelector('[data-testid="world-tree-row"][data-entity-id="p34d-nodeC"]'),
    null,
    { timeout: 10000 }
  );

  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(!graph.nodes.some((n) => n.id === "p34d-nodeC"), "the node must be REALLY deleted");
  const childEdge = (graph.edges || []).find((e) => e.sourceId === "p34d-childC" && e.relationshipType === "containment");
  assert.ok(childEdge, "the child must still have SOME containment edge (reparented, not orphaned)");
  assert.equal(childEdge.targetId, "p34d-mid", "the child must reparent to the GRANDPARENT (p34d-mid), one level up -- NOT become a new root");

  // Scene reference untouched (checkbox was OFF).
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`[data-testid="scene-element-row"][data-element-id="${element.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

test('D5-D8: checkbox ON also strips the node\'s scene references via the EXISTING (unchanged) remove-from-scenes route', async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p34d-root" });
  await attachNodeAsElement(scene.id, "p34d-nodeD");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p34d-nodeD`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="p34d-nodeD"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });

  const btn = inspector.locator('[data-testid="world-remove-from-graph-btn"]');
  await btn.click();
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="world-remove-from-graph-btn"]')?.textContent || "").trim() === "remove — sure?",
    null,
    { timeout: 5000 }
  );

  const checkbox = inspector.locator('[data-testid="world-remove-from-all-scenes-checkbox"]');
  // p34d-nodeD has no children/non-containment edges/scene usage EXCEPT the
  // scene we just attached -- N=1, so the checkbox is expected to render.
  await checkbox.waitFor({ state: "visible", timeout: 10000 });
  await checkbox.check();
  await btn.click();

  await page.waitForFunction(
    () => !document.querySelector('[data-testid="world-tree-row"][data-entity-id="p34d-nodeD"]'),
    null,
    { timeout: 10000 }
  );

  const graph = await fetchGraphViaRoute(base, WORLD);
  assert.ok(!graph.nodes.some((n) => n.id === "p34d-nodeD"), "the node must be REALLY deleted");

  const elements = await fetchSceneElements(scene.id);
  assert.ok(
    !elements.some((e) => e.kind === "graph" && e.graphEntityId === "p34d-nodeD"),
    "opting in must strip the node's kind:'graph' elements from every scene that referenced it"
  );
  await page.close();
});

test('route-level: POST /api/graph/nodes/:entityId/remove-reparent-up returns {entityId, reparentedChildren, droppedEdges} and children land on the GRANDPARENT', async () => {
  // Independent fixture data (route-level, no browser) -- reuse p34d-node's
  // tree shape via a dedicated node so this test doesn't collide with the UI
  // tests above (which already delete p34d-nodeC/p34d-nodeD via the UI).
  const seedRes = await fetch(`${base}/api/graph/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Route-Level Node", type: "person" })
  });
  const seeded = await seedRes.json();
  await fetch(`${base}/api/graph/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sourceId: seeded.entityId || seeded.id, targetId: "p34d-mid", relationshipType: "containment" })
  });
  const childRes = await fetch(`${base}/api/graph/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Route-Level Child", type: "person" })
  });
  const child = await childRes.json();
  const parentEntityId = seeded.entityId || seeded.id;
  await fetch(`${base}/api/graph/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sourceId: child.entityId || child.id, targetId: parentEntityId, relationshipType: "containment" })
  });

  const { status, body } = await removeReparentUpViaRoute(base, WORLD, parentEntityId);
  assert.equal(status, 200, `remove-reparent-up must be a real, wired route -- got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.entityId, parentEntityId);
  assert.equal(typeof body.reparentedChildren, "number");
  assert.equal(typeof body.droppedEdges, "number");
  assert.equal(body.reparentedChildren, 1);

  const graph = await fetchGraphViaRoute(base, WORLD);
  const childId = child.entityId || child.id;
  const childEdge = (graph.edges || []).find((e) => e.sourceId === childId && e.relationshipType === "containment");
  assert.ok(childEdge, "the child must have a containment edge after the op");
  assert.equal(childEdge.targetId, "p34d-mid", "the child must reparent to the grandparent, not become a root");
});

// ---------------------------------------------------------------------------
// D9-D12: cosmetics (presence-level)
// ---------------------------------------------------------------------------
test('D9: type-filter chips are ICON-ONLY -- no label-text child', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  const chip = page.locator(".wv-chip").first();
  await chip.waitFor({ state: "visible", timeout: 10000 });
  const childCount = await chip.evaluate((el) => el.children.length);
  assert.equal(childCount, 1, `an icon-only chip must have exactly ONE child (the glyph) -- got ${childCount} (label text still present)`);
  await page.close();
});

test('D10: the world search box is 220px wide', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-search"]').waitFor({ state: "visible", timeout: 15000 });
  const width = await page.locator('[data-testid="world-search"]').evaluate((el) => getComputedStyle(el).width);
  assert.equal(width, "220px", `world search box must be 220px wide -- got ${width}`);
  await page.close();
});

test('D12: the scene-tray hint copy is "Drop into a scene"', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/p34d-bare`);
  await page.locator('[data-testid="world-inspector"][data-entity-id="p34d-bare"]').waitFor({ state: "visible", timeout: 15000 });
  const hint = page.locator('[data-testid="world-scene-tray-hint"]');
  await hint.waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await hint.textContent()).trim(), "Drop into a scene");
  await page.close();
});
