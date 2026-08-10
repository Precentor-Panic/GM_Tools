// Phase 38 task 38.0 -- the Loyalty contract (phase38-fixture.mjs §6):
// Spatial|Loyalty toggle in wv-tree-head, the {membership,fealty}-derived
// tree, the anchorMembership op + route, and drag-in-Loyalty-mode semantics.
// Read phase38-fixture.mjs's header (§6) FIRST.
//
// Tests 1-3 are RED: `wv-tree-mode-toggle`/`wv-tree-mode-spatial-btn`/
// `wv-tree-mode-loyalty-btn` appear nowhere in world-view.js, and
// `anchor-membership` appears nowhere in manual-edit-ops.mjs or server.mjs's
// route table (confirmed by direct read AND grep before writing this file).
// Test 4 is a DELIBERATE GREEN PIN, called out explicitly: it re-proves
// phase30/31's own Spatial-tree + containment-reparent behavior (the
// existing, UNCHANGED default) so a regression introduced while building the
// Loyalty toggle is caught here, not just left to phase30/31's own suite.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  primeWorldSelection,
  anchorMembershipViaRoute,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-p38-loyalty-");
const WORLD = "e2e-p38-loyalty-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p38loy-house", name: "The Iron House", type: "faction", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "p38loy-stable", name: "The Gladiator Stable", type: "faction", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "p38loy-fighter", name: "Sorrel Vane", type: "person", importance: 0.4 } },
  // Loyalty chain: fighter --membership--> stable --fealty--> house.
  { op: "upsert_edge", data: { id: "p38loy-e1", sourceId: "p38loy-fighter", targetId: "p38loy-stable", relationshipType: "membership" } },
  { op: "upsert_edge", data: { id: "p38loy-e2", sourceId: "p38loy-stable", targetId: "p38loy-house", relationshipType: "fealty" } },
  // Spatial (containment) fixture, kept COMPLETELY SEPARATE from the loyalty
  // edges above -- the guard test (#4) exercises this half only, proving the
  // two derivations don't cross-contaminate.
  { op: "upsert_entity", data: { id: "p38loy-root", name: "The Sunken Arena", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "p38loy-a", name: "Cinder Pike", type: "person", importance: 0.3 } },
  { op: "upsert_entity", data: { id: "p38loy-b", name: "The Bone Yard", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "p38loy-e3", sourceId: "p38loy-a", targetId: "p38loy-root", relationshipType: "containment" } }
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

async function nativeDnD(page, srcSel, tgtSel) {
  await page.evaluate(({ srcSel, tgtSel }) => {
    const src = document.querySelector(srcSel);
    const tgt = document.querySelector(tgtSel);
    if (!src) throw new Error("drag SOURCE not found: " + srcSel);
    if (!tgt) throw new Error("drop TARGET not found: " + tgtSel);
    const dt = new DataTransfer();
    const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt });
    src.dispatchEvent(ev("dragstart"));
    tgt.dispatchEvent(ev("dragover"));
    tgt.dispatchEvent(ev("drop"));
    src.dispatchEvent(ev("dragend"));
  }, { srcSel, tgtSel });
}

test("UI: the Spatial|Loyalty segmented toggle renders in wv-tree-head, Spatial active by default", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  const toggle = page.locator('[data-testid="wv-tree-mode-toggle"]');
  await assert.doesNotReject(
    async () => toggle.waitFor({ state: "visible", timeout: 5000 }),
    "the Spatial|Loyalty toggle must render in wv-tree-head -- it does not exist yet"
  );
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="wv-tree-mode-spatial-btn"]');
      return !!btn && btn.getAttribute("aria-pressed") === "true";
    }, { timeout: 5000 });
  }, "Spatial must be the active/default mode");
  await page.close();
});

