// Phase 34 task 34.0 -- QE-first e2e contract, part 1: the 4-way nav, the
// Connection Menu chip+panel, and the `#settings`/`#import` retire-as-
// replaced redirects. Read phase34-fixture.mjs FIRST (the full contract this
// file locks in). Authored QE-first: every test below is RED against today's
// build (34.2 is what turns it green) for the reasons quoted in this task's
// own completion report.
//
// EXPECTED-RED reasons (per test, confirmed by direct read of app-shell.js/
// index.html/server.mjs before writing these):
//  - 4-way nav: `[data-testid="shell-nav-chronicle"]`/`-library"]` do not
//    exist anywhere in index.html/app-shell.js today (only the two Phase 30
//    surface-toggle buttons do) -- Playwright selector-not-found.
//  - conn-chip/conn-panel: NEITHER testid exists anywhere in this codebase
//    (confirmed via grep) -- selector-not-found.
//  - redirects: `#settings`/`#import` still resolve to the LEGACY
//    `view-settings`/`view-import` sections (app.js's `renderCurrentView`,
//    confirmed by direct read) -- no redirect exists.
//  - route-level (§4): `GET /api/foundry/connection`, `POST /api/foundry/
//    sync-now`, `GET/POST /api/settings`, `POST /api/lore/worldanvil` all
//    404 today (confirmed: none of these path segments appear anywhere in
//    server.mjs's route table) -- generic "No route" fallback.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase34Env,
  cleanupScratchEnv,
  primeWorldSelection,
  fetchConnectionViaRoute,
  syncNowViaRoute,
  fetchSettingsViaRoute,
  patchSettingsViaRoute,
  worldanvilImportViaRoute,
  DESKTOP_VIEWPORT
} from "./phase34-fixture.mjs";

const { scratchDir, dataDir } = setupPhase34Env("gm-tools-e2e-p34nav-");
const WORLD = "e2e-p34nav-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p34n-root", name: "The Verdigris Compact", type: "place", importance: 0.6 } }
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

// ---------------------------------------------------------------------------
// 1. FOUR-WAY NAV
// ---------------------------------------------------------------------------
test('shell topbar renders 4 nav items -- Session planner / World / Chronicle / Library -- and clicking Chronicle/Library navigates + updates the active surface', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="app-shell"]').waitFor({ state: "visible", timeout: 15000 });

  // The two PRE-EXISTING nav items must still be there (backward compat).
  await page.locator('[data-testid="shell-surface-toggle-planner"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="shell-surface-toggle-world"]').waitFor({ state: "visible", timeout: 5000 });

  // The two NEW nav items (RED today -- do not exist).
  const chronicleNav = page.locator('[data-testid="shell-nav-chronicle"]');
  const libraryNav = page.locator('[data-testid="shell-nav-library"]');
  await chronicleNav.waitFor({ state: "visible", timeout: 10000 });
  await libraryNav.waitFor({ state: "visible", timeout: 10000 });

  await chronicleNav.click();
  await page.waitForFunction(() => location.hash === "#chronicle", null, { timeout: 8000 });
  assert.equal(
    await page.getAttribute('[data-testid="app-shell"]', "data-surface"),
    "chronicle",
    'clicking Chronicle must set app-shell\'s data-surface to "chronicle"'
  );
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(
    await page.locator('[data-testid="shell-main"] > *').count(),
    1,
    "the Chronicle scaffold root must be the SOLE occupant of shell-main"
  );

  await libraryNav.click();
  await page.waitForFunction(() => location.hash === "#library", null, { timeout: 8000 });
  assert.equal(
    await page.getAttribute('[data-testid="app-shell"]', "data-surface"),
    "library",
    'clicking Library must set app-shell\'s data-surface to "library"'
  );
  await page.locator('[data-testid="library-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

test('a direct page.goto to #chronicle / #library renders the shell with the correct surface (deep link, no prior click)', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="app-shell"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.getAttribute('[data-testid="app-shell"]', "data-surface"), "library");
  await page.locator('[data-testid="library-surface-root"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

// ---------------------------------------------------------------------------
// 2. CONNECTION CHIP + PANEL
// ---------------------------------------------------------------------------
test('the connection chip renders in the shell topbar with data-state sourced from GET /api/foundry/connection, and clicking it opens the panel', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="app-shell"]').waitFor({ state: "visible", timeout: 15000 });

  const chip = page.locator('[data-testid="conn-chip"]');
  await chip.waitFor({ state: "visible", timeout: 10000 });
  // No foundry-index exists for this fixture world -> "off".
  await page.waitForFunction(
    () => document.querySelector('[data-testid="conn-chip"]')?.getAttribute("data-state") === "off",
    null,
    { timeout: 10000 }
  );

  await chip.click();
  const panel = page.locator('[data-testid="conn-panel"]');
  await panel.waitFor({ state: "visible", timeout: 10000 });

  await panel.locator('[data-testid="conn-panel-foundry-section"]').waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="conn-panel-lore-section"]').waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="conn-panel-history-section"]').waitFor({ state: "visible", timeout: 5000 });
  await panel.locator('[data-testid="conn-panel-settings-section"]').waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

