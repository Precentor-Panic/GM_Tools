// Phase 29 -- From-graph picker (§2) + element reorder (§3). Read
// phase29-fixture.mjs's header FIRST. The two ROUTE-LEVEL tests assert the
// real 29.1 routes (POST .../elements/from-graph and .../elements/reorder,
// ordered ahead of the generic PATCH-by-elementId handler). The UI test was
// RED-asserting-absence at task 29.0; task 29.3 built the From-graph inline
// picker, so it is now INVERTED into a real behavioural assertion (the picker
// opens, lists eligible nodes with name+type, picking attaches a kind:'graph'
// element referencing the existing node without duplicating it, and the
// attached node is then excluded).
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

test("UI: '◇ From graph' opens an inline picker of eligible nodes; picking one attaches it as kind:'graph' without duplicating the node, and it is then excluded", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "fg-place-a" });
  const before = await fetchGraphViaRoute(base, WORLD);
  const nodeCountBefore = before.nodes.length;

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  const btn = root.locator(`[data-testid="from-graph-btn"][data-scene-id="${scene.id}"]`);
  await btn.waitFor({ state: "visible", timeout: 5000 });
  await btn.click();

  const picker = root.locator(`[data-testid="from-graph-picker"][data-scene-id="${scene.id}"]`);
  await picker.waitFor({ state: "visible", timeout: 5000 });
  await picker.locator('[data-testid="from-graph-search-input"]').waitFor({ state: "visible", timeout: 5000 });

  // The eligible person node is listed with its name and mono type.
  const npcOpt = picker.locator('[data-testid="from-graph-option"][data-entity-id="fg-npc-a"]');
  await npcOpt.waitFor({ state: "visible", timeout: 5000 });
  const npcText = await npcOpt.textContent();
  assert.ok(npcText.includes("Ashen Warden Cael"), "each option shows the entity's name");
  assert.ok(npcText.toLowerCase().includes("person"), "each option shows the entity's type");

  await npcOpt.click();

  // A new kind:'graph' element row appears, referencing the EXISTING node.
  const graphRow = root.locator('[data-testid="scene-element-row"][data-kind="graph"]');
  await graphRow.waitFor({ state: "visible", timeout: 5000 });

  // The graph itself gained no node -- from-graph references, never duplicates.
  let unchanged = false;
  for (let i = 0; i < 40 && !unchanged; i++) {
    const after = await fetchGraphViaRoute(base, WORLD);
    unchanged = after.nodes.length === nodeCountBefore;
    if (!unchanged) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(unchanged, "from-graph must never create/duplicate a graph node -- it only references the existing one");

  // Confirm via the store: the created element is kind:'graph' with the right ref.
  const elements = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const attached = elements.body.elements.find((e) => e.graphEntityId === "fg-npc-a");
  assert.ok(attached && attached.kind === "graph", "the store shows a kind:'graph' element referencing fg-npc-a");

  // Reopen the picker: the now-attached node is excluded; the scene's own
  // place (still not an element) remains eligible.
  await btn.click();
  await picker.waitFor({ state: "visible", timeout: 5000 });
  await picker.locator('[data-testid="from-graph-option"][data-entity-id="fg-place-a"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    await picker.locator('[data-testid="from-graph-option"][data-entity-id="fg-npc-a"]').count(),
    0,
    "a node already attached as an element must be excluded from the picker"
  );
  await page.close();
});
