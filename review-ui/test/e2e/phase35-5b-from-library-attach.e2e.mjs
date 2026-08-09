// Phase 35.5b (task #45) -- QE-first e2e contract: "From library" attach on
// the scene page. Russell's words: "if I'm in session planner/plan/scene
// I've already got 'NPC or creature'... from graph, suggest dressing, but
// I'm missing 'from library'. The library, while not indexed, is still a
// source for the scenes."
//
// Read FIRST: phase35-fixture.mjs (§1 ItemRecord/§2 StagecraftAsset, the
// setup/route-helper conventions this file reuses) and
// phase30-planner-scene.e2e.mjs (the existing From-graph coverage this
// file's own picker mirrors the pattern of).
//
// EXPECTED-RED reasons (confirmed by direct read + grep before writing this
// file): `[data-testid="from-library-btn"]`/`-picker"]`/`-option"]` do not
// exist anywhere in review-ui/public/session-planner-view.js today. The
// underlying wiring route (`POST .../tray/drop`) already exists (Phase
// 35.3) -- this file's route-level assertions against it are NOT expected
// red; only the UI-level scenarios are.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  makeItemRecord,
  seedItemRecords,
  makeStagecraftAsset,
  seedStagecraftAssets,
  fetchSceneTrayViaRoute,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p355b-");
const WORLD = "e2e-p355b-from-library";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../../combat-planning/party-roster-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

const ogrekin = saveBestiaryEntry({ rawFields: { name: "Ogrekin Skirmisher", type: "npc", cr: 5, challengeRating: 5, ac: 16, hp: 85 } });
acceptBestiaryEntry(ogrekin.id);

const kestrel = savePartyMember(WORLD, { name: "Kestrel Windrider", combatRelevant: { hp: 44, ac: 15, class: "Ranger", level: 5 }, buildRelevant: {} });

const VERDIGRIS_KEY = makeItemRecord({
  id: "it_verdigris_key", world: WORLD, name: "Verdigris Key",
  type: "wondrous item", description: "A palm-sized disc of green brass.", status: "accepted"
});
seedItemRecords(WORLD, [VERDIGRIS_KEY]);

const CHANTRY_MAP = makeStagecraftAsset({
  id: "sc_chantry_map", world: WORLD, kind: "map", name: "The Sunken Chantry",
  meta: "4000x3000, grid 100/5ft", status: "accepted"
});
seedStagecraftAssets(WORLD, [CHANTRY_MAP]);

let server, base, browser, scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Clear the lower cells." });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function listSceneElementsViaRoute(sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements?world=${encodeURIComponent(WORLD)}`);
  const body = await res.json();
  return body.elements ?? [];
}

async function openScene(sceneId) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  return { page, root };
}

// ---------------------------------------------------------------------------
// PICKER: opens, lists all four kinds, search narrows, kind filter narrows
// ---------------------------------------------------------------------------
test("From library: the picker opens from the scene page and lists accepted Bestiary/Hero/Reliquary/Stagecraft content", async () => {
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  await picker.waitFor({ state: "visible", timeout: 10000 });

  const options = picker.locator('[data-testid="from-library-option"]');
  await options.first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await options.count(), 4, "all 4 seeded library items across all 4 kinds must appear");

  const kinds = await options.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")).sort());
  assert.deepEqual(kinds, ["creature", "hero", "item", "stagecraft"]);

  await page.close();
});

test("From library: search narrows to the matching option only", async () => {
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  await picker.locator('[data-testid="from-library-option"]').first().waitFor({ state: "visible", timeout: 10000 });

  await picker.locator('[data-testid="from-library-search-input"]').fill("Verdigris");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="from-library-option"]').length === 1, null, { timeout: 5000 });
  assert.equal(await picker.locator('[data-testid="from-library-option"]').first().getAttribute("data-source-id"), "it_verdigris_key");

  await page.close();
});

test("From library: the kind filter narrows to that one kind", async () => {
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  await picker.locator('[data-testid="from-library-option"]').first().waitFor({ state: "visible", timeout: 10000 });

  await picker.locator('[data-testid="from-library-kind-chip"][data-kind="hero"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="from-library-option"]').length === 1, null, { timeout: 5000 });
  const only = picker.locator('[data-testid="from-library-option"]').first();
  assert.equal(await only.getAttribute("data-kind"), "hero");
  assert.equal(await only.getAttribute("data-source-id"), kestrel.id);

  await page.close();
});

