// Friction Wave 1, W5b — the World tab rail redesign (Russell's 2026-08-14
// request): a new sub-bar under the World header carrying "search the world"
// + the icon type-filters (moved DOWN from the shell topbar's world slot)
// and a rail selector Spatial | Loyalty | Graph, where Graph mounts the
// SHARED graph-view.js full-graph view over the same world data. Supersedes
// the clipped "Spatial/Loya" in-tree-head toggle.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-w5b-rail-");
const WORLD = "e2e-w5b-rail-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "w5b-city", name: "Bellhaven", type: "place", importance: 0.8 } },
  { op: "upsert_entity", data: { id: "w5b-ward", name: "Copper Ward", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "w5b-smith", name: "Orla the Smith", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "w5b-bell", name: "The Great Bell", type: "object", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "w5b-e1", sourceId: "w5b-ward", targetId: "w5b-city", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "w5b-e2", sourceId: "w5b-smith", targetId: "w5b-ward", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "w5b-e3", sourceId: "w5b-bell", targetId: "w5b-city", relationshipType: "containment" } }
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

async function openWorld(page) {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="w5b-city"]').waitFor({ state: "visible", timeout: 10000 });
}

test("W5b: the sub-bar renders under the header with the rail selector + search + icon filters; the shell topbar's world slot is empty", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openWorld(page);

  const subbar = page.locator('[data-testid="world-subbar"]');
  await subbar.waitFor({ state: "visible", timeout: 10000 });
  // Rail selector: three options, Spatial active by default.
  for (const [tid, pressed] of [["wv-tree-mode-spatial-btn", "true"], ["wv-tree-mode-loyalty-btn", "false"], ["wv-rail-graph-btn", "false"]]) {
    const btn = subbar.locator(`[data-testid="${tid}"]`);
    await btn.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await btn.getAttribute("aria-pressed"), pressed, `${tid} aria-pressed`);
  }
  // Search + the six icon chips live ON the sub-bar now.
  await subbar.locator('[data-testid="world-search"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await subbar.locator(".wv-chip").count(), 6, "the six icon type-filter chips moved onto the bar");
  // The old shell-topbar mount is gone.
  const slotChildren = await page.locator("#shell-world-topbar-slot").evaluate((el) => el.children.length);
  assert.equal(slotChildren, 0, "the shell topbar world slot no longer hosts search/filters");
  // The old in-tree-head toggle is gone (the clipping complaint dies with it):
  assert.equal(await page.locator('.wv-tree-head [data-testid="wv-tree-mode-toggle"]').count(), 0);
  // …while the left menu keeps "Where things are" / "+ add" / expand-collapse.
  const treeHead = page.locator(".wv-tree-head");
  assert.match(await treeHead.textContent(), /Where things are/);
  await treeHead.locator('[data-testid="world-tree-add-btn"]').waitFor({ state: "visible", timeout: 5000 });
  await treeHead.locator(".wv-expand-toggle").waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

test("W5b: the rail selector switches Spatial -> Graph (the shared graph view actually mounts) and back (the tree actually remounts)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openWorld(page);

  await page.locator('[data-testid="wv-rail-graph-btn"]').click();
  const graphBody = page.locator('[data-testid="world-body-graph"]');
  await graphBody.waitFor({ state: "visible", timeout: 10000 });
  // The SHARED renderer's real SVG, with all four nodes as real .graph-node groups.
  await graphBody.locator('[data-testid="graph-svg"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await graphBody.locator(".graph-node").count(), 4, "every world entity renders as a graph node");
  assert.equal(await page.locator('[data-testid="world-body-tree"]').isVisible(), false, "the tree body is hidden in Graph mode");
  // Zoom controls (shared graph chrome) present -- zoom/pan wiring mounted.
  await graphBody.locator(".graph-zoom-controls").waitFor({ state: "attached", timeout: 5000 });

  // Read-only popover: clicking a node opens the shared popover with its name.
  await graphBody.locator('.graph-node[data-node-id="w5b-city"]').click();
  const popover = graphBody.locator(".graph-popover");
  await popover.waitFor({ state: "visible", timeout: 5000 });
  assert.match(await popover.textContent(), /Bellhaven/);
  assert.equal(await popover.locator(".graph-popover-edit-btn").count(), 0, "read-only: no edit affordances in the World tab's graph mode");

  // And back to Spatial: the tree remounts, graph hides.
  await page.locator('[data-testid="wv-tree-mode-spatial-btn"]').click();
  await page.locator('[data-testid="world-tree-row"][data-entity-id="w5b-city"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await graphBody.isVisible(), false, "graph body hidden again");
  assert.equal(await page.locator('[data-testid="wv-tree-mode-spatial-btn"]').getAttribute("aria-pressed"), "true");
  await page.close();
});

test("W5b: search + icon filters work from the new bar in the tree modes", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openWorld(page);

  // Search narrows the tree (match + its ancestors stay).
  await page.locator('[data-testid="world-search"]').fill("Orla");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="world-tree-row"]')];
    return rows.length === 3 && rows.some((r) => r.textContent.includes("Orla the Smith"));
  }, { timeout: 5000 });
  await page.locator('[data-testid="world-search"]').fill("");

  // Type chip: filter to objects -> the Bell + its ancestor place remain.
  await page.locator('.wv-chip[data-type="object"]').click();
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid="world-tree-row"]')];
    return rows.length === 2 && rows.some((r) => r.textContent.includes("The Great Bell"));
  }, { timeout: 5000 });
  await page.locator('.wv-chip[data-type="object"]').click(); // clear
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="world-tree-row"]').length === 4,
    { timeout: 5000 }
  );
  await page.close();
});

test("W5b: search + icon filters narrow the Graph mode too (same bar drives both bodies)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openWorld(page);
  await page.locator('[data-testid="wv-rail-graph-btn"]').click();
  const graphBody = page.locator('[data-testid="world-body-graph"]');
  await graphBody.locator('[data-testid="graph-svg"]').waitFor({ state: "visible", timeout: 10000 });

  await page.locator('[data-testid="world-search"]').fill("Bell");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="world-body-graph"] .graph-node').length === 2,
    { timeout: 5000 }
  ); // "Bellhaven" + "The Great Bell"
  await page.locator('[data-testid="world-search"]').fill("");
  await page.locator('.wv-chip[data-type="person"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="world-body-graph"] .graph-node').length === 1,
    { timeout: 5000 }
  );
  await page.close();
});

test("W5b: Loyalty stays reachable from the rail selector (tree flips its derivation attribute)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openWorld(page);
  await page.locator('[data-testid="wv-tree-mode-loyalty-btn"]').click();
  await page.waitForFunction(() => {
    const tree = document.querySelector('[data-testid="world-tree"]');
    return tree && tree.getAttribute("data-tree-mode") === "loyalty";
  }, { timeout: 5000 });
  assert.equal(await page.locator('[data-testid="wv-tree-mode-loyalty-btn"]').getAttribute("aria-pressed"), "true");
  await page.close();
});
