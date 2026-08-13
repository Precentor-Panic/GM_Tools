// QA fix-wave W1, Fix 1 (BLOCKER): a fresh, completely empty World tab
// previously offered NO way to create the first entity at all -- the only
// creation affordance (world-view.js's buildActions(sel)'s "+ Add something
// here") lives inside the DETAIL pane, which only ever renders once a node
// is already selected; an empty tree has nothing to select. This suite
// proves the fix: a new, always-available "+ add" affordance in the tree
// pane header (`world-tree-add-btn`), reachable with NOTHING selected,
// opens an UNANCHORED add flow (POST /api/graph/nodes, no reparent) that
// can create either a Place or a Person as a graph root -- and that the
// pre-existing selected-node add flow is completely untouched by this
// change.
//
// Matches phase30-world-surface.e2e.mjs's own established style: real HTTP
// server + real headless-Chromium browser (Playwright), a scratch world
// seeded directly via bootstrapSnapshot/applyHeadless.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-qa-w1-world-empty-add-");
const WORLD = "e2e-qa-w1-empty-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

// A genuinely EMPTY world -- bootstrapSnapshot alone, no applyHeadless seed
// call at all. This is the exact "fresh world's empty tree" scenario the
// persona finding reported.
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

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

async function primeWorldSelection(page) {
  await page.goto(`${base}/#graph`);
  await page.evaluate((w) => localStorage.setItem("gmReview.world", w), WORLD);
}

async function fetchGraph(page) {
  return page.evaluate(async ({ base, world }) => {
    const res = await fetch(`${base}/api/graph?world=${encodeURIComponent(world)}&filter=all`);
    return res.json();
  }, { base, world: WORLD });
}

test("a fresh, completely empty world's tree shows the empty-state hint AND the always-available add affordance -- with nothing selected", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page);
  await page.goto(`${base}/#world`);

  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="world-tree-empty-hint"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="world-tree-row"]').count(), 0, "precondition: truly empty tree");

  const addBtn = page.locator('[data-testid="world-tree-add-btn"]');
  await addBtn.waitFor({ state: "visible", timeout: 10000 });
  // Nothing is selected -- the detail pane's own "Add something here" (a
  // completely different, still-selection-gated affordance) must NOT be
  // mistaken for this fix; confirm the empty-detail placeholder is showing
  // instead, i.e. genuinely nothing selected.
  await page.locator('[data-testid="world-detail"]').waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
  assert.equal(await page.locator('[data-testid="world-detail"]').count(), 0, "nothing should be selected yet");

  await page.close();
});

test("the unanchored add flow creates a PLACE, then a PERSON, both as graph roots -- from a completely empty world", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-tree-add-btn"]').waitFor({ state: "visible", timeout: 15000 });

  // --- Create a place (the default type pill) ---
  await page.locator('[data-testid="world-tree-add-btn"]').click();
  const panel = page.locator('[data-testid="wv-tree-add-panel"]');
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="wv-tree-add-input"]').fill("Windhollow Keep");
  await page.locator('[data-testid="wv-tree-add-commit"]').click();

  await page.locator('[data-testid="world-tree-row"][data-entity-id]').first().waitFor({ state: "visible", timeout: 10000 });
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="world-tree-row"]')];
      return rows.some((r) => r.textContent.includes("Windhollow Keep"));
    }, { timeout: 10000 });
  }, "the created place must render in the tree");

  // --- Create a person (switch the type pill first) ---
  await page.locator('[data-testid="world-tree-add-btn"]').click();
  await page.locator('[data-testid="wv-tree-add-panel"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="wv-tree-add-panel"] .wv-type-pill[data-type="person"]').click();
  await page.locator('[data-testid="wv-tree-add-input"]').fill("Cinder Wren");
  await page.locator('[data-testid="wv-tree-add-commit"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="world-tree-row"]')];
      return rows.some((r) => r.textContent.includes("Cinder Wren"));
    }, { timeout: 10000 });
  }, "the created person must render in the tree");

  assert.equal(await page.locator('[data-testid="world-tree-row"]').count(), 2, "both created entities must be visible in the tree");
  // The empty-state hint must be gone now that the world is no longer empty.
  assert.equal(await page.locator('[data-testid="world-tree-empty-hint"]').count(), 0);

  // BOTH must be graph ROOTS -- no containment edge was created by this
  // unanchored flow (unlike the selected-node "Add something here" flow,
  // which reparents under the selection).
  const graph = await fetchGraph(page);
  const place = graph.nodes.find((n) => n.name === "Windhollow Keep");
  const person = graph.nodes.find((n) => n.name === "Cinder Wren");
  assert.ok(place && place.type === "place");
  assert.ok(person && person.type === "person");
  const containmentEdges = graph.edges.filter((e) => e.relationshipType === "containment");
  assert.equal(containmentEdges.some((e) => e.sourceId === place.id || e.sourceId === person.id), false,
    "an unanchored create must not create any containment edge");

  await page.close();
});

test("the EXISTING selected-node 'Add something here' flow is completely untouched -- still reparents the new node under the selection", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-tree-row"]').first().waitFor({ state: "visible", timeout: 15000 });

  // Select the place created by the prior test (world state persists across
  // tests in this file, same convention phase30-world-surface.e2e.mjs uses).
  const placeRow = page.locator('[data-testid="world-tree-row"]', { hasText: "Windhollow Keep" });
  await placeRow.click();
  await page.locator('[data-testid="world-detail"]').waitFor({ state: "visible", timeout: 10000 });

  const addSomethingBtn = page.locator('[data-testid="world-detail"] .wv-action--dashed', { hasText: "Add something here" });
  await addSomethingBtn.waitFor({ state: "visible", timeout: 10000 });
  await addSomethingBtn.click();

  const panel = page.locator('[data-testid="world-detail"] .wv-action-panel-host .wv-inline-panel');
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await panel.locator(".wv-inline-input").fill("A Locked Chest");
  await panel.locator(".wv-inline-commit").click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="world-tree-row"]')];
      return rows.some((r) => r.textContent.includes("A Locked Chest"));
    }, { timeout: 10000 });
  }, "the selected-node add flow must still create the child entity");

  const graph = await fetchGraph(page);
  const place = graph.nodes.find((n) => n.name === "Windhollow Keep");
  const chest = graph.nodes.find((n) => n.name === "A Locked Chest");
  assert.ok(place && chest);
  assert.ok(
    graph.edges.some((e) => e.relationshipType === "containment" && e.sourceId === chest.id && e.targetId === place.id),
    "the selected-node flow must still reparent the new node under the selection -- unlike the new unanchored flow"
  );

  await page.close();
});
