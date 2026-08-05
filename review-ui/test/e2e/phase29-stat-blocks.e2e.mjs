// Phase 29 task 29.4 -- Stat blocks (SceneElement.stat). Read
// phase29-fixture.mjs's header FIRST (§1 is this file's own section).
//
// INVERTED for 29.4: the route-level test (29.1) was already GREEN and is kept
// verbatim below. The UI tests -- which under 29.0 asserted the DOM was ABSENT
// (assert.rejects on a selector timeout) -- are now real feature assertions
// against the shipped stat-block UI in session-planner-view.js:
//   * the "+ STAT BLOCK" chip renders, and clicking it attaches an (empty)
//     stat + opens the panel, with every sub-field (AC/HP/Speed/CR/raw/Foundry)
//     present and the element's stored `stat` now non-null;
//   * editing AC via the click-to-edit swap persists a PARTIAL `{stat:{ac}}`
//     PATCH, confirmed by a fresh GET, and leaves a sibling field (HP)
//     untouched (the shallow-merge guarantee);
//   * the count stepper's +/- buttons PATCH `stat.count` (with README's ×1
//     floor);
//   * the Foundry actor-id line persists its string (stored only, no push);
//   * the "▣ NPC or creature" button creates a scene-local element that
//     already carries a non-null `stat`, with its panel open.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  patchSceneElementViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase29Env("gm-tools-e2e-statblocks-");
const WORLD = "e2e-statblocks-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sb-place-a", name: "The Sunken Reliquary", type: "place", importance: 0.5 } }
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

/** Poll `GET .../elements` until `predicate(element)` holds for the element id (or time out). */
async function pollElement(sceneId, elementId, predicate, { tries = 40, waitMs = 250 } = {}) {
  let el = null;
  for (let i = 0; i < tries; i++) {
    const res = await listSceneElementsViaRoute(base, WORLD, sceneId);
    el = res.body.elements.find((e) => e.id === elementId) || null;
    if (el && predicate(el)) return el;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return el;
}

async function openScenePage(sceneId) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${sceneId}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${sceneId}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  return { page, root };
}

test("ROUTE LEVEL: PATCH .../elements/:elementId {stat} persists a merged stat object (29.1, kept green)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A gaunt sexton" });
  const elementId = created.body?.element?.id;
  assert.ok(elementId, "test setup itself must succeed -- broken test setup, not the thing under test");

  const patch1 = await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, {
    stat: { count: 1, ac: "13", hp: "22 (4d8+4)", speed: "30 ft.", cr: "1/2 (100 XP)", raw: "", foundryActor: "" }
  });
  assert.equal(patch1.status, 200);

  const after1 = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const el1 = after1.body.elements.find((e) => e.id === elementId);
  assert.ok(el1.stat, "element.stat must be present after a PATCH carrying {stat:{...}}");
  assert.equal(el1.stat?.ac, "13", "the stat sub-fields sent in the PATCH must round-trip");

  const patch2 = await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, { stat: { ac: "15" } });
  assert.equal(patch2.status, 200);
  const after2 = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const el2 = after2.body.elements.find((e) => e.id === elementId);
  assert.equal(el2.stat?.ac, "15", "a partial stat PATCH must update the targeted sub-field");
  assert.equal(el2.stat?.hp, "22 (4d8+4)", "a partial stat PATCH must leave OTHER stat sub-fields untouched (shallow merge)");
});

