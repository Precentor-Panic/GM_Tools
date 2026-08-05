// Phase 29 task 29.0 -- From-graph picker (§2) + element reorder (§3). Read
// phase29-fixture.mjs's header FIRST. EXPECTED TO FAIL right now: both
// routes return a real 400 (confirmed by actually running this suite -- the
// literal path segments "from-graph"/"reorder" are swallowed by the EXISTING
// generic PATCH-by-elementId route, which throws "No scene element found"
// for either string, mapped to 400 -- not a clean, unmatched 404, but just
// as genuinely "this route doesn't exist yet," see phase29-fixture.mjs §2/§3
// for the exact mechanism), and the From-graph picker UI doesn't exist in
// session-planner-view.js. Both failure shapes are the deliverable of this
// task, not a bug in this file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  createFromGraphElementViaRoute,
  reorderElementsViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase29Env("gm-tools-e2e-fromgraph-");
const WORLD = "e2e-fromgraph-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "fg-place-a", name: "The Antechamber", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "fg-npc-a", name: "Ashen Warden Cael", type: "person", importance: 0.6 } }
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

test("ROUTE LEVEL (RED): POST .../elements/from-graph attaches an EXISTING node without creating a new one", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "fg-place-a" });
  const before = await fetchGraphViaRoute(base, WORLD);
  const nodeCountBefore = before.nodes.length;

  const { status, body } = await createFromGraphElementViaRoute(base, WORLD, scene.id, { entityId: "fg-npc-a" });
  assert.equal(status, 200, "29.1: POST .../elements/from-graph must exist and succeed -- RED today at 400 (the literal string 'from-graph' is swallowed by the existing generic PATCH-by-elementId route, which throws 'No scene element found', mapped to 400), not a route that was simply never written");
  assert.equal(body?.element?.kind, "graph", "29.1: a from-graph element must be created with kind:'graph'");
  assert.equal(body?.element?.graphEntityId, "fg-npc-a", "29.1: graphEntityId must reference the EXISTING node's own id, never a freshly-created one");

  const after = await fetchGraphViaRoute(base, WORLD);
  assert.equal(after.nodes.length, nodeCountBefore, "29.1: from-graph must never duplicate/create a new graph node -- it only references the existing one");
});

test("ROUTE LEVEL (RED): POST .../elements/reorder persists the new order", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "fg-place-a" });
  const e1 = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "First" });
  const e2 = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Second" });
  const e3 = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Third" });
  const [id1, id2, id3] = [e1.body.element.id, e2.body.element.id, e3.body.element.id];

  const { status } = await reorderElementsViaRoute(base, WORLD, scene.id, [id3, id1, id2]);
  assert.equal(status, 200, "29.1: POST .../elements/reorder must exist and succeed -- RED today at 400 (same path-collision reason as from-graph -- 'reorder' is read as an elementId by the generic PATCH route); reorderElements() itself already exists in scene-elements.mjs, it's just unwired to any route ordered ahead of that collision");

  const after = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const orderedIds = after.body.elements.map((e) => e.id);
  assert.deepEqual(orderedIds, [id3, id1, id2], "29.1: a fresh GET .../elements must reflect the new order exactly");
});

test("UI (RED): '◇ From graph' picker does not exist on the scene page yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "fg-place-a" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="from-graph-btn"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.3: `from-graph-btn` must render below the elements list -- RED today, absent from the DOM"
  );
  await page.close();
});
