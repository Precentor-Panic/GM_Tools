// Friction Wave 1, W5a (render half) — real-browser proof that a containment
// CYCLE renders in the World tab's "Where things are" tree with a visible
// warning badge, instead of silently vanishing (the bug that ate Kilmarn +
// the Underbreach, friction log 2026-08-14). The fixture reconstructs the
// exact pre-fix shape: two opposite containment edges between two places
// (the inverted "Kilmarn has quarters" edge + the later, correct
// Underbreach -> Kilmarn edge), plus an object hanging UNDER the cycle
// ("disappearing everything underneath") and a healthy unrelated root.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-w5a-cycle-");
const WORLD = "e2e-w5a-cycle-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "w5a-kilmarn", name: "Kilmarn", type: "place", importance: 0.8 } },
  { op: "upsert_entity", data: { id: "w5a-underbreach", name: "The Underbreach", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "w5a-charter", name: "Founding Charter", type: "object", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "w5a-healthy", name: "The Span", type: "place", importance: 0.5 } },
  // The cycle: the inverted parent-first edge + the correct one.
  { op: "upsert_edge", data: { id: "w5a-e-bad", sourceId: "w5a-kilmarn", targetId: "w5a-underbreach", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "w5a-e-good", sourceId: "w5a-underbreach", targetId: "w5a-kilmarn", relationshipType: "containment" } },
  // Hangs under the cycle — vanished along with it pre-fix.
  { op: "upsert_edge", data: { id: "w5a-e-charter", sourceId: "w5a-charter", targetId: "w5a-underbreach", relationshipType: "containment" } }
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

test("W5a: every cycle member (and everything underneath) renders in the tree — nothing vanishes", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  // Pre-fix, the first three of these four rows never render at all.
  for (const id of ["w5a-kilmarn", "w5a-underbreach", "w5a-charter", "w5a-healthy"]) {
    await page.locator(`[data-testid="world-tree-row"][data-entity-id="${id}"]`).waitFor({ state: "visible", timeout: 10000 });
  }
  assert.equal(await page.locator('[data-testid="world-tree-row"]').count(), 4, "all four entities render — nothing vanishes");
  await page.close();
});

test("W5a: the cycle's representative row carries a visible warning badge naming the cycle members", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-tree-row"][data-entity-id="w5a-kilmarn"]').waitFor({ state: "visible", timeout: 15000 });

  const badge = page.locator('[data-testid="world-tree-cycle-badge"]');
  await badge.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await badge.count(), 1, "exactly one badge — on the representative, not every member");
  assert.equal(await badge.getAttribute("data-entity-id"), "w5a-kilmarn", "Kilmarn (first by name) is the representative");

  const title = await badge.getAttribute("title");
  assert.match(title, /Kilmarn/, "the badge names the cycle members");
  assert.match(title, /The Underbreach/);
  assert.match(title, /cycle/i);

  // Grouped at root: the Underbreach renders as Kilmarn's CHILD (deeper
  // indent), so the branch reads as a normal subtree, only badged.
  const kilmarnPad = await page.locator('[data-testid="world-tree-row"][data-entity-id="w5a-kilmarn"]').evaluate((el) => parseInt(el.style.paddingLeft, 10));
  const underPad = await page.locator('[data-testid="world-tree-row"][data-entity-id="w5a-underbreach"]').evaluate((el) => parseInt(el.style.paddingLeft, 10));
  assert.ok(underPad > kilmarnPad, "the rest of the cycle chains under the representative");
  await page.close();
});
