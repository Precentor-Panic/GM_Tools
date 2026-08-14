// Friction Wave 1, W5d (stretch, Review-UX round 3 item 6) — the one-hop
// LOCAL graph in the World tab's detail pane: selected entity centered,
// every directly-connected node around it, edges color-coded by
// relationship type (legend + midpoint labels), neighbor click = select.
// The rest of item 6's panel (title, description, develop hook, contents,
// action buttons, loose threads) already exists in this pane — the local
// graph was the missing piece.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-w5d-local-");
const WORLD = "e2e-w5d-local-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "w5d-hub", name: "The Loom", type: "place", importance: 0.7 } },
  { op: "upsert_entity", data: { id: "w5d-hall", name: "Dyers' Hall", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "w5d-vane", name: "Master Vane", type: "person", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "w5d-guild", name: "Weavers' Guild", type: "faction", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "w5d-lonely", name: "Unconnected Stone", type: "object", importance: 0.2 } },
  // Three different relationship types touching the hub.
  { op: "upsert_edge", data: { id: "w5d-e1", sourceId: "w5d-hall", targetId: "w5d-hub", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "w5d-e2", sourceId: "w5d-vane", targetId: "w5d-hub", relationshipType: "presence" } },
  { op: "upsert_edge", data: { id: "w5d-e3", sourceId: "w5d-guild", targetId: "w5d-hub", relationshipType: "ownership" } }
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

test("W5d: selecting an entity renders its one-hop local graph — center + neighbors, edges color-coded by relationship type, legend matching", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/w5d-hub`);
  const graph = page.locator('[data-testid="world-local-graph"][data-entity-id="w5d-hub"]');
  await graph.waitFor({ state: "visible", timeout: 15000 });

  assert.equal(await graph.locator('[data-testid="world-local-graph-node"]').count(), 4, "center + 3 neighbors");
  assert.equal(await graph.locator('[data-testid="world-local-graph-edge"]').count(), 3);

  // Color-coding contract: each edge's stroke matches its own type's legend
  // swatch, and every distinct type appears in the legend.
  const kinds = ["containment", "presence", "ownership"];
  for (const kind of kinds) {
    const edge = graph.locator(`[data-testid="world-local-graph-edge"][data-relationship-type="${kind}"]`);
    assert.equal(await edge.count(), 1, `an edge for ${kind}`);
    assert.ok(await edge.getAttribute("stroke"), "edges carry an explicit color");
    const swatch = graph.locator(`[data-testid="world-local-graph-legend"] [data-relationship-type="${kind}"] .wv-local-graph-swatch`);
    assert.equal(await swatch.count(), 1, `${kind} in the legend`);
    // Compare COMPUTED colors (the browser normalizes hsl()/inline styles to
    // the same rgb() form) — the real "same color" contract.
    const strokeComputed = await edge.evaluate((el) => getComputedStyle(el).stroke);
    const swatchComputed = await swatch.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(swatchComputed, strokeComputed, `legend swatch color matches the ${kind} edge stroke`);
  }
  await page.close();
});

test("W5d: clicking a neighbor node selects it (hash + detail follow); an unconnected entity shows no local graph", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/w5d-hub`);
  await page.locator('[data-testid="world-local-graph"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="world-local-graph-node"][data-entity-id="w5d-vane"]').click();
  await page.waitForFunction(() => location.hash === "#world/w5d-vane", { timeout: 10000 });
  await page.locator('[data-testid="world-detail"][data-entity-id="w5d-vane"]').waitFor({ state: "visible", timeout: 10000 });
  // Vane's own local graph now centers on him with the hub as a neighbor.
  await page.locator('[data-testid="world-local-graph"][data-entity-id="w5d-vane"]').waitFor({ state: "visible", timeout: 10000 });

  // No edges -> no local-graph section at all (not an empty frame).
  await page.goto(`${base}/#world/w5d-lonely`);
  await page.locator('[data-testid="world-detail"][data-entity-id="w5d-lonely"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="world-local-graph"]').count(), 0);
  await page.close();
});
