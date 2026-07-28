// Phase 15 task 15.2 -- regression test for the rubber-band window-listener
// leak documented in review-ui/public/graph-view.js's wireRubberBandSelection()
// (search "Self-review remediation: a batch's graph re-renders on every
// accept/reject/refresh"):
//
//   Binding fresh `window`-level mousemove/mouseup listeners on every
//   renderGraph() call (which tears down and rebuilds the SVG on every
//   accept/reject/refresh) would leak one more pair of listeners per render,
//   forever, for the life of the page. Fixed by binding those two `window`
//   listeners EXACTLY ONCE per container (guarded by
//   `container._graphRubberBandWired`), reading current
//   nodes/positions/svg/opts from a small mutable record every render
//   refreshes instead.
//
// The task file's own suggestion ("if you can find a more direct way to
// assert listener count via Playwright's own APIs, use it instead") is used
// here: instrument window.addEventListener itself (via an init script, so it
// runs before app.js/graph-view.js ever execute) to count real calls for
// 'mousemove'/'mouseup' -- in batch mode, wireRubberBandSelection is the
// ONLY code in this app that ever registers window-level listeners for
// those two event types (wireGraphPanning/wireEdgeDrawing are standalone-
// mode-only, confirmed by grep before writing this test), so the count
// staying at exactly 1 each across several real re-renders (triggered by
// genuinely accepting mutations via the graph popover, not a synthetic
// re-render call) is a precise, direct proxy for "no leak", not an
// indirect behavioral guess. A trailing functional check (rubber-band
// drag-select still selects the remaining pending node after those
// re-renders) is kept as a secondary, belt-and-suspenders assertion.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-rband-leak-");
const WORLD = "e2e-rband-leak-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "ent-a", name: "Entity A", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "ent-b", name: "Entity B", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "ent-c", name: "Entity C", type: "person", importance: 0.5 } }
]);
function mut(id, name) {
  return {
    op: "upsert_entity",
    id,
    data: { importance: 0.7 },
    rationale: `${name} shifts.`,
    batchId: "placeholder",
    sourceKind: "manual",
    entityContext: { name, importance: 0.7, tags: [] }
  };
}
const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
  mut("ent-a", "Entity A"),
  mut("ent-b", "Entity B"),
  mut("ent-c", "Entity C")
]);

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  // Runs before ANY page script (including app.js's module boot), so it
  // sees every window.addEventListener call the app ever makes.
  await page.addInitScript(() => {
    window.__wlCounts = { mousemove: 0, mouseup: 0 };
    const origAdd = window.addEventListener.bind(window);
    window.addEventListener = function (type, listener, options) {
      if (type === "mousemove" || type === "mouseup") window.__wlCounts[type] += 1;
      return origAdd(type, listener, options);
    };
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function acceptViaPopover(entityId) {
  const node = page.locator(`.graph-node[data-node-id="${entityId}"]`);
  await node.waitFor({ state: "visible", timeout: 15000 });
  await node.click();
  const acceptBtn = page.locator(".graph-popover .graph-popover-actions .btn--accept");
  await acceptBtn.waitFor({ state: "visible" });
  await acceptBtn.click();
  await page.locator(".graph-popover").waitFor({ state: "hidden", timeout: 15000 });
}

test("repeated graph re-renders never accumulate extra window-level rubber-band listeners", async () => {
  await page.goto(`${base}/#review/${batch.id}`);
  await page.locator('[data-review-mode="graph"]').click();

  // First render: wireRubberBandSelection wires its two window listeners
  // exactly once.
  await page.locator('.graph-node[data-node-id="ent-a"]').waitFor({ state: "visible", timeout: 15000 });
  let counts = await page.evaluate(() => window.__wlCounts);
  assert.equal(counts.mousemove, 1, "exactly one window mousemove listener after the first render");
  assert.equal(counts.mouseup, 1, "exactly one window mouseup listener after the first render");

  // Accept two mutations in sequence via the graph popover -- each accept
  // triggers refreshReviewDetail -> renderReviewFromState -> renderReviewGraph
  // -> a full renderGraph() teardown-and-rebuild of the SVG, the exact
  // re-render this bug leaked a listener pair on every time.
  await acceptViaPopover("ent-a");
  await page.locator('.graph-node[data-node-id="ent-b"]').waitFor({ state: "visible", timeout: 15000 });
  await acceptViaPopover("ent-b");
  await page.locator('.graph-node[data-node-id="ent-c"]').waitFor({ state: "visible", timeout: 15000 });

  counts = await page.evaluate(() => window.__wlCounts);
  assert.equal(counts.mousemove, 1, "still exactly one window mousemove listener after two re-renders (no leak)");
  assert.equal(counts.mouseup, 1, "still exactly one window mouseup listener after two re-renders (no leak)");

  // Secondary, functional proxy: rubber-band drag-select must still work
  // correctly against the CURRENT (third) render's live nodes/positions.
  const container = page.locator("#review-graph");
  const box = await container.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 12 });
  await page.mouse.up();

  // ent-c is the only remaining pending mutation -- its checkbox should now
  // be checked, since a full-container drag encloses every node.
  const remainingRow = page.locator(".mutation-row").filter({ hasText: "Entity C" });
  await assert.doesNotReject(async () => {
    await remainingRow.locator(".row-check").waitFor({ state: "attached" });
  });
  assert.ok(
    await remainingRow.locator(".row-check").isChecked(),
    "rubber-band drag-select must still correctly select the remaining pending node after repeated re-renders"
  );
});
