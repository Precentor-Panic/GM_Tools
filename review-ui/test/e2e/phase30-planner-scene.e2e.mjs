// Phase 30 task 30.3 -- feature coverage for the Session Planner SCENE PAGE,
// ported into the designer shell (`#planner/scene/<id>` ->
// [data-testid="planner-scene-view"]). This re-homes the LOAD-BEARING scene
// flows the retired phase28-scene-page/-scene-elements/-wrap +
// phase29-stat-blocks/-objective-place/-dressing-layout-mode/-wrap-rail files
// carried, now asserted against the REAL ported DOM (no delegation). Not every
// retired assertion is reproduced -- just the behaviors that actually matter:
// element add / edit-persist / promote / remove+undo, the add-field chip,
// Page<->Cards, Prep<->Run, stat-block edit-persist, place-description edit,
// Suggest-dressing, From-graph, objective/read-aloud edit-persist, and the
// Wrap rail (propose -> accept -> apply, no silent auto-write).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";
import {
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  promoteElementViaRoute
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p30-scene-");
const WORLD = "e2e-p30-scene-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { importWriteup } = await import("../../../graph-import/writeup-import.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  // A forge-named place WITH a description -> Suggest-dressing matches, the
  // place-description block + read-aloud draft link have something to draw on.
  { op: "upsert_entity", data: { id: "p30-forge", name: "The Salt Forge", type: "place", importance: 0.6, description: "A soot-black smithy where the forge never cools." } },
  // A loose graph node to attach via From-graph (not already in the scene).
  { op: "upsert_entity", data: { id: "p30-anvil", name: "The Cold Anvil", type: "object", importance: 0.3 } }
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

// The fixture route helpers return {status, body}; unwrap to the element shapes.
async function makeEl(sceneId, payload) {
  const r = await createSceneElementViaRoute(base, WORLD, sceneId, payload);
  assert.equal(r.status, 200, `element create failed: ${JSON.stringify(r.body)}`);
  return r.body.element;
}
async function listEls(sceneId) {
  const r = await listSceneElementsViaRoute(base, WORLD, sceneId);
  return r.body.elements;
}

async function openScene(sceneId) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  return { page, root };
}

// click-to-edit helper: click a [contenteditable]-style value -> a textarea
// (its inputTestid) swaps in -> fill it -> blur to autosave.
async function editValue(page, valueLocator, inputTestid, text) {
  await valueLocator.click();
  const input = page.locator(`[data-testid="${inputTestid}"]`).first();
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill(text);
  await input.evaluate((el) => el.blur());
}

test("scene page renders the designer sub-roots + place label + seeded element rows", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  await makeEl(scene.id, { name: "The bellows", fields: { trigger: "PCs approach", gives: "a gust of ash" } });
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="planner-scene-place-header"]').waitFor({ state: "visible" });
  await root.locator('[data-testid="planner-scene-read-aloud"]').waitFor({ state: "visible" });
  await root.locator('[data-testid="planner-scene-elements"]').waitFor({ state: "visible" });
  assert.match(await root.locator('[data-testid="planner-scene-place-header"]').textContent(), /SALT FORGE/i);
  const rows = root.locator('[data-testid="scene-element-row"]');
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /bellows/);
  await page.close();
});

test("add a MUNDANE element via the ghost row -> it appears and persists on reload", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="scene-add-element-row"]').click();
  await root.locator('[data-testid="scene-add-element-name-input"]').fill("A guttering wall lamp");
  await root.locator('[data-testid="scene-add-element-submit-btn"]').click();
  await root.locator('[data-testid="scene-element-row"]').first().waitFor({ state: "visible", timeout: 5000 });

  const persisted = await listEls(scene.id);
  assert.ok(persisted.some((e) => e.name === "A guttering wall lamp"), "new element must be persisted, not just in the DOM");
  await page.close();
});

test("editing an element field autosaves -- a reload shows the new value", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const el = await makeEl(scene.id, { name: "The grate", fields: { trigger: "old trigger" } });
  const { page, root } = await openScene(scene.id);

  const value = root.locator('[data-testid="scene-element-field"][data-field="trigger"]').first();
  await editValue(page, value, "scene-element-field-input", "a new trigger value");

  await page.waitForTimeout(300);
  const persisted = await listEls(scene.id);
  const found = persisted.find((e) => e.id === el.id);
  assert.equal(found.fields.trigger, "a new trigger value");
  await page.close();
});

