// Phase 26 task 26.0, REQUIRED SCENARIO 10 -- "Tags are absent from the
// roster detail expand DOM (not just visually hidden)." Read
// phase26-fixture.mjs's header FIRST (§10 is this file's own section).
// EXPECTED TO FAIL right now -- `table-roster-detail-tag` still renders
// today (Phase 25's real, live, unmodified `buildTableRosterDetail`) for an
// entity with a non-empty `tags` array. That failure is the deliverable of
// this task, not a bug in this file.
//
// Per §26.G: "Leave the underlying graphNodePayload/entity data untouched
// (still fetched, just not rendered here) -- this is a display change, not
// a data-removal." This file's fixture deliberately seeds a REAL non-empty
// `tags` array so the absence assertion is meaningful (an entity with NO
// tags at all would trivially "pass" a naive absence check for the wrong
// reason).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoTableMode,
  DESKTOP_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tags-absent-");
const WORLD = "e2e-tags-absent-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  {
    op: "upsert_entity",
    data: {
      id: "tagsabsent-anchor", name: "Tags-Absent Anchor", type: "place", importance: 0.5,
      description: "A description that should still render.",
      summary: "A short summary that should still render.",
      tags: ["dangerous", "unexplored", "cult-activity"]
    }
  }
]);

let server, base, browser, page;
let scene;
const entityId = "tagsabsent-anchor";

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: entityId });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("***Phase 26 fix***: an entity with a real non-empty tags array renders zero table-roster-detail-tag elements -- real DOM-absence, description/summary unaffected", async () => {
  // Sanity: confirm the fetched entity data really does still carry tags
  // (§26.G: "data fetch untouched") -- if this fails, the bug is in this
  // test's own fixture/assumption, not the removal under test.
  const graphRes = await (await fetch(`${base}/api/graph?world=${WORLD}&filter=all`)).json();
  const node = (graphRes.nodes ?? []).find((n) => n.id === entityId);
  assert.ok(node, "sanity: the anchor entity must exist in the fetched graph payload");

  await gotoTableMode(page, base, scene.id);
  const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${entityId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-testid="table-roster-expand-btn"]').click();

  const detail = page.locator(`[data-testid="table-roster-detail"][data-entity-id="${entityId}"]`);
  await detail.waitFor({ state: "visible", timeout: 10000 });

  assert.match((await detail.locator('[data-testid="table-roster-detail-description"]').textContent()) ?? "", /should still render/, "description must be unaffected by this task");
  assert.match((await detail.locator('[data-testid="table-roster-detail-summary"]').textContent()) ?? "", /should still render/, "summary must be unaffected by this task");

  const tagCount = await page.evaluate(() => document.querySelectorAll('[data-testid="table-roster-detail-tag"]').length);
  assert.equal(tagCount, 0, "table-roster-detail-tag must be COMPLETELY REMOVED from the render (§26.G), even though the underlying entity genuinely has 3 real tags");

  const bodyText = await detail.textContent();
  for (const tag of ["dangerous", "unexplored", "cult-activity"]) {
    assert.ok(!(bodyText ?? "").includes(tag), `the literal tag text "${tag}" must not appear anywhere in the roster detail's rendered text either`);
  }
});
