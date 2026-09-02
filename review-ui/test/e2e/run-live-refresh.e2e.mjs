// Run-mode live refresh (2026-08-26) -- while a scene page sits in Run, it
// polls GET .../run-version and rebuilds the spread when the fingerprint
// changes, so an edit made elsewhere (another tab, an agent over MCP) lands
// on the table without a reload. Asserted against the real DOM: patch the
// scene's activeVariants through the route while the page is open in Run,
// and watch the spread swap variants on its own.
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
import { createSceneElementViaRoute, updateSceneViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-live-");
const WORLD = "e2e-run-live-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rl-square", name: "The Old Square", type: "place", importance: 0.6 } }
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

async function waitFor(fn, { timeout = 10000, every = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, every));
  }
}

test("a scene patched over the route while open in Run re-renders on its own within a few seconds", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rl-square", name: "Live scene" });
  await updateSceneViaRoute(base, WORLD, scene.id, { activeVariants: ["Present"] });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Backdrop — Present", fields: { looks: "Day." }, run: { column: "side", role: "gm", variant: "Present" } });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Backdrop — Night", fields: { looks: "Dark." }, run: { column: "side", role: "gm", variant: "Night" } });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-elements-list"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator('[data-testid="scene-run-spread"]');
  await spread.waitFor({ state: "visible", timeout: 15000 });
  // Variants round (2026-09-01): both backdrops fold into the tabbed GM
  // notes card; activeVariants=["Present"] seeds that tab.
  const foldTab = () => page.locator('[data-testid="scene-run-spread"] [data-testid="rs-gm-fold"] .rs-tab--active');
  assert.deepEqual(await spread.locator(".rs-side .rs-box-l").allTextContents(), ["GM notes"]);
  assert.equal(await foldTab().textContent(), "Present");
  assert.match(await spread.locator('[data-testid="rs-gm-fold"]').textContent(), /Day\./);

  // Change the scene from outside the page; the poll must pick it up.
  await updateSceneViaRoute(base, WORLD, scene.id, { activeVariants: ["Night"] });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Read Aloud — Later", fields: { looks: "The lamps come on." }, run: { column: "main", role: "read" } });

  await waitFor(async () => (await foldTab().textContent().catch(() => "")) === "Night", { timeout: 12000 });
  assert.match(await page.locator('[data-testid="scene-run-spread"] [data-testid="rs-gm-fold"]').textContent(), /Dark\./, "the re-seeded tab shows its state");
  assert.match(await page.locator('[data-testid="scene-run-spread"] .rs-main').textContent(), /The lamps come on/);
  assert.equal(await page.locator('[data-testid="scene-run-updated"]').count(), 1, "the 'updated just now' flash is shown");

  // Leaving Run stops the poll: a later change must NOT reach the (hidden) spread.
  await page.locator('[data-testid="mode-prep-btn"]').click();
  await updateSceneViaRoute(base, WORLD, scene.id, { activeVariants: ["Present"] });
  await page.waitForTimeout(4000);
  assert.equal(await foldTab().textContent(), "Night", "no rebuild while in Prep");
  await page.close();
});
