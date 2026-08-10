// Phase 38 task 38.4 -- Russell's catalog-tier request (2026-08-10, during
// the install wave): "grab some of the metadata and just add them to the
// library anyway ... I'd like to not limit an llm looking through the
// library from using or suggesting a map just because it's not loaded up
// yet." A StagecraftAsset gained the additive `catalogRef {manifestUrl,
// packId}` field (stagecraft-store.mjs); a row carrying it with NO
// foundryRef and NO compendiumRef is a known-but-not-installed external
// pack: browsable/searchable/taggable like any shelf row, badged
// "in catalog — not installed" so it cannot be mistaken for a stageable
// map. Orchestrator-authored alongside the implementation (same commit),
// per the small-addition precedent -- the frozen phase38-fixture.mjs
// contract is untouched.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupPhase38Env, cleanupScratchEnv, primeWorldSelection, DESKTOP_VIEWPORT } from "./phase38-fixture.mjs";

const { scratchDir } = setupPhase38Env("gm-tools-e2e-p38cat-");
const WORLD = "e2e-p38cat-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { saveStagecraftAsset } = await import("../../../session-planner/stagecraft-store.mjs");
const { createReviewServer } = await import("../../server.mjs");

saveStagecraftAsset(WORLD, {
  kind: "map",
  name: "Hippodrome",
  source: "local",
  meta: "Czepeku pack — in catalog, not installed",
  tags: ["czepeku"],
  catalogRef: { manifestUrl: "https://example.com/czepeku/hippodrome/module.json", packId: "czepeku-hippodrome" },
  status: "accepted"
}, { makeId: () => "sc_cat_hippodrome" });

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

test("a catalogRef-only Stagecraft row renders on the shelf with the 'in catalog — not installed' badge (browsable, never mistaken for stageable)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/stagecraft`);
  await page.locator('[data-testid="library-stagecraft-root"]').waitFor({ state: "visible", timeout: 15000 });

  const row = page.locator('[data-testid="tagged-shelf-row"][data-item-id="sc_cat_hippodrome"]');
  await row.waitFor({ state: "visible", timeout: 10000 });
  const badge = row.locator('[data-testid="tagged-shelf-row-catalog-badge"]');
  await badge.waitFor({ state: "visible", timeout: 5000 });
  assert.match((await badge.textContent()) ?? "", /in catalog/);

  await page.close();
});
