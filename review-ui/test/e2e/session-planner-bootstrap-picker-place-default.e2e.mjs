// Phase 20 task 20.1 -- regression test for the scene-bootstrap location
// picker's default type filter. plans/phase-20-tasks.md 20.1's confirmed
// root cause: buildEntityPicker (session-planner-view.js) fetched every
// entity type with zero bias toward locations at all, even though the
// scene-bootstrap flow is specifically asking "which PLACE". Fixed via a new
// `defaultTypeFilter: "place"` option, applied to the UNTYPED initial result
// set only -- typing anything re-searches the full entity list regardless of
// type, so a DM can still deliberately reach a non-Place anchor.
//
// Mirrors session-planner-flush-on-navigate.e2e.mjs's/session-planner-
// recenter-race.e2e.mjs's exact conventions: real in-process server
// (createReviewServer), real fixture seeding via bootstrapSnapshot +
// applyHeadless (never hand-constructed fixture JSON), real headless
// Chromium.
//
// This test deliberately exercises the picker via the scene-BOOTSTRAP flow
// (task 17.1's empty-state screen, reached at the bare `#session-planner`
// hash with no persisted last-scene state -- see fixture.mjs/setupScratchEnv
// for why a fresh scratch env + a fresh browser context guarantees no
// leftover localStorage entry from an earlier test), per
// plans/phase-20-tasks.md 20.1's own suggestion ("extend the existing
// scene-bootstrap e2e coverage") -- buildEntityPicker is the ONE shared
// component behind both the bootstrap picker and the re-center picker (task
// 17.5), so proving the default here proves it for both call sites without
// needing a second, near-duplicate test.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-sp-picker-default-");
const WORLD = "e2e-sp-picker-default-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sp-picker-place-alpha", name: "Alpha Waystation", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sp-picker-place-beta", name: "Beta Crossroads", type: "place", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "sp-picker-person-gale", name: "Gale the Wanderer", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "sp-picker-item-lantern", name: "Everburning Lantern", type: "item", importance: 0.3 } }
]);

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("scene-bootstrap location picker: untyped initial results are Place-only, but typing still finds a non-Place entity", async () => {
  await page.goto(`${base}/#session-planner`);

  const input = page.locator('[data-testid="scene-bootstrap-location-input"]');
  await input.waitFor({ state: "visible", timeout: 15000 });

  // Wait for the async /api/graph fetch to land and populate real results,
  // rather than racing the initial "Loading entities…" status text.
  const results = page.locator('[data-testid="scene-bootstrap-location-results"] [data-testid="scene-bootstrap-location-option"]');
  await results.first().waitFor({ state: "visible", timeout: 15000 });

  const initialIds = await results.evaluateAll((els) => els.map((el) => el.getAttribute("data-entity-id")));
  assert.deepEqual(
    [...initialIds].sort(),
    ["sp-picker-place-alpha", "sp-picker-place-beta"],
    `expected the untyped initial result set to contain ONLY the two Place entities; got: ${JSON.stringify(initialIds)}`
  );

  // Broadening past the default: typing a non-Place entity's own name must
  // still find it -- confirms this is a DEFAULT bias, not a hard type
  // restriction baked into the fetch/filter.
  await input.fill("Gale");
  const galeOption = page.locator('[data-testid="scene-bootstrap-location-option"][data-entity-id="sp-picker-person-gale"]');
  await galeOption.waitFor({ state: "visible", timeout: 5000 });
  await assert.doesNotReject(
    async () => assert.match(await galeOption.textContent(), /Gale the Wanderer \(person\)/),
    "typing past the default filter must surface the real non-Place match, not silently keep it hidden"
  );

  // And typing a real Place's own name still works too (sanity: the default
  // filter's UNTYPED case and the typed/search case aren't accidentally the
  // same code path with one silently broken).
  await input.fill("Everburning");
  const lanternOption = page.locator('[data-testid="scene-bootstrap-location-option"][data-entity-id="sp-picker-item-lantern"]');
  await lanternOption.waitFor({ state: "visible", timeout: 5000 });
});