test('the panel\'s lore-intake section has paste and World Anvil modes, mutually exclusive', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').click();
  const panel = page.locator('[data-testid="conn-panel"]');
  await panel.waitFor({ state: "visible", timeout: 15000 });

  await panel.locator('[data-testid="conn-lore-mode-paste"]').click();
  await panel.locator('[data-testid="conn-lore-paste-input"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await panel.locator('[data-testid="conn-lore-worldanvil-input"]').count(), 0, "paste mode must NOT show the World Anvil url input");

  await panel.locator('[data-testid="conn-lore-mode-worldanvil"]').click();
  await panel.locator('[data-testid="conn-lore-worldanvil-input"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await panel.locator('[data-testid="conn-lore-paste-input"]').count(), 0, "World Anvil mode must NOT show the paste textarea");
  await page.close();
});

test('Esc closes the connection panel', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').click();
  const panel = page.locator('[data-testid="conn-panel"]');
  await panel.waitFor({ state: "visible", timeout: 15000 });

  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden", timeout: 5000 }).catch(async () => {
    assert.equal(await panel.count(), 0, "Esc must close (hide or remove) the connection panel");
  });
  await page.close();
});

test('clicking outside the connection panel closes it', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').click();
  const panel = page.locator('[data-testid="conn-panel"]');
  await panel.waitFor({ state: "visible", timeout: 15000 });

  // A stable, always-present, panel-EXTERIOR element.
  await page.locator('[data-testid="shell-world-select"]').click({ force: true });
  await panel.waitFor({ state: "hidden", timeout: 5000 }).catch(async () => {
    assert.equal(await panel.count(), 0, "clicking outside must close (hide or remove) the connection panel");
  });
  await page.close();
});

// ---------------------------------------------------------------------------
// 3. REDIRECTS -- #settings / #import retire-as-replaced
// ---------------------------------------------------------------------------
test('#settings redirects to the Connection Menu panel (settings section) -- the old view-settings screen never becomes active', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#settings`);
  await page.waitForFunction(() => location.hash !== "#settings", null, { timeout: 10000 });

  const activeIsLegacySettings = await page.evaluate(() => {
    const active = document.querySelector(".view.active");
    return !!active && active.id === "view-settings";
  });
  assert.equal(activeIsLegacySettings, false, "#settings must NOT land on the legacy view-settings screen");

  await page.locator('[data-testid="conn-panel"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="conn-panel-settings-section"]').waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

test('#import redirects to the Connection Menu panel (lore intake, paste mode default) -- the old view-import screen never becomes active', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#import`);
  await page.waitForFunction(() => location.hash !== "#import", null, { timeout: 10000 });

  const activeIsLegacyImport = await page.evaluate(() => {
    const active = document.querySelector(".view.active");
    return !!active && active.id === "view-import";
  });
  assert.equal(activeIsLegacyImport, false, "#import must NOT land on the legacy view-import screen");

  await page.locator('[data-testid="conn-panel"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="conn-panel-lore-section"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="conn-lore-paste-input"]').waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

// ---------------------------------------------------------------------------
// 4. ROUTE-LEVEL: THE 34.1 BACKEND CONTRACT
// ---------------------------------------------------------------------------
test('route-level: GET /api/foundry/connection returns the contracted shape -- no index for this world means state:"off", counts:null', async () => {
  const { status, body } = await fetchConnectionViaRoute(base, WORLD);
  assert.equal(status, 200, `GET /api/foundry/connection must be a real, wired route -- got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.state, "off", 'no foundry-index for this fixture world -> state must be "off"');
  assert.equal(body.counts, null, "no index -> counts must be null");
  assert.equal(typeof body.staleThresholdMs, "number", "staleThresholdMs must be a number (has a default even with no index)");
  assert.equal(body.world, WORLD, "response must echo the requested world");
});

test('route-level: POST /api/foundry/sync-now with no index returns {state:"off", ...} without throwing', async () => {
  const { status, body } = await syncNowViaRoute(base, WORLD);
  assert.equal(status, 200, `POST /api/foundry/sync-now must be a real, wired route -- got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.state, "off", "no index -> sync-now must report state:off, not throw/500");
});

test('route-level: GET/POST /api/settings patch semantics -- campaignName/calendar/staleThresholdMs round-trip, unspecified fields untouched', async () => {
  const before = await fetchSettingsViaRoute(base, WORLD);
  assert.equal(before.status, 200, `GET /api/settings must be a real, wired route -- got ${before.status}: ${JSON.stringify(before.body)}`);

  const patched = await patchSettingsViaRoute(base, WORLD, { campaignName: "The Verdigris Compact" });
  assert.equal(patched.status, 200, `POST /api/settings must be a real, wired route -- got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.campaignName, "The Verdigris Compact");

  const secondPatch = await patchSettingsViaRoute(base, WORLD, { calendar: "Harptos" });
  assert.equal(secondPatch.body.calendar, "Harptos");
  assert.equal(secondPatch.body.campaignName, "The Verdigris Compact", "patching calendar must NOT clobber the previously-set campaignName (patch, not replace)");

  const after = await fetchSettingsViaRoute(base, WORLD);
  assert.equal(after.body.campaignName, "The Verdigris Compact");
  assert.equal(after.body.calendar, "Harptos");
});

test('route-level: POST /api/lore/worldanvil against an unreachable URL returns a 4xx naming the fetch failure -- never the generic "No route" fallback, never a real internet call', async () => {
  const { status, body } = await worldanvilImportViaRoute(base, WORLD);
  assert.ok(status >= 400 && status < 500, `an unreachable World Anvil URL must be a 4xx -- got ${status}: ${JSON.stringify(body)}`);
  assert.notEqual(status, 404, "must not be the generic route-not-found 404 -- the route itself must exist and handle the fetch failure");
  assert.match(
    String((body && body.error) || ""),
    /fetch|reach|refused|resolve|ECONNREFUSED|ENOTFOUND|network/i,
    `the error must name the fetch failure, not a generic "no route" message -- got: ${JSON.stringify(body)}`
  );
});
