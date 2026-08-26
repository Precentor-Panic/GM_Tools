// Run layout (2026-08-26) -- the Prep-side organising tools: the per-row run
// chip + popover (writes `run` through the element patch route) and the
// Layout board (Main | Side | Off lanes; ↑/↓, send-to-lane, and one real
// HTML5 drag between lanes; every move persists column + the FULL order).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";
import { createSceneElementViaRoute, listSceneElementsViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-layout-tools-");
const WORLD = "e2e-run-layout-tools-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "lt-square", name: "The Square", type: "place", importance: 0.5 } }]);

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

async function makeEl(sceneId, payload) {
  const r = await createSceneElementViaRoute(base, WORLD, sceneId, payload);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.element;
}
async function els(sceneId) {
  return (await listSceneElementsViaRoute(base, WORLD, sceneId)).body.elements;
}
async function openScene(sceneId) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-elements-list"]').waitFor({ timeout: 15000 });
  return page;
}

test("row chip shows the inferred placement as 'auto'; the popover writes an explicit run; Auto clears it", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "lt-square", name: "Chip scene" });
  const el = await makeEl(scene.id, { name: "Backdrop — Night", fields: { looks: "Dark." } });
  const page = await openScene(scene.id);
  const chip = page.locator(`[data-testid="scene-element-run-chip"][data-element-id="${el.id}"]`);
  assert.equal(await chip.getAttribute("data-inferred"), "true");
  assert.match(await chip.textContent(), /^auto · side · GM box · Night$/);

  await chip.click();
  const pop = page.locator('[data-testid="scene-element-run-pop"]');
  await pop.waitFor({ state: "visible" });
  await pop.locator('[data-testid="run-pop-column"][value="main"]').check();
  await pop.locator('[data-testid="run-pop-role"][value="read"]').check();
  await pop.locator('[data-testid="run-pop-variant"]').fill("Dusk");
  await pop.locator('[data-testid="run-pop-save"]').click();
  await pop.waitFor({ state: "hidden" });
  assert.equal(await chip.getAttribute("data-inferred"), "false");
  assert.equal(await chip.textContent(), "main · Read aloud · Dusk");
  let stored = (await els(scene.id)).find((e) => e.id === el.id);
  assert.deepEqual(stored.run, { column: "main", role: "read", variant: "Dusk" });

  await chip.click();
  await page.locator('[data-testid="run-pop-auto"]').click();
  await page.locator('[data-testid="scene-element-run-pop"]').waitFor({ state: "hidden" });
  assert.equal(await chip.getAttribute("data-inferred"), "true");
  stored = (await els(scene.id)).find((e) => e.id === el.id);
  assert.equal(stored.run, null);
  // Run mode hides the chip with the rest of the edit chrome.
  await page.locator('[data-testid="mode-run-btn"]').click();
  assert.equal(await chip.isVisible(), false);
  await page.close();
});

test("Layout board: lanes reflect columns; ↑/↓ and send-to-lane persist column + the full order; Infer tags the untagged", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "lt-square", name: "Board scene" });
  const a = await makeEl(scene.id, { name: "A read", run: { column: "main", role: "read" } });
  const b = await makeEl(scene.id, { name: "B beat", run: { column: "main", role: "beat" } });
  const c = await makeEl(scene.id, { name: "C block", run: { column: "side", role: "block" } });
  const d = await makeEl(scene.id, { name: "Backdrop — Dusk", fields: { looks: "x" } }); // untagged -> inferred side/gm
  const page = await openScene(scene.id);
  await page.locator('[data-testid="layout-board-btn"]').click();
  const board = page.locator('[data-testid="scene-layout-board"]');
  await board.waitFor({ state: "visible", timeout: 10000 });
  const laneIds = async (col) => board.locator(`[data-testid="layout-lane"][data-column="${col}"] [data-testid="layout-card"]`).evaluateAll((n) => n.map((x) => x.getAttribute("data-element-id")));
  assert.deepEqual(await laneIds("main"), [a.id, b.id]);
  assert.deepEqual(await laneIds("side"), [c.id, d.id]);
  assert.deepEqual(await laneIds("off"), []);

  // ↓ on A swaps A/B within main.
  await board.locator(`[data-testid="layout-card-down"][data-element-id="${a.id}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="layout-lane"][data-column="main"] [data-testid="layout-card"]`)?.getAttribute("data-element-id") === id, b.id);
  assert.deepEqual(await laneIds("main"), [b.id, a.id]);
  let order = (await els(scene.id)).map((e) => e.id);
  assert.deepEqual(order, [b.id, a.id, c.id, d.id], "full global order persisted");

  // Send C to off via the select.
  await board.locator(`[data-testid="layout-card-send"][data-element-id="${c.id}"]`).selectOption("off");
  await page.waitForFunction((id) => !!document.querySelector(`[data-testid="layout-lane"][data-column="off"] [data-testid="layout-card"][data-element-id="${id}"]`), c.id);
  const stored = (await els(scene.id));
  assert.deepEqual(stored.find((e) => e.id === c.id).run, { column: "off", role: "block" });
  assert.deepEqual(stored.map((e) => e.id), [b.id, a.id, d.id, c.id]);

  // Infer writes an explicit run onto D only.
  await board.locator('[data-testid="layout-board-infer-btn"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="scene-element-run-chip"][data-element-id="${id}"]`)?.getAttribute("data-inferred") === "false", d.id);
  const afterInfer = await els(scene.id);
  assert.deepEqual(afterInfer.find((e) => e.id === d.id).run, { column: "side", role: "gm", variant: "Dusk" });
  assert.deepEqual(afterInfer.find((e) => e.id === a.id).run, { column: "main", role: "read" }, "explicit ones untouched");
  await page.close();
});