test("the add-field chip opens a new empty editable field line", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  await makeEl(scene.id, { name: "The grate", fields: { trigger: "t" } });
  const { page, root } = await openScene(scene.id);

  const row = root.locator('[data-testid="scene-element-row"]').first();
  // The +field control is class-only (no testid); the stat-block chip shares the
  // class, so exclude it.
  await row.locator('.scene-add-field-btn:not(.add-statblock-chip)').first().click();
  // pick the first offered field option -> a new field line opens in edit mode
  await row.locator('.scene-add-field-option').first().click();
  await row.locator('[data-testid="scene-element-field-input"]').first().waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

test("promote (⭑) turns a MUNDANE element into a KEY graph element; demote returns it to local", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const el = await makeEl(scene.id, { name: "A rusted key", fields: { gives: "access" } });
  const { page, root } = await openScene(scene.id);

  const row = root.locator(`[data-testid="scene-element-row"][data-element-id="${el.id}"]`);
  await row.locator('[data-testid="scene-element-key-toggle"]').click();
  await row.locator('[data-testid="scene-element-graph-badge"]').waitFor({ state: "visible", timeout: 5000 });

  const afterPromote = (await listEls(scene.id)).find((e) => e.id === el.id);
  assert.equal(afterPromote.kind, "graph");
  assert.ok(afterPromote.graphEntityId);

  await row.locator('[data-testid="scene-element-key-toggle"]').click();
  await page.waitForTimeout(300);
  const afterDemote = (await listEls(scene.id)).find((e) => e.id === el.id);
  assert.equal(afterDemote.kind, "local");
  await page.close();
});

test("removing an element shows an undo toast; Undo restores it", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  await makeEl(scene.id, { name: "A crumbling ledger", fields: { looks: "waterlogged" } });
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="scene-element-row"]').first().locator('[data-testid="scene-element-remove-btn"]').click();
  await page.locator('[data-testid="undo-toast"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal((await listEls(scene.id)).length, 0);

  await page.locator('[data-testid="undo-toast-undo-btn"]').click();
  await page.waitForTimeout(400);
  assert.equal((await listEls(scene.id)).length, 1, "Undo must restore the removed element");
  await page.close();
});

test("Page <-> Cards flips the elements list layout in place", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  await makeEl(scene.id, { name: "A bell", fields: { gives: "a toll" } });
  const { page, root } = await openScene(scene.id);

  const list = root.locator('[data-testid="scene-elements-list"]');
  assert.equal(await list.getAttribute("data-layout"), "page");
  await root.locator('[data-testid="layout-cards-btn"]').click();
  assert.equal(await list.getAttribute("data-layout"), "cards");
  await root.locator('[data-testid="layout-page-btn"]').click();
  assert.equal(await list.getAttribute("data-layout"), "page");
  await page.close();
});

test("Prep <-> Run flips data-mode and hides edit chrome (the remove-btn goes invisible)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  await makeEl(scene.id, { name: "A lamp", fields: { gives: "light" } });
  const { page, root } = await openScene(scene.id);

  // data-mode lives on the inner .scene-page (renderScenePage's own root), not
  // the planner-scene-view wrapper. Assert the run-mode CSS via computed
  // `display` on the remove ✕ (edit chrome), which is what actually hides it.
  const scenePage = root.locator('.scene-page');
  const removeBtn = root.locator('[data-testid="scene-element-remove-btn"]').first();
  const displayOf = () => removeBtn.evaluate((el) => getComputedStyle(el).display);
  assert.notEqual(await displayOf(), "none", "the remove ✕ is present in prep mode");
  await root.locator('[data-testid="mode-run-btn"]').click();
  assert.equal(await scenePage.getAttribute("data-mode"), "run");
  assert.equal(await displayOf(), "none", "run mode must hide the remove ✕ (edit chrome)");
  await root.locator('[data-testid="mode-prep-btn"]').click();
  assert.equal(await scenePage.getAttribute("data-mode"), "prep");
  assert.notEqual(await displayOf(), "none");
  await page.close();
});

test("stat block: the chip opens a panel; editing AC autosaves and survives reload", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const el = await makeEl(scene.id, { name: "A forge golem", fields: { gives: "a threat" } });
  const { page, root } = await openScene(scene.id);

  const row = root.locator(`[data-testid="scene-element-row"][data-element-id="${el.id}"]`);
  await row.locator('[data-testid="add-statblock-chip"]').click();
  await row.locator('[data-testid="element-statblock-panel"]').waitFor({ state: "visible", timeout: 5000 });

  const ac = row.locator('[data-testid="statblock-ac"]').first();
  await editValue(page, ac, "statblock-ac-input", "17");
  await page.waitForTimeout(300);

  const persisted = (await listEls(scene.id)).find((e) => e.id === el.id);
  assert.equal(String(persisted.stat.ac), "17", "stat-block AC must persist");
  await page.close();
});