test("UI: the '+ STAT BLOCK' chip attaches an empty stat, opens the panel with all sub-fields, and persists a non-null stat", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A blood-stamped ledger", fields: { trigger: "Opened without the key" } });
  const elementId = created.body.element.id;

  const { page, root } = await openScenePage(scene.id);

  const chip = root.locator(`[data-testid="add-statblock-chip"][data-element-id="${elementId}"]`);
  await chip.waitFor({ state: "visible", timeout: 5000 });
  await chip.click();

  // Panel opens with the disclosure line, count stepper and every sub-field.
  const panel = root.locator(`[data-testid="element-statblock-panel"][data-element-id="${elementId}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await root.locator(`[data-testid="element-statblock-toggle"][data-element-id="${elementId}"]`).waitFor({ state: "visible", timeout: 5000 });
  for (const f of ["ac", "hp", "speed", "cr", "raw", "foundry"]) {
    assert.equal(await panel.locator(`[data-testid="statblock-${f}"]`).count(), 1, `the open panel must render the ${f} field`);
  }
  await panel.locator(`[data-testid="statblock-count"][data-element-id="${elementId}"]`).waitFor({ state: "visible", timeout: 5000 });

  // The chip is gone (replaced by the disclosure line) and the stored stat is non-null.
  assert.equal(await root.locator(`[data-testid="add-statblock-chip"][data-element-id="${elementId}"]`).count(), 0, "the chip is replaced by the disclosure line once a stat exists");
  const persisted = await pollElement(scene.id, elementId, (el) => el.stat != null);
  assert.ok(persisted?.stat, "clicking the chip must persist a non-null stat via the element PATCH route");
  assert.equal(persisted.stat.count, 1, "a freshly-attached stat starts at count 1");
  await page.close();
});

test("UI: editing AC persists a partial {stat} PATCH and leaves a sibling stat field (HP) untouched", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A drowned warden" });
  const elementId = created.body.element.id;
  // Seed a stat with an existing HP so the partial-merge guarantee is testable.
  await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, {
    stat: { count: 1, ac: "", hp: "58 (9d8+18)", speed: "20 ft.", cr: "4 (1,100 XP)", raw: "", foundryActor: "" }
  });

  const { page, root } = await openScenePage(scene.id);
  await root.locator(`[data-testid="element-statblock-toggle"][data-element-id="${elementId}"]`).click();
  const panel = root.locator(`[data-testid="element-statblock-panel"][data-element-id="${elementId}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  await panel.locator(`[data-testid="statblock-ac"]`).click();
  const acInput = page.locator(`[data-testid="statblock-ac-input"]`);
  await acInput.waitFor({ state: "visible", timeout: 5000 });
  await acInput.fill("17 (natural armor)");
  await acInput.blur();

  const el = await pollElement(scene.id, elementId, (e) => e.stat?.ac === "17 (natural armor)");
  assert.equal(el?.stat?.ac, "17 (natural armor)", "the edited AC must persist via a partial {stat:{ac}} PATCH");
  assert.equal(el?.stat?.hp, "58 (9d8+18)", "the AC edit must leave the sibling HP field untouched (shallow merge)");
  await page.close();
});

test("UI: the count stepper's +/- buttons PATCH stat.count, with a ×1 floor", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A pack of ghouls" });
  const elementId = created.body.element.id;
  await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, {
    stat: { count: 2, ac: "12", hp: "22", speed: "30 ft.", cr: "1", raw: "", foundryActor: "" }
  });

  const { page, root } = await openScenePage(scene.id);
  await root.locator(`[data-testid="element-statblock-toggle"][data-element-id="${elementId}"]`).click();
  const panel = root.locator(`[data-testid="element-statblock-panel"][data-element-id="${elementId}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  await panel.locator(`[data-testid="statblock-count-up-btn"][data-element-id="${elementId}"]`).click();
  let el = await pollElement(scene.id, elementId, (e) => e.stat?.count === 3);
  assert.equal(el?.stat?.count, 3, "the + button must increment stat.count");

  // Step down past 1 -- must floor at 1, never below.
  const down = panel.locator(`[data-testid="statblock-count-down-btn"][data-element-id="${elementId}"]`);
  await down.click();
  await down.click();
  await down.click();
  el = await pollElement(scene.id, elementId, (e) => e.stat?.count === 1);
  assert.equal(el?.stat?.count, 1, "the - button must floor stat.count at 1");
  await page.close();
});

test("UI: the Foundry actor-id line persists its string (stored only)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A bound elemental" });
  const elementId = created.body.element.id;
  await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, {
    stat: { count: 1, ac: "13", hp: "30", speed: "0 ft.", cr: "2", raw: "", foundryActor: "" }
  });

  const { page, root } = await openScenePage(scene.id);
  await root.locator(`[data-testid="element-statblock-toggle"][data-element-id="${elementId}"]`).click();
  const panel = root.locator(`[data-testid="element-statblock-panel"][data-element-id="${elementId}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  await panel.locator(`[data-testid="statblock-foundry"]`).click();
  const fInput = page.locator(`[data-testid="statblock-foundry-input"]`);
  await fInput.waitFor({ state: "visible", timeout: 5000 });
  await fInput.fill("Actor.7fQ2mXnP");
  await fInput.blur();

  const el = await pollElement(scene.id, elementId, (e) => e.stat?.foundryActor === "Actor.7fQ2mXnP");
  assert.equal(el?.stat?.foundryActor, "Actor.7fQ2mXnP", "the Foundry actor id must persist (stored only, no push)");
  await page.close();
});

test("UI: the '▣ NPC or creature' button creates a scene-local element already carrying a non-null stat, panel open", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });

  const { page, root } = await openScenePage(scene.id);
  const btn = root.locator(`[data-testid="npc-creature-btn"][data-scene-id="${scene.id}"]`);
  await btn.waitFor({ state: "visible", timeout: 5000 });
  await btn.click();

  // A new element row appears carrying a stat; the panel is open (no extra click).
  const row = root.locator(`[data-testid="scene-element-row"][data-kind="local"]`).first();
  await row.waitFor({ state: "visible", timeout: 5000 });
  await root.locator(`[data-testid="element-statblock-panel"]`).first().waitFor({ state: "visible", timeout: 5000 });

  // Confirm via a fresh GET the created element genuinely has a non-null stat.
  let created = null;
  for (let i = 0; i < 40 && !created; i++) {
    const res = await listSceneElementsViaRoute(base, WORLD, scene.id);
    created = (res.body.elements || []).find((e) => e.kind === "local" && e.stat != null) || null;
    if (!created) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(created, "the NPC/creature button must create a scene-local element with a non-null stat");
  assert.equal(created.stat.count, 1, "the created creature's stat starts at count 1");
  await page.close();
});