test("Layout board: a real drag from Main to Side persists the column change", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "lt-square", name: "Drag scene" });
  const a = await makeEl(scene.id, { name: "Dragged", run: { column: "main", role: "beat" } });
  await makeEl(scene.id, { name: "Stays", run: { column: "side", role: "gm" } });
  const page = await openScene(scene.id);
  await page.locator('[data-testid="layout-board-btn"]').click();
  const board = page.locator('[data-testid="scene-layout-board"]');
  await board.waitFor({ state: "visible", timeout: 10000 });
  const card = board.locator(`[data-testid="layout-card"][data-element-id="${a.id}"]`);
  const sideLane = board.locator('[data-testid="layout-lane"][data-column="side"]');
  await card.dragTo(sideLane);
  await page.waitForFunction((id) => !!document.querySelector(`[data-testid="layout-lane"][data-column="side"] [data-testid="layout-card"][data-element-id="${id}"]`), a.id, { timeout: 10000 });
  const stored = (await els(scene.id)).find((e) => e.id === a.id);
  assert.deepEqual(stored.run, { column: "side", role: "beat" });
  await page.close();
});

test("seed run skeleton: Prep shows dashed 'fill me' placeholders; Run hides the empty ones; a filled one stops being a placeholder", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "lt-square", name: "Seed scene" });
  const page = await openScene(scene.id);
  await page.locator('[data-testid="scene-seed-skeleton-link"]').click();
  await page.locator('.scene-element-row[data-placeholder="true"]').first().waitFor({ timeout: 10000 });
  const rows = page.locator('.scene-element-row[data-placeholder="true"]');
  assert.equal(await rows.count(), 8, "narrative: read + 3 dressing + 2 beats + gm + exits");
  const stored = await els(scene.id);
  assert.ok(stored.every((e) => e.run?.placeholder === true));

  // Run: only the exits placeholder carries text (the ONWARD template), so it is the only thing that renders.
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator('[data-testid="scene-run-spread"]');
  await spread.waitFor({ state: "visible" });
  assert.equal(await spread.locator(".rs-main .rs-read").count(), 0);
  assert.equal(await spread.locator(".rs-main ul.rs-dress").count(), 0);
  assert.equal(await spread.locator(".rs-main .rs-exits .rs-exit").count(), 3);

  // Fill the read-aloud placeholder through the route: the flag drops and Run shows it on the next entry.
  const read = stored.find((e) => e.run.role === "read");
  await fetch(`${base}/api/scene-planning/scenes/${scene.id}/elements/${read.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, fields: { looks: "The ford runs brown." } })
  });
  await page.locator('[data-testid="mode-prep-btn"]').click();
  await page.locator('[data-testid="mode-run-btn"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-run-spread"] .rs-main .rs-read').length === 1);
  assert.equal((await els(scene.id)).find((e) => e.id === read.id).run.placeholder, undefined);
  await page.close();
});
