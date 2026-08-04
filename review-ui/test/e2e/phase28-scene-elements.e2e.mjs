// Phase 28 task 28.0 -- Elements: add (defaults MUNDANE/local), per-element
// promote (creates a graph node + containment edge)/demote (never deletes
// the node), hover-x remove + undo. Read phase28-fixture.mjs's header FIRST
// (§6/§8/§11 are this file's own sections). EXPECTED TO FAIL right now: the
// scene-elements store/routes don't exist at all yet (a real 404 from
// `POST .../elements`), and `#session-planner/<sceneId>` still renders the
// OLD chain view, so `[data-testid="scene-elements-list"]` never appears
// either. Both failure shapes are the deliverable of this task.
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
  promoteElementViaRoute,
  demoteElementViaRoute,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase28-fixture.mjs";

const { scratchDir, dataDir } = setupPhase28Env("gm-tools-e2e-elements-");
const WORLD = "e2e-elements-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "el-place-a", name: "The Sunken Library", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "el-place-b", name: "Gallows Hill", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "el-place-c", name: "Foghaven Pier", type: "place", importance: 0.5 } }
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

test("ROUTE LEVEL: POST .../elements defaults kind to \"local\" when omitted -- new elements are never classified as KEY at creation", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "el-place-a" });
  const { status, body } = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A dusty writing desk" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.element.kind, "local", "an element created with no explicit kind must default to local (MUNDANE), never graph (KEY)");
  assert.equal(body.element.graphEntityId ?? null, null, "a local element must carry no graphEntityId");

  const list = await listSceneElementsViaRoute(base, WORLD, scene.id);
  assert.equal(list.status, 200);
  assert.ok(list.body.elements.some((e) => e.id === body.element.id), "a fresh GET .../elements must show the created element -- real persistence");
});

test("UI: the '+ add element' ghost row creates a MUNDANE element via the real route and re-arms for the next add", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "el-place-b" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const ghost = page.locator(`[data-testid="scene-add-element-row"][data-scene-id="${scene.id}"]`);
  await ghost.waitFor({ state: "visible", timeout: 15000 });
  await ghost.click();
  const nameInput = page.locator('[data-testid="scene-add-element-name-input"]');
  await nameInput.waitFor({ state: "visible", timeout: 5000 });
  await nameInput.fill("A cracked bronze mirror");
  await nameInput.press("Enter");

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-element-row"]').length === 1, { timeout: 10000 });
  }, "submitting the ghost add-element row must append a real scene-element-row");

  const created = page.locator('[data-testid="scene-element-row"]').first();
  assert.equal(await created.getAttribute("data-kind"), "local", "a freshly-added element must render with data-kind=\"local\" (MUNDANE)");

  // Re-armed: the ghost row (or its input) is still usable for a second add.
  assert.equal(await page.locator(`[data-testid="scene-add-element-row"][data-scene-id="${scene.id}"]`).count(), 1, "the ghost add-element row must still be present after one add");

  const list = await listSceneElementsViaRoute(base, WORLD, scene.id);
  assert.equal(list.body.elements.length, 1);
  assert.equal(list.body.elements[0].kind, "local");
  await page.close();
});

test("UI: the KEY toggle promotes a local element into a REAL graph node + containment edge to the scene's own place", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "el-place-c" });
  const { body } = await createSceneElementViaRoute(base, WORLD, scene.id, {
    name: "A locked iron sea-chest",
    fields: { trigger: "Forcing it open (DC 15) or finding the key alerts the harbor guard." }
  });
  const elementId = body?.element?.id;
  assert.ok(elementId, "test setup requires the element-creation route to succeed -- see the ROUTE LEVEL test above for that in isolation");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const row = page.locator(`[data-testid="scene-element-row"][data-element-id="${elementId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await row.getAttribute("data-kind"), "local");

  await row.locator('[data-testid="scene-element-key-toggle"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="scene-element-row"][data-element-id="${id}"]`)?.getAttribute("data-kind") === "graph",
      elementId,
      { timeout: 10000 }
    );
  }, "promoting must flip the row to data-kind=\"graph\"");
  assert.equal(await row.locator('[data-testid="scene-element-graph-badge"]').count(), 1, "a promoted (KEY) row must show the graph badge");

  const promoted = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const element = promoted.body.elements.find((e) => e.id === elementId);
  assert.equal(element.kind, "graph");
  assert.ok(element.graphEntityId, "a promoted element must carry a real graphEntityId");

  const { nodes, edges } = await fetchGraphViaRoute(base, WORLD);
  assert.ok(nodes.some((n) => n.id === element.graphEntityId), "promotion must create a REAL graph node, findable via GET /api/graph");
  assert.ok(
    edges.some((e) => e.sourceId === element.graphEntityId && e.targetId === "el-place-c" && e.relationshipType === "containment"),
    "promotion must create a REAL containment edge from the new node to the scene's own anchor place"
  );
  await page.close();
});

test("ROUTE LEVEL: demoting a graph element clears kind/graphEntityId but the underlying graph node is NEVER deleted", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "el-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A carved stone idol" });
  const elementId = created.body?.element?.id;
  assert.ok(elementId, "test setup requires element creation to succeed");

  const promoted = await promoteElementViaRoute(base, WORLD, scene.id, elementId);
  assert.equal(promoted.status, 200, `expected 200, got ${promoted.status}: ${JSON.stringify(promoted.body)}`);
  const graphEntityId = promoted.body.element.graphEntityId;
  assert.ok(graphEntityId);

  const demoted = await demoteElementViaRoute(base, WORLD, scene.id, elementId);
  assert.equal(demoted.status, 200, `expected 200, got ${demoted.status}: ${JSON.stringify(demoted.body)}`);
  assert.equal(demoted.body.element.kind, "local", "demote must flip kind back to local");
  assert.equal(demoted.body.element.graphEntityId ?? null, null, "demote must clear graphEntityId");

  const { nodes } = await fetchGraphViaRoute(base, WORLD);
  assert.ok(nodes.some((n) => n.id === graphEntityId), "demote must NEVER delete the underlying graph node -- it must still exist");
});

test("UI: hover-x remove shows an undo-toast; Undo re-creates the element (observable via a fresh GET)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "el-place-b" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, {
    name: "A rickety wooden ladder",
    fields: { trigger: "Climbing it without care risks a fall (DC 10 Acrobatics)." }
  });
  const elementId = created.body?.element?.id;
  assert.ok(elementId, "test setup requires element creation to succeed");

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);

  const row = page.locator(`[data-testid="scene-element-row"][data-element-id="${elementId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="scene-element-remove-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-testid="scene-element-row"][data-element-id="${id}"]`).length === 0,
      elementId,
      { timeout: 10000 }
    );
  }, "removing an element must take it out of the DOM immediately");

  const toast = page.locator('[data-testid="undo-toast"]');
  await toast.waitFor({ state: "visible", timeout: 5000 });
  await toast.locator('[data-testid="undo-toast-undo-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-element-row"]').length === 1, { timeout: 10000 });
  }, "Undo must re-create the removed element");

  const list = await listSceneElementsViaRoute(base, WORLD, scene.id);
  assert.equal(list.body.elements.length, 1);
  assert.equal(list.body.elements[0].name, "A rickety wooden ladder");
  await page.close();
});