// ---------------------------------------------------------------------------
// WIRING: reuses the tray-drop route -- element+roster for a creature,
// roster-only for hero/asset, and the SAME dedup as a real tray drop.
// ---------------------------------------------------------------------------
test("From library: attaching a creature creates a KEY-like element AND a roster entry (via the real tray-drop route)", async () => {
  const { page, root } = await openScene(scene.id);

  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  await picker.locator(`[data-testid="from-library-option"][data-kind="creature"][data-source-id="${ogrekin.id}"]`).waitFor({ state: "visible", timeout: 10000 });
  await picker.locator(`[data-testid="from-library-option"][data-kind="creature"][data-source-id="${ogrekin.id}"]`).click();

  await page.waitForFunction(
    (name) => Array.from(document.querySelectorAll('[data-testid="scene-element-row"]')).some((r) => r.textContent.includes(name)),
    "Ogrekin Skirmisher",
    { timeout: 10000 }
  );

  const elements = await listSceneElementsViaRoute(scene.id);
  const el = elements.find((e) => e.fields?.bestiaryEntryId === ogrekin.id);
  assert.ok(el, "attaching a creature must create a scene element carrying a stat block");
  assert.ok(el.stat, "the created element must carry a stat block (the KEY-like behavior)");

  const tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.deepEqual(
    tray.body.roster.find((r) => r.kind === "creature" && r.id === ogrekin.id),
    { id: ogrekin.id, n: 1, kind: "creature" }
  );

  await page.close();
});

test("From library: attaching the SAME creature twice does NOT duplicate the element (same dedup as a real tray drop) -- it stacks the roster instead", async () => {
  const before = (await listSceneElementsViaRoute(scene.id)).filter((e) => e.fields?.bestiaryEntryId === ogrekin.id).length;
  assert.equal(before, 1, "test setup: the prior test must have already attached this creature once");

  const { page, root } = await openScene(scene.id);
  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  const opt = picker.locator(`[data-testid="from-library-option"][data-kind="creature"][data-source-id="${ogrekin.id}"]`);
  await opt.waitFor({ state: "visible", timeout: 10000 });
  await opt.click();
  await page.waitForTimeout(500);

  const elements = (await listSceneElementsViaRoute(scene.id)).filter((e) => e.fields?.bestiaryEntryId === ogrekin.id);
  assert.equal(elements.length, 1, "a repeat attach must NOT create a second element");

  const tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  const entry = tray.body.roster.find((r) => r.kind === "creature" && r.id === ogrekin.id);
  assert.equal(entry.n, 2, "a repeat creature attach stacks the roster count");

  await page.close();
});

test("From library: attaching a hero lands in the roster only (no scene element created)", async () => {
  const beforeCount = (await listSceneElementsViaRoute(scene.id)).length;

  const { page, root } = await openScene(scene.id);
  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  const opt = picker.locator(`[data-testid="from-library-option"][data-kind="hero"][data-source-id="${kestrel.id}"]`);
  await opt.waitFor({ state: "visible", timeout: 10000 });
  await opt.click();
  await page.waitForTimeout(500);

  const afterCount = (await listSceneElementsViaRoute(scene.id)).length;
  assert.equal(afterCount, beforeCount, "a hero attach must create NO scene element -- display-only");

  const tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.deepEqual(
    tray.body.roster.find((r) => r.kind === "hero" && r.id === kestrel.id),
    { id: kestrel.id, n: 1, kind: "hero" }
  );

  await page.close();
});

test("From library: attaching a Reliquary item lands in the roster as an asset (no scene element)", async () => {
  const beforeCount = (await listSceneElementsViaRoute(scene.id)).length;

  const { page, root } = await openScene(scene.id);
  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  const opt = picker.locator('[data-testid="from-library-option"][data-kind="item"][data-source-id="it_verdigris_key"]');
  await opt.waitFor({ state: "visible", timeout: 10000 });
  await opt.click();
  await page.waitForTimeout(500);

  const afterCount = (await listSceneElementsViaRoute(scene.id)).length;
  assert.equal(afterCount, beforeCount, "an asset attach must create NO scene element");

  const tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.deepEqual(
    tray.body.roster.find((r) => r.kind === "asset" && r.id === "it_verdigris_key"),
    { id: "it_verdigris_key", n: 1, kind: "asset" }
  );

  await page.close();
});

test("From library: attaching a Stagecraft asset also lands in the roster as an asset (one semantic, same as a Reliquary item)", async () => {
  const { page, root } = await openScene(scene.id);
  await root.locator('[data-testid="from-library-btn"]').click();
  const picker = root.locator('[data-testid="from-library-picker"]');
  const opt = picker.locator('[data-testid="from-library-option"][data-kind="stagecraft"][data-source-id="sc_chantry_map"]');
  await opt.waitFor({ state: "visible", timeout: 10000 });
  await opt.click();
  await page.waitForTimeout(500);

  const tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.deepEqual(
    tray.body.roster.find((r) => r.kind === "asset" && r.id === "sc_chantry_map"),
    { id: "sc_chantry_map", n: 1, kind: "asset" }
  );

  await page.close();
});
