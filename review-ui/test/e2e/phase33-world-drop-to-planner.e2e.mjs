// Phase 33 task 33.0 -- QE-first e2e contract for Part A of the design record
// (`.claude/plans/ok-i-m-back-with-dazzling-newt.md` -- read that first):
// a node dragged onto a scene-tray row on the World surface must show up on
// the SAME scene's Session Planner page as a KEY (graph-referencing) element.
//
// ROOT CAUSE (confirmed, design record's own grounding): the World drop
// writes to the scene-MEMBERSHIP store (`world-view.js:935` `addToScene` ->
// `POST .../members`), while the Planner scene page renders scene-ELEMENTS
// ONLY (`session-planner-view.js`'s `renderSceneElementsList`, zero
// membership references). Two parallel "things in a scene" stores that never
// merged. 33.1's fix: redirect the World drop to call the SAME
// `POST .../elements/from-graph` route the scene page's own "From graph"
// picker already uses (`attachExistingNodeAsElement`, `scene-elements.mjs:
// 288`) -- so a World drop and a scene-page "From graph" pick become the
// literal same action, and the scene page needs ZERO new read logic.
//
// THIS FILE'S CONTRACT (locked here for 33.1 to match):
//   - The drop must produce a scene-element with `kind:"graph"` and
//     `graphEntityId` === the dropped node's id (`GET .../scenes/:id/elements`).
//   - That element must render on `#planner/scene/<sceneId>` as
//     `[data-testid="scene-element-row"][data-kind="graph"]` containing
//     `[data-testid="scene-element-graph-badge"][data-graph-entity-id="<id>"]`
//     -- the EXISTING KEY-element rendering contract
//     (`session-planner-view.js:1164-1200`), reused verbatim, no new testids.
//   - Dropping the SAME node onto the SAME scene twice must be idempotent --
//     exactly ONE such element results (mirrors `attachExistingNodeAsElement`'s
//     designed dedupe per the design record's Part A item 1). Documented as
//     an explicit intent-pinning assertion even though, today, it's red for
//     the SAME underlying reason as the rest of this file (no element is ever
//     created by the drop at all -- zero is trivially "at most one", but this
//     suite asserts the real target of exactly one, which fails today).
//
// EXPECTED-RED reasons (both tests below, today's build):
//   - The drop calls `POST .../members` (scene-membership), never
//     `.../elements/from-graph` -- so `GET .../scenes/:id/elements` never
//     contains a `kind:"graph"` element with the dropped node's id, and the
//     Planner scene page never renders a `scene-element-graph-badge` for it.
//   - Confirmed a RIGHT-KIND-OF-RED (missing behavior/DOM), not a fixture or
//     import error: `world-scene-drop-row` / `world-tree-row` / the planner
//     scene page itself all render fine (reused verbatim from
//     phase30/31 fixtures) -- only the drop's OWN write target is wrong.
//
// Native HTML5 drag-drop technique + world-tree-row/world-scene-drop-row
// testids: copied verbatim from `phase31-interactions.e2e.mjs` (the app keys
// off a module-level `dragId` set by the row's own real `dragstart` --
// Playwright's `dragTo()` does not synthesize this).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p33a-");
const WORLD = "e2e-p33a-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p33a-root", name: "The Cinder Vault", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "p33a-node", name: "Reya Thorncoil", type: "person", importance: 0.4 } },
  { op: "upsert_edge", data: { id: "p33a-e-node", sourceId: "p33a-node", targetId: "p33a-root", relationshipType: "containment" } }
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

// Native HTML5 drag-drop via the REAL source element + a SHARED DataTransfer,
// copied verbatim from phase31-interactions.e2e.mjs -- see that file's own
// comment for why Playwright's dragTo()/hover-mouse helpers do NOT work here.
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

async function fetchSceneElements(sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements?world=${encodeURIComponent(WORLD)}`);
  const body = await res.json();
  return body.elements || [];
}

async function selectNodeAndOpenTray(page, entityId, sceneId) {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world/${entityId}`);
  await page.locator(`[data-testid="world-inspector"][data-entity-id="${entityId}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`[data-testid="world-scene-drop-row"][data-scene-id="${sceneId}"]`).waitFor({ state: "visible", timeout: 10000 });
}

// ---------------------------------------------------------------------------
// 1. The drop must create a REAL graph-referencing element AND render as a
//    KEY row on the Planner scene page (route-level + UI-level, one test).
// ---------------------------------------------------------------------------
test('World scene-tray drop: dragging a node onto a scene creates a kind:"graph" scene-element (not a membership row) that renders as a KEY element on the Planner scene page', async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p33a-root" });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await selectNodeAndOpenTray(page, "p33a-node", scene.id);

  await nativeDnD(
    page,
    '[data-testid="world-tree-row"][data-entity-id="p33a-node"]',
    `[data-testid="world-scene-drop-row"][data-scene-id="${scene.id}"]`
  );

  // Route-level: poll GET .../elements for a real kind:"graph" element
  // referencing the dropped node (attachExistingNodeAsElement's shape).
  let elements = [];
  let graphEl = null;
  for (let i = 0; i < 30 && !graphEl; i++) {
    elements = await fetchSceneElements(scene.id);
    graphEl = elements.find((e) => e.kind === "graph" && e.graphEntityId === "p33a-node");
    if (!graphEl) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(
    graphEl,
    `dropping a node on the scene-tray row must create a kind:"graph" scene-element with graphEntityId="p33a-node" via GET /api/scene-planning/scenes/${scene.id}/elements -- today the drop only writes scene-membership, so no such element exists. Got elements=${JSON.stringify(elements)}`
  );

  // UI-level: the SAME element must render on the Planner scene page as the
  // EXISTING KEY-row + graph-badge contract (session-planner-view.js:1164-1200).
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  const badge = page.locator('[data-testid="scene-element-graph-badge"][data-graph-entity-id="p33a-node"]');
  await badge.waitFor({ state: "visible", timeout: 10000 });
  const row = page.locator('[data-testid="scene-element-row"][data-kind="graph"]').filter({ has: badge });
  assert.equal(
    await row.count(),
    1,
    'the dropped node must render as exactly one KEY (data-kind="graph") scene-element-row on the Planner scene page'
  );
  await page.close();
});

// ---------------------------------------------------------------------------
// 2. Dedupe -- dropping the same node on the same scene twice is idempotent.
// ---------------------------------------------------------------------------
test("dropping the SAME node onto the SAME scene twice is idempotent -- exactly ONE graph-referencing element results (documents intended dedupe; red today for the same underlying reason -- the drop never creates an element at all)", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p33a-root" });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await selectNodeAndOpenTray(page, "p33a-node", scene.id);

  await nativeDnD(
    page,
    '[data-testid="world-tree-row"][data-entity-id="p33a-node"]',
    `[data-testid="world-scene-drop-row"][data-scene-id="${scene.id}"]`
  );
  await page.waitForTimeout(500);
  await nativeDnD(
    page,
    '[data-testid="world-tree-row"][data-entity-id="p33a-node"]',
    `[data-testid="world-scene-drop-row"][data-scene-id="${scene.id}"]`
  );
  await page.waitForTimeout(500);

  const elements = await fetchSceneElements(scene.id);
  const graphEls = elements.filter((e) => e.kind === "graph" && e.graphEntityId === "p33a-node");
  assert.equal(
    graphEls.length,
    1,
    `dropping the same node on the same scene twice must be idempotent -- exactly one kind:"graph" element referencing it, got ${graphEls.length} (elements=${JSON.stringify(elements)})`
  );
  await page.close();
});
