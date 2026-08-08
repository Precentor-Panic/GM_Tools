// Phase 35 task 35.0 -- QE-first e2e contract, part 2: Reliquary + Stagecraft,
// the ONE shared tagged-shelf component (README §H/"Ported once, used
// everywhere"). Read phase35-fixture.mjs FIRST (§1 ItemRecord, §2
// StagecraftAsset, §4 tags helper API, §8 routes, §10 UI/DOM contract).
//
// Seeded via seedItemRecords/seedStagecraftAssets (direct-fs, per
// phase35-fixture.mjs's own header note -- item-store.mjs/stagecraft-
// store.mjs don't exist yet, so there is no store/route to seed through).
//
// EXPECTED-RED reasons: `[data-testid="library-reliquary-root"]`/
// `-stagecraft-root"]`/`tagged-shelf-*` do not exist anywhere in
// review-ui/public/ today (grep-confirmed) -- Playwright selector-not-found.
// The tag-mutation/list routes (§8) all 404 today (grep-confirmed: none of
// these path segments appear in server.mjs's route table).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  makeItemRecord,
  seedItemRecords,
  makeStagecraftAsset,
  seedStagecraftAssets,
  listItemsViaRoute,
  addItemTagViaRoute,
  removeItemTagViaRoute,
  listStagecraftViaRoute,
  addStagecraftTagViaRoute,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p35shelf-");
const WORLD = "e2e-p35-tagged-shelf";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

const SEALED_SCROLL = makeItemRecord({
  id: "it_sealed_scroll", world: WORLD, name: "Sealed Causeway Scroll",
  type: "loot", description: "Tolls collected at the causeway for eleven years.",
  tags: ["clue", "causeway"], status: "accepted"
});
const VERDIGRIS_KEY = makeItemRecord({
  id: "it_verdigris_key", world: WORLD, name: "Verdigris Key",
  type: "wondrous item", description: "A palm-sized disc of green brass.",
  tags: ["vault", "quest", "verdigris"], status: "accepted"
});
const UNDESCRIBED_GRATE = makeItemRecord({
  id: "it_grate", world: WORLD, name: "Rusted Vault Grate",
  type: "loot", description: null, tags: ["vault", "obstacle"], status: "accepted"
});

const CHANTRY_MAP = makeStagecraftAsset({
  id: "sc_chantry_map", world: WORLD, kind: "map", name: "The Sunken Chantry",
  meta: "4000x3000, grid 100/5ft", desc: "Flooded to the knee, four cell doors.",
  tags: ["vault", "combat", "dark"], source: "foundry", status: "accepted"
});
const MARKET_SPLASH = makeStagecraftAsset({
  id: "sc_market_splash", world: WORLD, kind: "splash", name: "Market Square at Dusk",
  meta: null, desc: null, tags: ["city", "social", "crowd"], source: "local", status: "accepted"
});
const TAVERN_MUSIC = makeStagecraftAsset({
  id: "sc_tavern_music", world: WORLD, kind: "music", name: "Fiddle and Drum",
  meta: null, desc: "Fiddle and hand drum, a little out of tune.",
  tags: ["city", "ambience", "warm"], source: "local", status: "accepted"
});

seedItemRecords(WORLD, [SEALED_SCROLL, VERDIGRIS_KEY, UNDESCRIBED_GRATE]);
seedStagecraftAssets(WORLD, [CHANTRY_MAP, MARKET_SPLASH, TAVERN_MUSIC]);

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

// ---------------------------------------------------------------------------
// ROUTE-LEVEL: §8's list/tag-mutation routes (non-browser)
// ---------------------------------------------------------------------------
test("route contract: GET /api/combat-planning/items lists seeded ItemRecords (or 404s cleanly until 35.1)", async () => {
  const { status, body } = await listItemsViaRoute(base, WORLD);
  if (status === 404) return; // expected-red today
  assert.equal(status, 200);
  assert.equal(body.items.length, 3, "must list all 3 seeded items for this world");
  const names = body.items.map((i) => i.name).sort();
  assert.deepEqual(names, ["Rusted Vault Grate", "Sealed Causeway Scroll", "Verdigris Key"]);
});

test("route contract: GET /api/session-planner/stagecraft?kind=map filters to map-kind assets only (or 404s cleanly until 35.1)", async () => {
  const { status, body } = await listStagecraftViaRoute(base, WORLD, "map");
  if (status === 404) return; // expected-red today
  assert.equal(status, 200);
  assert.equal(body.assets.length, 1);
  assert.equal(body.assets[0].id, "sc_chantry_map");
});

test("route contract: POST .../items/:id/tags adds a tag, DELETE .../tags/:tag removes it (or 404s cleanly until 35.1)", async () => {
  const added = await addItemTagViaRoute(base, WORLD, "it_verdigris_key", "session3");
  if (added.status === 404) return; // expected-red today
  assert.equal(added.status, 200);
  assert.ok(added.body.item.tags.includes("session3"));

  const removed = await removeItemTagViaRoute(base, WORLD, "it_verdigris_key", "session3");
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.item.tags.includes("session3"));
});

test("route contract: POST .../stagecraft/:id/tags adds a tag (or 404s cleanly until 35.1)", async () => {
  const { status, body } = await addStagecraftTagViaRoute(base, WORLD, "sc_chantry_map", "finale");
  if (status === 404) return; // expected-red today
  assert.equal(status, 200);
  assert.ok(body.asset.tags.includes("finale"));
});

