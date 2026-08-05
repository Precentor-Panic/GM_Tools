// Phase 29 task 29.0 -- Stat blocks (SceneElement.stat). Read
// phase29-fixture.mjs's header FIRST (§1 is this file's own section).
// EXPECTED TO FAIL right now: the route-level test proves PATCH .../elements/
// :elementId today silently DROPS an unrecognized `stat` body key (the route
// handler only reads `name`/`fields` off the body, confirmed by direct read
// of review-ui/server.mjs) -- a real 200 comes back, but the element's own
// stored `stat` never changes, so asserting it persisted FAILS. The UI-level
// tests get real Playwright selector-timeout failures: `add-statblock-chip`/
// `npc-creature-btn` don't exist anywhere in session-planner-view.js yet.
// Both failure shapes are the deliverable of this task, not a bug in this
// file.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createSceneElementViaRoute,
  listSceneElementsViaRoute,
  patchSceneElementViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase29Env("gm-tools-e2e-statblocks-");
const WORLD = "e2e-statblocks-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sb-place-a", name: "The Sunken Reliquary", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;

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

test("ROUTE LEVEL (RED): PATCH .../elements/:elementId {stat} must persist a merged stat object -- today it is silently dropped", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  const created = await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A gaunt sexton" });
  const elementId = created.body?.element?.id;
  assert.ok(elementId, "test setup itself must succeed -- broken test setup, not the thing under test");

  const patch1 = await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, {
    stat: { count: 1, ac: "13", hp: "22 (4d8+4)", speed: "30 ft.", cr: "1/2 (100 XP)", raw: "", foundryActor: "" }
  });
  assert.equal(patch1.status, 200, "the PATCH route itself must not error even before 29.1 lands (an unrecognized body key is dropped, not rejected)");

  const after1 = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const el1 = after1.body.elements.find((e) => e.id === elementId);
  assert.ok(el1.stat, "29.1: element.stat must be present after a PATCH carrying {stat:{...}} -- RED today, stat is never merged onto the stored element (server.mjs only reads name/fields off the PATCH body)");
  assert.equal(el1.stat?.ac, "13", "29.1: the stat sub-fields sent in the PATCH must round-trip");

  // Shallow-merge semantics: a second PATCH touching only `ac` must leave `hp` untouched.
  const patch2 = await patchSceneElementViaRoute(base, WORLD, scene.id, elementId, { stat: { ac: "15" } });
  assert.equal(patch2.status, 200);
  const after2 = await listSceneElementsViaRoute(base, WORLD, scene.id);
  const el2 = after2.body.elements.find((e) => e.id === elementId);
  assert.equal(el2.stat?.ac, "15", "29.1: a partial stat PATCH must update the targeted sub-field");
  assert.equal(el2.stat?.hp, "22 (4d8+4)", "29.1: a partial stat PATCH must leave OTHER stat sub-fields untouched (shallow merge, matching `fields`' own established convention)");
});

test("UI (RED): '+ STAT BLOCK' chip / stat-block panel do not exist on the scene page yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "A blood-stamped ledger", fields: { trigger: "Opened without the key" } });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => page.locator('[data-testid="add-statblock-chip"]').first().waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.4: `add-statblock-chip` must render alongside the other add-field chips -- RED today, session-planner-view.js has no stat-block rendering at all"
  );
  await page.close();
});

test("UI (RED): '▣ NPC or creature' button does not exist yet", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sb-place-a" });

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await assert.rejects(
    async () => root.locator('[data-testid="npc-creature-btn"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.4: `npc-creature-btn` must render below the elements list -- RED today, absent from the DOM"
  );
  await page.close();
});
