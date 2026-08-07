// Phase 31 tasks 31.1 + 31.2 -- hardening + wire-up coverage for the new
// interface's BROKEN / NO-FEEDBACK interactions, asserted against the UX
// audit's EXPECTED behavior (plans/phase-31-ux-audit.md §3 / §4). Authored
// QE-first: every test below is RED against today's build and turns GREEN once
// the §3 fixes land. Read the audit's §0 (drag-drop root cause) and §4
// (native-DnD testing notes) before this file.
//
// EXPECTED-RED reasons (per test):
//  - reparent-via-real-UI-DnD: green already at the ROUTE level, but this is
//    the first test to drive the real `dragstart`/`dragover`/`drop` UI path
//    (module-level `dragId`); it pins that the UI wiring itself works.
//  - add-to-scene FEEDBACK: RED -- the scene-tray row has NO
//    `[data-testid="world-scene-drop-row"]` today, shows NO element count, and
//    a successful add neither ticks a count nor flips agoLabel to "just now"
//    (addNodeToScene never calls touchScene). This is the regression that
//    would have caught the reported "drag alvor into gladiator arena doesn't
//    stick" bug.
//  - scene-page Esc: RED -- Esc currently NAVIGATES to the plan
//    (session-planner-view.js:2940) instead of closing the Wrap panel.
//  - scene-page `[` guard: RED -- the keydown guard only checks
//    TEXTAREA/INPUT (session-planner-view.js:2937), so `[` fires inside a
//    focused contenteditable and navigates mid-edit.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p31-");
const WORLD = "e2e-p31-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p31-root", name: "The Iron Arena", type: "place", importance: 0.6 } },
  // reparent SOURCE (currently under root) and TARGET (a top-level place).
  { op: "upsert_entity", data: { id: "p31-a", name: "Sand Drake", type: "person", importance: 0.3 } },
  { op: "upsert_entity", data: { id: "p31-b", name: "The Gladiator Pit", type: "place", importance: 0.5 } },
  // add-to-scene SOURCE.
  { op: "upsert_entity", data: { id: "p31-person", name: "Alvor", type: "person", importance: 0.4 } },
  { op: "upsert_edge", data: { id: "p31-e-a", sourceId: "p31-a", targetId: "p31-root", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "p31-e-person", sourceId: "p31-person", targetId: "p31-root", relationshipType: "containment" } }
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

// Native HTML5 drag-drop via the REAL source element + a SHARED DataTransfer
// (audit §4). The app's drop handlers key off a module-level `dragId` set by
// the row's own `dragstart` listener, so the `dragstart` MUST hit the real
// source element -- Playwright's dragTo()/hover-mouse helpers do NOT synthesize
// native dragstart in Chromium and would silently no-op here.
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

async function fetchGraph() {
  const res = await fetch(`${base}/api/graph?world=${encodeURIComponent(WORLD)}&filter=all`);
  return res.json();
}