// ---------------------------------------------------------------------------
// UI-LEVEL: the shared tagged-shelf component
// ---------------------------------------------------------------------------
test("Reliquary: shelf rows render name/meta/source pill/description (or the italic no-description state), tag rail shows live counts", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const rows = page.locator('[data-testid="tagged-shelf-row"]');
  await rows.first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await rows.count(), 3, "all 3 seeded items must render as shelf rows");

  const grateRow = page.locator('[data-testid="tagged-shelf-row"][data-item-id="it_grate"]');
  assert.match((await grateRow.textContent()) ?? "", /no description/i, "an item with a null description must render an explicit 'no description' state, not an empty line");

  const vaultChip = page.locator('[data-testid="tagged-shelf-tag-chip"][data-tag="vault"]');
  await vaultChip.waitFor({ state: "visible", timeout: 5000 });
  const vaultCount = await vaultChip.locator('[data-testid="tagged-shelf-tag-chip-count"]').textContent();
  assert.match(vaultCount ?? "", /2/, `"vault" tags 2 of the 3 seeded items (Verdigris Key, Rusted Vault Grate), got "${vaultCount}"`);

  await page.close();
});

test("Reliquary: clicking two tags AND-filters (only the item carrying BOTH survives), Clear tag filter resets", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="tagged-shelf-tag-chip"][data-tag="vault"]').click();
  await page.locator('[data-testid="tagged-shelf-tag-chip"][data-tag="quest"]').click();

  const rows = page.locator('[data-testid="tagged-shelf-row"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tagged-shelf-row"]').length === 1, null, { timeout: 8000 });
  assert.equal(await rows.count(), 1, "only Verdigris Key carries BOTH vault and quest -- AND semantics, not OR");
  assert.equal(await rows.first().getAttribute("data-item-id"), "it_verdigris_key");

  await page.locator('[data-testid="tagged-shelf-clear-tags-btn"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tagged-shelf-row"]').length === 3, null, { timeout: 8000 });

  await page.close();
});

test("Reliquary: free-text search matches name/description/tags at once", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="tagged-shelf-search-input"]').fill("causeway");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tagged-shelf-row"]').length === 1, null, { timeout: 8000 });
  const rows = page.locator('[data-testid="tagged-shelf-row"]');
  assert.equal(await rows.first().getAttribute("data-item-id"), "it_sealed_scroll", "search must match description text, not just the name");

  await page.close();
});

test("Reliquary: the +tag inline add commits a real new tag via the tags route", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const row = page.locator('[data-testid="tagged-shelf-row"][data-item-id="it_grate"]');
  await row.locator('[data-testid="tagged-shelf-row-add-tag-btn"]').click();
  const input = row.locator('[data-testid="tagged-shelf-row-tag-input"]');
  await input.fill("session4");
  await input.press("Enter");

  await row.locator('[data-testid="tagged-shelf-row-tag"][data-tag="session4"]').waitFor({ state: "visible", timeout: 8000 });

  const { body } = await listItemsViaRoute(base, WORLD);
  const grate = body.items.find((i) => i.id === "it_grate");
  assert.ok(grate.tags.includes("session4"), "the tag add must be a REAL persisted mutation, not client-only state");

  await page.close();
});

test("Reliquary: clicking a row's own tag chip's ✕ removes it (distinct from clicking the tag label itself, which filters)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const row = page.locator('[data-testid="tagged-shelf-row"][data-item-id="it_verdigris_key"]');
  const tag = row.locator('[data-testid="tagged-shelf-row-tag"][data-tag="verdigris"]');
  await tag.waitFor({ state: "visible", timeout: 5000 });
  await tag.locator('[data-testid="tagged-shelf-row-tag-remove"]').click();
  await tag.waitFor({ state: "detached", timeout: 8000 });

  const { body } = await listItemsViaRoute(base, WORLD);
  const key = body.items.find((i) => i.id === "it_verdigris_key");
  assert.ok(!key.tags.includes("verdigris"), "the tag remove must be a REAL persisted mutation");

  await page.close();
});

// ---------------------------------------------------------------------------
// STAGECRAFT -- same shared shelf + the kind filter
// ---------------------------------------------------------------------------
test("Stagecraft: kind filter (All / Maps / Splash art / Music) restricts the shelf to that one kind", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/stagecraft`);
  await page.locator('[data-testid="library-stagecraft-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="tagged-shelf-row"]').first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="tagged-shelf-row"]').count(), 3, "all 3 seeded assets under the default All kind filter");

  await page.locator('[data-testid="library-stagecraft-kind-chip"][data-kind="map"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tagged-shelf-row"]').length === 1, null, { timeout: 8000 });
  assert.equal(await page.locator('[data-testid="tagged-shelf-row"]').first().getAttribute("data-item-id"), "sc_chantry_map");
  assert.equal(await page.locator('[data-testid="tagged-shelf-row"]').first().getAttribute("data-kind"), "map");

  await page.locator('[data-testid="library-stagecraft-kind-chip"][data-kind="all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="tagged-shelf-row"]').length === 3, null, { timeout: 8000 });

  await page.close();
});
