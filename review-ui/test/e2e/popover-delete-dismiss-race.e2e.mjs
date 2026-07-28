// Phase 15 task 15.2 -- regression test for the popover dismiss-race bug
// documented in review-ui/public/graph-view.js's showPopover(), in the
// outside-click listener's own comment (search "A real bug found only by
// actually clicking Delete in a browser"):
//
//   showNodeDeleteConfirm() REMOVES the delete button's own parent
//   (.graph-popover-editrow) as part of handling the SAME click that opened
//   it. That detaches the click's evt.target from the popover element (`el`)
//   before the outside-click listener (bubble-phase, fires after the
//   button's own handler) gets to check it. The OLD, buggy check was
//   `el.contains(evt.target)` -- since evt.target (the delete button) was
//   just detached from `el`'s subtree, that wrongly reports "not contained"
//   for a click that started squarely inside the popover, closing the
//   popover out from under the very confirm UI that same click just opened.
//   The fix is `evt.composedPath().includes(el)` -- composedPath() reflects
//   the ORIGINAL ancestor chain at DISPATCH time, before showNodeDeleteConfirm
//   ever ran, so it's immune to the mid-click DOM mutation.
//
// This test reproduces that exact scenario end-to-end against a real running
// server + real headless Chromium: open a node's popover, click its trash
// icon, and confirm the resulting delete-confirm UI (message + Delete/Cancel
// buttons) is still present and clickable, not silently gone -- then proves
// "functional, not just visually present" by actually clicking Delete and
// confirming the entity is genuinely gone afterward.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-popover-dismiss-");
const WORLD = "e2e-popover-dismiss-world";
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

test("clicking a node's delete icon keeps the confirm UI open and functional (composedPath fix)", async () => {
  await page.goto(`${base}/#graph`);
  const node = page.locator('.graph-node[data-node-id="node-a"]');
  await node.waitFor({ state: "visible", timeout: 15000 });
  await node.click();

  const popover = page.locator(".graph-popover");
  await popover.waitFor({ state: "visible" });
  const deleteBtn = popover.locator(".graph-popover-delete-btn");
  await deleteBtn.waitFor({ state: "visible" });
  await deleteBtn.click();

  // The exact scenario the bug broke: right after this same click,
  // .graph-popover must STILL be in the DOM with its confirm UI, not
  // silently removed by the outside-click listener.
  const confirmBox = page.locator(".graph-popover .graph-delete-confirm");
  await confirmBox.waitFor({ state: "visible", timeout: 2000 });
  assert.ok(await popover.isVisible(), "popover must still be visible after clicking Delete");
  const confirmDeleteBtn = confirmBox.locator(".btn--reject");
  const cancelBtn = confirmBox.locator(".btn--ghost");
  assert.ok(await confirmDeleteBtn.isVisible(), "the confirm box's own Delete button must be visible");
  assert.ok(await cancelBtn.isVisible(), "the confirm box's own Cancel button must be visible");

  // "Functional, not silently gone": actually completing the delete must work.
  await confirmDeleteBtn.click();
  await popover.waitFor({ state: "hidden", timeout: 15000 });

  const res = await page.request.get(`${base}/api/graph?world=${encodeURIComponent(WORLD)}&filter=all`);
  const body = await res.json();
  assert.ok(
    !body.nodes.some((n) => n.id === "node-a"),
    "node-a must genuinely be deleted from the graph after confirming"
  );
});
