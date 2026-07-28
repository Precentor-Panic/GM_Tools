// Phase 15 task 15.2 -- regression test for the placement-click bug
// documented in review-ui/public/graph-view.js's armPlacementMode() (search
// "found via real browser testing, not obvious from reading the code"):
//
//   Without `evt.stopPropagation()` (called from a CAPTURE-phase listener,
//   so it fires before a node's own bubble-phase click handler), a placement
//   click that lands on top of an existing node continues on to that node's
//   own click handler -> showPopover() -> closePopover(), which removes the
//   create-node form armPlacementMode's own handler just opened, and shows
//   the EXISTING node's popover instead. One placement click must resolve
//   to exactly one outcome: the create-node form for the clicked point.
//
// This test arms placement mode ("+ Add Node"), then clicks directly on top
// of an already-rendered node, and confirms the create-node form opens (not
// the existing node's own view/edit popover).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-placement-click-");
const WORLD = "e2e-placement-click-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "node-a", name: "Node A", type: "person", importance: 0.4 } }
]);

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

test("placement click landing on an existing node opens the create-node form, not that node's own popover", async () => {
  await page.goto(`${base}/#graph`);
  const node = page.locator('.graph-node[data-node-id="node-a"]');
  await node.waitFor({ state: "visible", timeout: 15000 });

  await page.locator("#btn-graph-add-node").click();
  await page.locator(".graph-view-container.graph-placement-active").waitFor({ state: "visible" });

  // Click exactly on top of the existing node.
  await node.click();

  const popover = page.locator(".graph-popover");
  await popover.waitFor({ state: "visible" });
  assert.equal(await page.locator(".graph-popover").count(), 1, "exactly one popover must be open");
  assert.ok(await page.locator(".graph-create-form").isVisible(), "the create-node form must be the one that opened");
  const title = await page.locator(".graph-popover-title").textContent();
  assert.equal(title, "New node", "must be the create form, not Node A's own view/edit popover");
  // The existing node's own edit/delete affordances must NOT be present --
  // that would mean its popover opened instead.
  assert.equal(await page.locator(".graph-popover-editrow").count(), 0, "the existing node's own popover editrow must not be present");
});
