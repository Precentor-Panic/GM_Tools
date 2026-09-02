// Variant tabs (Treatment B, 2026-09-01) — the LOCAL-FLIP contract beyond
// what run-group.e2e.mjs pins (tabs render, click swaps, nothing persists):
//   - a live-refresh rebuild (any route write bumping run-version) must NOT
//     reset the GM's locally-flipped tab;
//   - an activeVariants write re-seeds only units WITHOUT a local choice;
//   - navigating to a DIFFERENT scene clears local tab state.
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

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-tabs-");
const WORLD = "e2e-run-tabs-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rt-hall", name: "The Hall", type: "place", importance: 0.6, description: "A hall." } }
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

async function makeEl(sceneId, payload) {
  const r = await createSceneElementViaRoute(base, WORLD, sceneId, payload);
  assert.equal(r.status, 200, `element create failed: ${JSON.stringify(r.body)}`);
  return r.body.element;
}

async function openRun(page, sceneId) {
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  // The three-way view persists across scene nav, so this page may land
  // already in Run — clicking Run is a safe no-op-or-switch either way.
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator(`[data-testid="scene-run-spread"][data-scene-id="${sceneId}"]`);
  await spread.waitFor({ state: "visible", timeout: 15000 });
  return spread;
}

test("a locally-flipped tab survives a live-refresh rebuild; an activeVariants write re-seeds only units without a local choice; a scene change resets", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rt-hall", name: "Tabs scene" });
  await makeEl(scene.id, { name: "Charm — The Ledger", fields: { gives: '"Every debt remembers."' }, run: { column: "main", role: "card", group: "ledger" } });
  await makeEl(scene.id, { name: "Read Aloud — Paid", fields: { looks: "The column closes; the room breathes." }, run: { column: "main", role: "read", group: "ledger", variant: "Paid" } });
  await makeEl(scene.id, { name: "Read Aloud — Called in", fields: { looks: "Every name in the book looks up at once." }, run: { column: "main", role: "read", group: "ledger", variant: "Called in" } });
  await makeEl(scene.id, { name: "Backdrop — Calm", fields: { looks: "Quiet counters." }, run: { column: "side", role: "gm", variant: "Calm" } });
  await makeEl(scene.id, { name: "Backdrop — Panic", fields: { looks: "A run on the tills." }, run: { column: "side", role: "gm", variant: "Panic" } });
  const other = await createSceneViaRoute(base, WORLD, { locationEntityId: "rt-hall", name: "Other scene" });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  let spread = await openRun(page, scene.id);
  const group = () => spread.locator('[data-testid="rs-group"]');
  const fold = () => spread.locator('[data-testid="rs-gm-fold"]');

  // Defaults: first tab everywhere.
  assert.equal(await group().locator(".rs-tab--active").textContent(), "Paid");
  assert.equal(await fold().locator(".rs-tab--active").textContent(), "Calm");

  // GM flips the group tab locally; the fold is left untouched.
  await group().locator('[data-testid="rs-tab"][data-variant="Called in"]').click();
  assert.equal(await group().locator(".rs-tab--active").textContent(), "Called in");

  // A route write lands (activeVariants -> Panic) and the 3s poll rebuilds:
  // the fold (no local choice) re-seeds to Panic; the group's local flip is
  // NOT reset by the rebuild.
  await updateSceneViaRoute(base, WORLD, scene.id, { activeVariants: ["Panic"] });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="rs-gm-fold"] .rs-tab--active')?.textContent === "Panic",
    { timeout: 15000 }
  );
  assert.equal(await group().locator(".rs-tab--active").textContent(), "Called in", "the rebuild preserved the GM's local flip");
  assert.match(await fold().textContent(), /A run on the tills/);

  // Local state is per-scene: rendering a DIFFERENT scene clears it, so
  // returning re-seeds from activeVariants (["Panic"] names no group tab ->
  // first-tab default for the group).
  await openRun(page, other.id);
  spread = await openRun(page, scene.id);
  assert.equal(await group().locator(".rs-tab--active").textContent(), "Paid", "scene change cleared the local flip");
  assert.equal(await fold().locator(".rs-tab--active").textContent(), "Panic", "the persisted seed still applies");
  await page.close();
});