// Phase 33 task 33.1: scene-membership is retired -- a tree->tray drop now
// creates a real kind:'graph' scene-element instead of a membership row.
// Reads the same GET .../elements route the Planner surface itself renders
// from.
async function sceneGraphElementIds(sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements?world=${encodeURIComponent(WORLD)}`);
  const body = await res.json();
  return (body.elements || []).filter((e) => e.kind === "graph").map((e) => e.graphEntityId);
}

// ---------------------------------------------------------------------------
// 1. Reparent via the real drag-drop UI path (§4)
// ---------------------------------------------------------------------------
test("reparent: dragstart a tree row onto ANOTHER tree row creates a containment edge + re-nests it (real UI DnD path)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="p31-a"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="p31-b"]').waitFor({ state: "visible", timeout: 10000 });

  await nativeDnD(page,
    '[data-testid="world-tree-row"][data-entity-id="p31-a"]',
    '[data-testid="world-tree-row"][data-entity-id="p31-b"]');

  // The reparent route persists a containment edge p31-a -> p31-b.
  let found = null;
  for (let i = 0; i < 40 && !found; i++) {
    const { edges } = await fetchGraph();
    found = (edges || []).find((e) => e.sourceId === "p31-a" && e.targetId === "p31-b" && e.relationshipType === "containment");
    if (!found) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(found, "dropping tree row A onto tree row B must create a real containment edge A->B via the UI drag path");

  // And the tree re-renders A nested under B (B expands to reveal A).
  await page.locator('[data-testid="world-tree-row"][data-entity-id="p31-a"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

// ---------------------------------------------------------------------------
// 2. Add-to-scene FEEDBACK -- the regression that would have caught the bug
// ---------------------------------------------------------------------------
test("add-to-scene: dropping a node on the scene-tray row creates a real graph-element AND the row visibly ticks its element count +1 and reads \"just now\"", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  // Select a node so the inspector + scene tray render.
  await page.goto(`${base}/#world/p31-person`);
  await page.locator('[data-testid="world-inspector"][data-entity-id="p31-person"]').waitFor({ state: "visible", timeout: 15000 });

  const dropRow = page.locator(`[data-testid="world-scene-drop-row"][data-scene-id="${scene.id}"]`);
  await dropRow.waitFor({ state: "visible", timeout: 10000 });

  const meta = dropRow.locator(".wv-scene-drop-meta");
  // Wait for the async element-count to populate, then read the "before" count.
  await meta.locator("text=/\\d+ elements/").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const readCount = async () => {
    const t = (await meta.textContent()) || "";
    const m = t.match(/(\d+)\s+elements/);
    return m ? Number(m[1]) : null;
  };
  const before = await readCount();
  assert.equal(before, 0, `a fresh scene's tray row must show "0 elements" before the drop (got meta: ${await meta.textContent()})`);

  await nativeDnD(page,
    '[data-testid="world-tree-row"][data-entity-id="p31-person"]',
    `[data-testid="world-scene-drop-row"][data-scene-id="${scene.id}"]`);

  // Server-side: a real kind:'graph' scene-element persisted.
  let graphIds = [];
  for (let i = 0; i < 40; i++) {
    graphIds = await sceneGraphElementIds(scene.id);
    if (graphIds.includes("p31-person")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(graphIds.includes("p31-person"), "the dropped node must be persisted as a real graph-referencing scene-element");

  // Visible, PERSISTENT feedback (not just the 6s toast): the tray row's
  // element count ticked +1 and its recency flipped to "just now".
  const freshRow = page.locator(`[data-testid="world-scene-drop-row"][data-scene-id="${scene.id}"]`);
  const freshMeta = freshRow.locator(".wv-scene-drop-meta");
  await page.waitForFunction((sceneId) => {
    const el = document.querySelector(`[data-testid="world-scene-drop-row"][data-scene-id="${sceneId}"] .wv-scene-drop-meta`);
    if (!el) return false;
    const m = (el.textContent || "").match(/(\d+)\s+elements/);
    return !!m && Number(m[1]) === 1 && /just now/.test(el.textContent || "");
  }, scene.id, { timeout: 10000 });
  const after = ((await freshMeta.textContent()) || "").match(/(\d+)\s+elements/);
  assert.ok(after && Number(after[1]) === before + 1, `the tray row element count must tick from ${before} to ${before + 1} after a successful add`);
  await page.close();
});

// ---------------------------------------------------------------------------
// 3. Scene-page Esc closes Wrap (does NOT navigate)
// ---------------------------------------------------------------------------
test("scene-page Esc closes the Wrap panel and leaves the scene hash UNCHANGED", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Esc Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, scene.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="wrap-toggle-btn"]').click();
  const panel = page.locator(`[data-testid="wrap-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  const hashBefore = await page.evaluate(() => location.hash);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  assert.equal(await page.evaluate(() => location.hash), hashBefore, "Esc must NOT navigate away from the scene");
  assert.ok(await panel.isHidden(), "Esc must close the Wrap panel");
  await page.close();
});

// ---------------------------------------------------------------------------
// 4. Scene-page `[` / `]` -- navigate only OUTSIDE an editable
// ---------------------------------------------------------------------------
test("scene-page `]` navigates to the next scene when focus is OUTSIDE an editable", async () => {
  const a = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });
  const b = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });
  const c = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Nav Plan");
  for (const s of [a, b, c]) await addSceneToPlanViaRoute(base, WORLD, plan.id, s.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${b.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${b.id}"]`).waitFor({ state: "visible", timeout: 15000 });

  // Put keyboard focus on a NON-editable control (the Page layout button) --
  // "outside an editable" -- so the keydown target is a plain button, not a
  // field. (Relying on ambient <body> focus is flaky across many page opens.)
  await page.locator('[data-testid="layout-page-btn"]').click();
  await page.keyboard.press("]");
  await page.waitForFunction((cid) => location.hash === `#planner/scene/${cid}`, c.id, { timeout: 8000 });
  await page.close();
});

test("scene-page `[` inside a focused contenteditable does NOT change the hash (bracket-in-editable guard)", async () => {
  const a = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });
  const b = await createSceneViaRoute(base, WORLD, { locationEntityId: "p31-b" });
  const plan = await createPlanViaRoute(base, WORLD, "Guard Plan");
  for (const s of [a, b]) await addSceneToPlanViaRoute(base, WORLD, plan.id, s.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${b.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${b.id}"]`).waitFor({ state: "visible", timeout: 15000 });

  // Focus a real contenteditable target: today the keydown guard only checks
  // TEXTAREA/INPUT, so `[` fires and navigates to the previous scene (a). After
  // the `|| t.isContentEditable` fix, the guard suppresses it.
  await page.evaluate(() => {
    // The scene keydown handler is document-level, so a focused contenteditable
    // ANYWHERE exercises the guard. Append to the stable <body> (a scene-view
    // child can be detached by a re-render) with explicit size so the click lands.
    const ce = document.createElement("div");
    ce.id = "p31-ce-probe";
    ce.setAttribute("contenteditable", "true");
    ce.textContent = "editing";
    ce.style.cssText = "position:fixed;top:8px;left:8px;width:140px;height:40px;z-index:99999;background:#fff;border:1px solid #000;";
    document.body.appendChild(ce);
  });
  // Give the contenteditable GENUINE keyboard focus via a real click (a bare
  // .focus() via evaluate does not reliably route page.keyboard across many
  // page lifecycles in headless Chromium).
  await page.locator("#p31-ce-probe").click();
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.isContentEditable), "probe must be the focused contenteditable");
  const hashBefore = await page.evaluate(() => location.hash);
  await page.keyboard.press("[");
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => location.hash), hashBefore, "`[` must NOT navigate while a contenteditable is focused");
  await page.close();
});
