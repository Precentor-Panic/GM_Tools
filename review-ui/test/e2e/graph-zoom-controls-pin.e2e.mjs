// Phase 20 task 20.3 -- regression test for the zoom-controls-scrolls-away
// bug documented in review-ui/public/graph-view.js's ensureGraphWrapper()
// (search "Real-usage bug (task 20.3)"):
//
//   `.graph-zoom-controls` (style.css, `position: absolute; top: 0.5rem;
//   right: 0.5rem`) used to be appended as a DIRECT CHILD of `container` --
//   the SAME element that is both `.graph-view-container`'s positioning
//   context (`position: relative`) AND its own scroll/pan mechanism
//   (`overflow: auto` -- scrolling IS the pan mechanism). An
//   absolutely-positioned child of a scrollable positioned ancestor scrolls
//   WITH that ancestor's content instead of staying pinned to the visible
//   viewport corner -- invisible at low zoom (nothing needs to scroll), but
//   real at any working zoom level once the graph needs panning to see
//   more of it. Fixed by giving `container` a non-scrolling OUTER wrapper
//   (`.graph-view-wrapper`) that the zoom bar attaches to instead, a
//   sibling of the scrollable element, not a descendant.
//
// This test renders a graph dense enough that its viewBox genuinely exceeds
// the container's fixed on-screen size at 100% zoom (so real scrolling is
// required, not just theoretically possible), scrolls the container by a
// real, substantial amount, and asserts the zoom-controls bar's own
// bounding box is UNCHANGED -- a genuine before/after geometry assertion
// against real rendered layout, not just "the element still exists in the
// DOM." Covers both real call sites (standalone Graph view AND Batch
// Review's Graph toggle), per the task's own instruction not to assume
// there's only one caller.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-zoom-pin-");
const WORLD = "e2e-zoom-pin-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

// 20 entities in a chain -- enough that layoutDimsForNodeCount's
// sqrt(nodeCount/8) scale-up makes the rendered SVG genuinely bigger than
// the container's fixed 560px-tall/100%-wide box at zoom 100%, so both
// axes require real scrolling to see the rest of the graph (confirmed via
// this exact fixture during this task's own investigation).
const N = 20;
const muts = [];
for (let i = 0; i < N; i++) {
  muts.push({ op: "upsert_entity", data: { id: `ent-${i}`, name: `Entity ${i}`, type: "person", importance: 0.5 } });
}
for (let i = 0; i < N - 1; i++) {
  muts.push({ op: "upsert_edge", data: { id: `edge-${i}`, sourceId: `ent-${i}`, targetId: `ent-${i + 1}`, relationshipType: "social" } });
}
applyHeadless(snapPath, muts);

function mut(id, name) {
  return {
    op: "upsert_entity", id, data: { importance: 0.7 }, rationale: `${name} shifts.`,
    batchId: "placeholder", sourceKind: "manual", entityContext: { name, importance: 0.7, tags: [] }
  };
}
const batch = createBatch(
  WORLD, { mode: "manual" }, "a test session",
  Array.from({ length: N }, (_, i) => mut(`ent-${i}`, `Entity ${i}`))
);

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

/**
 * Scrolls `containerSelector` by a real, substantial amount and confirms
 * `.graph-zoom-controls`'s own bounding box (position:fixed-feeling, but
 * really position:absolute against the non-scrolling wrapper) is pixel-for-
 * pixel unchanged before vs after -- the actual bug this test guards
 * against would show the bar's top/left shrinking or its content scrolling
 * out of the visible area entirely.
 */
async function assertZoomBarStaysPinned(containerSelector) {
  const container = page.locator(containerSelector);
  const zoomBar = page.locator(`${containerSelector} + .graph-zoom-controls, ${containerSelector} ~ .graph-zoom-controls`).first();
  // The zoom bar is a SIBLING of the scrollable container (child of the
  // wrapper), not a descendant -- confirm that structural fact directly,
  // since it's the actual mechanism the fix relies on.
  const isSibling = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const bar = c?.parentElement?.querySelector(":scope > .graph-zoom-controls");
    return !!bar && bar.parentElement === c.parentElement && c.parentElement !== c;
  }, containerSelector);
  assert.ok(isSibling, "the zoom-controls bar must be a sibling of the scrollable container (child of the non-scrolling wrapper), not a descendant of it");

  const before = await zoomBar.boundingBox();
  assert.ok(before, "zoom bar must have a real bounding box before scrolling");

  // Confirm the graph genuinely needs scrolling at 100% zoom (the bug is
  // invisible otherwise) before asserting anything about panning it.
  const { scrollWidth, scrollHeight, clientWidth, clientHeight } = await container.evaluate((el) => ({
    scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight
  }));
  assert.ok(scrollWidth > clientWidth + 50, "fixture must genuinely overflow horizontally at 100% zoom for this test to mean anything");
  assert.ok(scrollHeight > clientHeight + 50, "fixture must genuinely overflow vertically at 100% zoom for this test to mean anything");

  // A real, substantial scroll/pan -- not a token 1px nudge.
  await container.evaluate((el) => { el.scrollTop = 250; el.scrollLeft = 200; });
  await page.waitForTimeout(100);

  const scrolled = await container.evaluate((el) => ({ scrollTop: el.scrollTop, scrollLeft: el.scrollLeft }));
  assert.ok(scrolled.scrollTop > 100, "container must have genuinely scrolled vertically");
  assert.ok(scrolled.scrollLeft > 100, "container must have genuinely scrolled horizontally");

  const after = await zoomBar.boundingBox();
  assert.ok(after, "zoom bar must still have a real bounding box after scrolling");
  assert.equal(after.x, before.x, "zoom bar's x position must be unchanged after scrolling the graph content (pinned, not scrolled away)");
  assert.equal(after.y, before.y, "zoom bar's y position must be unchanged after scrolling the graph content (pinned, not scrolled away)");
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);

  // Also confirm it's still actually usable from its pinned spot -- click
  // Reset and confirm the zoom label reacts, proving this isn't a decoy
  // element sitting at the right coordinates while the real interactive
  // bar is elsewhere.
  const resetBtn = page.locator(`${containerSelector} ~ .graph-zoom-controls .graph-zoom-reset, ${containerSelector} + .graph-zoom-controls .graph-zoom-reset`).first();
  await resetBtn.click();
  const label = page.locator(`${containerSelector} ~ .graph-zoom-controls .graph-zoom-label, ${containerSelector} + .graph-zoom-controls .graph-zoom-label`).first();
  assert.equal(await label.textContent(), "100%", "zoom controls must still be genuinely functional from their pinned position");
}

test("standalone Graph view: zoom controls stay pinned to the viewport corner while the graph is scrolled", async () => {
  await page.goto(`${base}/#graph`);
  await page.locator("#graph-standalone .graph-node").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(300); // let force layout / zoom controls settle
  await assertZoomBarStaysPinned("#graph-standalone");
});

// Phase 37 task 37.3 RECONCILIATION (retire-as-superseded): the second call
// site this test covered -- Batch Review's Graph toggle (`#review/<batchId>`
// -> `[data-review-mode="graph"]` -> `#review-graph`) -- is RETIRED with the
// #review screen. The zoom-controls-pin fix lives in the shared graph-view.js
// and is still exercised by the standalone `#graph` test above (the ONE
// surviving call site), so the regression guard is preserved; the retired
// duplicate against the now-deleted #review-graph mount is removed here.
// (The `batch` fixture above is left in place; it is cheap and harmless.)