test("UI: switching to Loyalty renders the membership/fealty tree (Sorrel Vane under The Gladiator Stable under The Iron House)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="wv-tree-mode-loyalty-btn"]').click({ timeout: 8000 });
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const tree = document.querySelector('[data-testid="world-tree"]');
      return tree && tree.getAttribute("data-tree-mode") === "loyalty";
    }, { timeout: 5000 });
  }, "clicking Loyalty must flip the tree container's data-tree-mode to \"loyalty\"");

  const stableRow = page.locator('[data-testid="world-tree-row"][data-entity-id="p38loy-stable"]');
  await assert.doesNotReject(
    async () => stableRow.waitFor({ state: "visible", timeout: 5000 }),
    "The Gladiator Stable (a Loyalty root under The Iron House via fealty) must render in Loyalty mode"
  );
  const fighterRow = page.locator('[data-testid="world-tree-row"][data-entity-id="p38loy-fighter"]');
  await assert.doesNotReject(
    async () => fighterRow.waitFor({ state: "visible", timeout: 5000 }),
    "Sorrel Vane (member of the stable via a membership edge) must render nested under it in Loyalty mode"
  );
  await page.close();
});

test("ROUTE: POST /api/graph/nodes/:id/anchor-membership -- 404 today (§6d, new op + route not built yet)", async () => {
  const { status, body } = await anchorMembershipViaRoute(base, WORLD, "p38loy-fighter", "p38loy-house");
  assert.notEqual(status, 404, `expected the new anchor-membership route to exist and succeed, got ${status}: ${JSON.stringify(body)} -- it is not built yet`);
  if (status === 200) {
    assert.equal(body.entityId, "p38loy-fighter");
    assert.equal(body.parentId, "p38loy-house");
    assert.equal(typeof body.removedEdgeCount, "number");
    // Task 38.3 fix (not a contract change -- phase38-fixture.mjs's own §6d
    // is untouched): once the route is REAL, this probe has a genuine,
    // permanent effect on the SHARED fixture graph the very next test (the
    // Spatial-mode guard pin below) independently re-checks "p38loy-e1"
    // against by id -- pre-38.3 this call 404'd and never mutated anything,
    // so the two tests' independence was accidental, not by design. Undo it
    // via the existing /api/manual-undo route (anchorMembership sets the
    // SAME single undo slot every manual-edit-ops write does, and its own
    // undo re-creates each removed edge with its EXACT original id/data --
    // see manual-edit-ops.mjs's anchorMembership doc comment), restoring
    // "p38loy-e1" byte-for-byte before the next test runs.
    const undoRes = await fetch(`${base}/api/manual-undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: WORLD })
    });
    assert.equal(undoRes.status, 200, "undoing this probe's own mutation must succeed");
  }
});

test("GREEN PIN: Spatial tree + containment reparent via real drag-drop UI still work, protecting phase30/31 behavior", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="p38loy-a"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="p38loy-b"]').waitFor({ state: "visible", timeout: 10000 });

  await nativeDnD(page,
    '[data-testid="world-tree-row"][data-entity-id="p38loy-a"]',
    '[data-testid="world-tree-row"][data-entity-id="p38loy-b"]');

  let found = null;
  for (let i = 0; i < 40 && !found; i++) {
    const { edges } = await fetchGraphViaRoute(base, WORLD);
    found = (edges || []).find((e) => e.sourceId === "p38loy-a" && e.targetId === "p38loy-b" && e.relationshipType === "containment");
    if (!found) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(found, "in the (still-default) Spatial mode, dropping tree row A onto tree row B must still create a real containment edge A->B, exactly as phase31 pinned");

  // The loyalty edges seeded above must be COMPLETELY untouched by this
  // Spatial-mode drag -- the two derivations must never cross-contaminate.
  const { edges: allEdges } = await fetchGraphViaRoute(base, WORLD);
  const membership = allEdges.find((e) => e.id === "p38loy-e1");
  const fealty = allEdges.find((e) => e.id === "p38loy-e2");
  assert.ok(membership && membership.targetId === "p38loy-stable", "the pre-seeded membership edge must be unaffected by a Spatial-mode reparent");
  assert.ok(fealty && fealty.targetId === "p38loy-house", "the pre-seeded fealty edge must be unaffected by a Spatial-mode reparent");
  await page.close();
});