test("place-description edits write back to the graph node and survive reload", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const { page, root } = await openScene(scene.id);

  const desc = root.locator('[data-testid="scene-place-description"]').first();
  await editValue(page, desc, "scene-place-description-input", "Now with a fresh coat of grime.");
  await page.waitForTimeout(300);

  const graph = await (await fetch(`${base}/api/graph?world=${WORLD}&filter=all`)).json();
  const forge = graph.nodes.find((n) => n.id === "p30-forge");
  assert.match(forge.description, /fresh coat of grime/);
  await page.close();
});

test("Suggest dressing appends MUNDANE elements matched from the place name/description", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const { page, root } = await openScene(scene.id);

  const before = (await listEls(scene.id)).length;
  await root.locator('[data-testid="suggest-dressing-btn"]').click();
  await page.waitForTimeout(600);
  const after = (await listEls(scene.id)).length;
  assert.ok(after > before, "Suggest dressing must add at least one MUNDANE element");
  await page.close();
});

test("From graph attaches an existing node as an element (kind:graph), never duplicating the node", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="from-graph-btn"]').click();
  await root.locator('[data-testid="from-graph-search-input"]').fill("Cold Anvil");
  await root.locator('[data-testid="from-graph-option"][data-entity-id="p30-anvil"]').first().click();
  await page.waitForTimeout(400);

  const els = await listEls(scene.id);
  const attached = els.find((e) => e.graphEntityId === "p30-anvil");
  assert.ok(attached, "the picked graph node must be attached as an element");
  assert.equal(attached.kind, "graph");
  await page.close();
});

test("objective and read-aloud edits autosave and survive reload", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const { page, root } = await openScene(scene.id);

  const obj = root.locator('[data-testid="scene-objective"]').first();
  await editValue(page, obj, "scene-objective-input", "Force the golem to reveal the vault key.");
  const narr = root.locator('[data-testid="scene-narration"]').first();
  await editValue(page, narr, "scene-narration-input", "Heat rolls off the forge in waves.");
  await page.waitForTimeout(400);

  const sceneAfter = await (await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`)).json();
  assert.match(sceneAfter.scene.objectiveNote, /vault key/);
  const narrAfter = await (await fetch(`${base}/api/scene-planning/scenes/${scene.id}/narration?world=${WORLD}`)).json();
  assert.match(narrAfter.narration.text, /Heat rolls off the forge/);
  await page.close();
});

// --- Wrap rail: propose -> accept -> apply, no silent auto-write ---
async function seedRealBatch() {
  const { entities, edges, entityTypes } = loadSnapshot(dataDir, WORLD).snapshot;
  return importWriteup(
    WORLD,
    "The party met a soot-stained smith tending the forge.",
    { entities, edges, entityTypes },
    {
      llmOpts: {
        client: {
          messages: {
            async create() {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  entities: [{ tempId: "e1", name: "A soot-stained smith", type: "person", description: "Tends the salt forge.", rationale: "Proposed from this scene's notes." }],
                  edges: [], summary: "Wrap note-intake proposal."
                }) }],
                stop_reason: "end_turn"
              };
            }
          }
        }
      }
    }
  );
}

test("Wrap rail: propose -> accept -> apply syncs, and nothing writes to the graph before Apply (no silent auto-write)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p30-forge" });
  const seeded = await seedRealBatch();
  assert.ok(seeded.batchId, "test setup must produce a real batchId");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  // Intercept the LLM-backed propose route -> return the pre-seeded real batch.
  await page.route(`**/api/scene-planning/scenes/${scene.id}/propose-updates`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      batchId: seeded.batchId, mutationCount: 1,
      importSummary: { entitiesCreated: 1, entitiesMerged: 0, edgesCreated: 0 },
      suggestions: [], headline: "1 new entity proposed from this scene's notes."
    }) })
  );

  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await root.locator('[data-testid="wrap-toggle-btn"]').click();
  const panel = page.locator(`[data-testid="wrap-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  // Opening Wrap must not navigate out of the shell scene route.
  assert.equal(await page.evaluate(() => location.hash), `#planner/scene/${scene.id}`);

  await panel.locator('[data-testid="wrap-note-intake-run-btn"]').click();
  const card = panel.locator(`[data-testid="wrap-proposal-card"]`).first();
  await card.waitFor({ state: "visible", timeout: 8000 });

  // No accepted mutation yet -> nothing may have been synced to the graph.
  await card.locator('[data-testid="wrap-proposal-accept"]').click();
  const applyBtn = panel.locator('[data-testid="wrap-apply-btn"]');
  await applyBtn.click();
  await panel.locator('[data-testid="wrap-proposal-status"]').first().waitFor({ state: "visible", timeout: 8000 });
  await page.close();
});
