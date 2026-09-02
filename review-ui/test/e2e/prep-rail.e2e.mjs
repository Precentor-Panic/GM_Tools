// O1 — the Prep layout rail (variants round, 2026-09-01): a collapsible
// ~220px lane column beside the Page rows. Contract: the ▤ lanes button
// discloses it; a row's glyph GRIP dragged into a rail lane persists the
// column move through the SAME lane-model contract the board uses;
// click-to-edit keeps working with the rail open (only the glyph drags);
// a grouped cluster shows as one stack entry (lead + ⊞ count).
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
import { createSceneElementViaRoute, listSceneElementsViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-prep-rail-");
const WORLD = "e2e-prep-rail-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "pr-hall", name: "The Hall", type: "place", importance: 0.6, description: "A hall." } }
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
async function els(sceneId) {
  return (await listSceneElementsViaRoute(base, WORLD, sceneId)).body.elements;
}

test("▤ lanes discloses the rail; a grip drag into Side persists; click-to-edit survives; stacks show as one entry", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "pr-hall", name: "Rail scene" });
  const beat = await makeEl(scene.id, { name: "Beat — The clerk", fields: { gives: "counts on" }, run: { column: "main", role: "beat" } });
  await makeEl(scene.id, { name: "Charm — The Ledger", fields: { gives: "x" }, run: { column: "main", role: "card", group: "ledger" } });
  await makeEl(scene.id, { name: "Read Aloud — Paid", fields: { looks: "y" }, run: { column: "main", role: "read", group: "ledger", variant: "Paid" } });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-elements-list"]').waitFor({ timeout: 15000 });

  // Closed by default; the button discloses it.
  const rail = page.locator('[data-testid="scene-layout-rail"]');
  assert.equal(await rail.isVisible(), false, "rail hidden until disclosed");
  await page.locator('[data-testid="rail-toggle-btn"]').click();
  await rail.waitFor({ state: "visible", timeout: 5000 });

  // A grouped cluster is ONE rail entry: lead name + ⊞ member count.
  const stackCard = rail.locator('.rail-card--stack');
  assert.equal(await stackCard.count(), 1);
  assert.match(await stackCard.locator(".rail-card-count").textContent(), /⊞ 2/);

  // Grip-drag the beat's glyph into the Side lane -> the same
  // column-patch+reorder persist the board uses.
  const grip = page.locator(`[data-testid="scene-element-row"][data-element-id="${beat.id}"] [data-testid="scene-element-grip"]`);
  const sideLane = rail.locator('[data-testid="rail-lane"][data-column="side"]');
  await grip.dragTo(sideLane);
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-testid="rail-lane"][data-column="side"] [data-testid="rail-card"][data-element-id="${id}"]`),
    beat.id,
    { timeout: 10000 }
  );
  const stored = (await els(scene.id)).find((e) => e.id === beat.id);
  assert.deepEqual(stored.run, { column: "side", role: "beat" }, "the grip drag persisted the column through the shared lane model");

  // Click-to-edit still works with the rail open (only the glyph drags).
  const field = page.locator(`[data-testid="scene-element-row"][data-element-id="${beat.id}"] [data-testid="scene-element-field"][data-field="gives"]`);
  await field.click();
  const input = page.locator(`[data-testid="scene-element-field-input"][data-field="gives"]`);
  await input.waitFor({ timeout: 5000 });
  await input.fill("counts everything twice");
  await input.press("Tab"); // blur -> autosave
  await page.waitForFunction(
    async (args) => {
      const res = await fetch(`/api/scene-planning/scenes/${args[0]}/elements?world=${args[1]}`);
      const { elements } = await res.json();
      return elements.find((e) => e.id === args[2])?.fields?.gives === "counts everything twice";
    },
    [scene.id, WORLD, beat.id],
    { timeout: 10000 }
  );
  await page.close();
});
