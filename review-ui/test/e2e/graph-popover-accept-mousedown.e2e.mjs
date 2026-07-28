// Phase 15 task 15.2 -- regression test for the mousedown-bubbling-into-
// rubber-band-drag bug documented in review-ui/public/graph-view.js's
// showPopover() (search "A real bug found only by actually clicking Reject
// in a browser"):
//
//   The popover is a direct child of `container`, the SAME element
//   wireRubberBandSelection binds its rubber-band-drag `mousedown` listener
//   to. Without `el.addEventListener("mousedown", evt => evt.stopPropagation())`,
//   a mousedown on the popover's own Accept/Reject button bubbles up to that
//   container-level listener, which calls closePopover() and removes the
//   button from the DOM before its `click` event ever fires -- so
//   Accept/Reject from the popover silently did nothing.
//
// This test reproduces the exact batch-mode-Graph-view scenario: open a
// pending mutation's node popover and click Accept, then confirms the REAL
// API call actually fired and the mutation's status genuinely persisted as
// accepted -- not just that the popover visually stayed open.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-popover-mousedown-");
const WORLD = "e2e-popover-mousedown-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.7 } }
]);
const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
  {
    op: "upsert_entity",
    id: "alvor",
    data: { importance: 0.6 },
    rationale: "Alvor's standing shifts.",
    batchId: "placeholder",
    sourceKind: "manual",
    entityContext: { name: "Alvor", importance: 0.6, tags: [] }
  }
]);
const mutationId = batch.mutations[0].mutationId;

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

test("Accept from a batch-mode graph popover actually fires and persists (mousedown stopPropagation fix)", async () => {
  await page.goto(`${base}/#review/${batch.id}`);
  await page.locator('[data-review-mode="graph"]').click();

  const node = page.locator('.graph-node[data-node-id="alvor"]');
  await node.waitFor({ state: "visible", timeout: 15000 });
  await node.click();

  const popover = page.locator(".graph-popover");
  await popover.waitFor({ state: "visible" });
  const acceptBtn = popover.locator(".graph-popover-actions .btn--accept");
  await acceptBtn.waitFor({ state: "visible" });
  await acceptBtn.click();

  // Real regression proof, not just "the popover looks fine": poll the real
  // on-disk batch state for the status transition a real API call produces.
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 50; i++) {
      const reloaded = loadBatch(WORLD, batch.id);
      const m = reloaded.mutations.find((mu) => mu.mutationId === mutationId);
      if (m?.status === "accepted") return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("mutation never transitioned to accepted");
  });
});
