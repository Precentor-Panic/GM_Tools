// Phase 25 task 25.0, REQUIRED SCENARIO 6 -- "Member roster nested expand: a
// member row's persistent (non-hover) expand reveals description/summary/
// imageUrl/tags; assert no cap on how many rows can be simultaneously
// expanded (open 3+, all stay open) per the adjudicated 'start unbounded'
// decision -- this test exists specifically to lock in that decision so a
// future implementer doesn't 'fix' it into an accordion by assumption."
// Read table-mode-fixture.mjs's header FIRST (§4 is this file's own
// section). EXPECTED TO FAIL right now -- none of `table-roster`/
// `table-roster-row`/`table-roster-detail` exists yet. That failure is the
// deliverable of this task, not a bug in this file.
//
// FIXTURE: one anchor entity connected to TWO satellites (both real,
// 1-hop, within brief.mjs's DEFAULT_CORRIDOR_TOLERANCE=2), giving 3 real
// roster rows -- the minimum needed to prove "open 3+ simultaneously, all
// stay open" per this scenario's own explicit bar. Each of the 3 carries
// its own distinct description/summary/imageUrl/tags so this file can also
// confirm the RIGHT row's own data renders in the RIGHT row's own detail
// panel, not a shared/mixed-up rendering.
//
// FLAGGED (see table-mode-fixture.mjs's header, bottom section): as of this
// writing, review-ui/server.mjs's graphNodePayload() does not yet return
// summary/imageUrl/tags at all (only description/status/playerKnown/
// canonLocked/role/attributes) -- confirmed directly by reading the route.
// This file still asserts the full, adjudicated §3 contract; the payload
// gap is real implementation scope for task 25.3, not a defect in this
// test.
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

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-roster-");
const WORLD = "e2e-tablemode-roster-world";
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
      id: "tmroster-anchor", name: "Roster Anchor Hall", type: "place", importance: 0.5,
      description: "The anchor hall's own full description text.",
      summary: "Anchor hall summary.",
      imageUrl: "https://example.test/anchor.png",
      tags: ["anchor-tag-1", "anchor-tag-2"]
    }
  },
  {
    op: "upsert_entity",
    data: {
      id: "tmroster-sat1", name: "Roster Satellite One", type: "person", importance: 0.5,
      description: "Satellite one's full description text.",
      summary: "Satellite one summary.",
      imageUrl: "https://example.test/sat1.png",
      tags: ["sat1-tag"]
    }
  },
  {
    op: "upsert_entity",
    data: {
      id: "tmroster-sat2", name: "Roster Satellite Two", type: "person", importance: 0.5,
      description: "Satellite two's full description text.",
      summary: "Satellite two summary.",
      imageUrl: "https://example.test/sat2.png",
      tags: ["sat2-tag"]
    }
  },
  { op: "upsert_edge", data: { id: "tmroster-e0", sourceId: "tmroster-anchor", targetId: "tmroster-sat1", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "tmroster-e1", sourceId: "tmroster-anchor", targetId: "tmroster-sat2", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmroster-anchor" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("all 3 roster rows render, each with a persistently-visible (non-hover) expand button", async () => {
  await gotoTableMode(page, base, scene.id);
  const roster = page.locator('[data-testid="table-roster"]');
  await roster.waitFor({ state: "visible", timeout: 15000 });

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="table-roster-row"]').length === 3, { timeout: 10000 });
  }, "expected 3 roster rows: the anchor plus its 2 real 1-hop satellites");

  for (const id of ["tmroster-anchor", "tmroster-sat1", "tmroster-sat2"]) {
    const row = roster.locator(`[data-testid="table-roster-row"][data-entity-id="${id}"]`);
    const expandBtn = row.locator('[data-testid="table-roster-expand-btn"]');
    // Playwright's own visibility check already fails a button that's only
    // reachable via :hover (a hover-only trigger would not be considered
    // "visible" the same way, and this suite never calls .hover() anywhere
    // in this file, only .click()).
    await expandBtn.waitFor({ state: "visible", timeout: 5000 });
  }
});

test("expanding a row reveals THAT entity's own description/summary/image/tags -- no cross-row mixing", async () => {
  await gotoTableMode(page, base, scene.id);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="table-roster-row"]').length === 3, { timeout: 15000 });

  const sat1Row = page.locator('[data-testid="table-roster-row"][data-entity-id="tmroster-sat1"]');
  await sat1Row.locator('[data-testid="table-roster-expand-btn"]').click();

  const detail = page.locator('[data-testid="table-roster-detail"][data-entity-id="tmroster-sat1"]');
  await detail.waitFor({ state: "visible", timeout: 10000 });

  assert.match((await detail.locator('[data-testid="table-roster-detail-description"]').textContent()) ?? "", /Satellite one's full description/);
  assert.match((await detail.locator('[data-testid="table-roster-detail-summary"]').textContent()) ?? "", /Satellite one summary/);
  const imgSrc = await detail.locator('[data-testid="table-roster-detail-image"]').getAttribute("src");
  assert.equal(imgSrc, "https://example.test/sat1.png");
  const tagEls = detail.locator('[data-testid="table-roster-detail-tag"]');
  assert.equal(await tagEls.count(), 1);
  assert.equal((await tagEls.first().textContent()).trim(), "sat1-tag");
});

test("no cap: expanding 3 rows simultaneously leaves ALL 3 open at once -- locks in the adjudicated 'start unbounded' decision (design record §5)", async () => {
  await gotoTableMode(page, base, scene.id);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="table-roster-row"]').length === 3, { timeout: 15000 });

  const entityIds = ["tmroster-anchor", "tmroster-sat1", "tmroster-sat2"];
  for (const id of entityIds) {
    const row = page.locator(`[data-testid="table-roster-row"][data-entity-id="${id}"]`);
    await row.locator('[data-testid="table-roster-expand-btn"]').click();
  }

  for (const id of entityIds) {
    const detail = page.locator(`[data-testid="table-roster-detail"][data-entity-id="${id}"]`);
    assert.equal(await detail.isVisible(), true, `entity ${id}'s detail must be visible after expanding all 3 -- expanding a later row must NOT collapse an earlier one`);
  }

  // Re-confirm the FIRST one expanded (the anchor) is STILL open after the
  // 3rd expand click -- the specific regression an accordion/cap
  // implementation would introduce.
  const anchorDetail = page.locator('[data-testid="table-roster-detail"][data-entity-id="tmroster-anchor"]');
  assert.equal(await anchorDetail.isVisible(), true, "the FIRST-expanded row (anchor) must remain open even after 2 more rows were subsequently expanded");
});
