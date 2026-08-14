// Friction Wave 1 W4 -- real headless-Chromium verification of the
// "Available via Plutonium" source layer (W4b shelf + W4c add-to-shelf),
// against a FIXTURE module data dir (never the real Plutonium install).
//
// Flow under test (friction.md 2026-08-14, "Plutonium's bundled 5etools
// data as a Library source"):
//   1. The Bestiary tab renders the read-only shelf below the curated grid,
//      distinct Plutonium pill, windowed rows.
//   2. Text search narrows it (server-side).
//   3. Per-creature "Add to shelf" lands a REAL accepted curated bestiary
//      entry (store-asserted) with the stats + "SOURCE pPAGE via Plutonium"
//      note, and the curated grid re-renders showing it with the
//      "Plutonium" pill -- while the source layer itself stays read-only.
//   4. The re-rendered shelf row shows "on shelf" instead of the add button
//      (the dedupe made visible).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-w4-plutonium-");
const WORLD = "e2e-w4-plutonium";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { listBestiaryEntries } = await import("../../../combat-planning/bestiary-store.mjs");
const { clearPlutoniumIndexCache } = await import("../../../combat-planning/plutonium-source.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

// --- the fixture Plutonium module dir (5etools shapes, miniaturized) --------
const bestiaryDir = join(dataDir, "modules", "plutonium", "data", "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
writeFileSync(join(bestiaryDir, "bestiary-mm.json"), JSON.stringify({
  monster: [
    { name: "Guard", source: "MM", page: 347, cr: "1/8", type: { type: "humanoid", tags: ["any race"] }, size: ["M"], ac: [{ ac: 16 }], hp: { average: 11 }, environment: ["urban"] },
    { name: "Veteran", source: "MM", page: 350, cr: "3", type: { type: "humanoid" }, size: ["M"], ac: [17], hp: { average: 58 } },
    { name: "Arcanaloth", source: "MM", page: 313, cr: "12", type: { type: "fiend", tags: ["yugoloth"] }, size: ["M"], ac: [17], hp: { average: 104 } }
  ]
}), "utf8");
writeFileSync(join(bestiaryDir, "bestiary-tob.json"), JSON.stringify({
  monster: [
    { name: "Cave Goblin", source: "ToB", page: 12, cr: "1/4", type: { type: "humanoid", tags: ["goblinoid"] }, size: ["S"], ac: [13], hp: { average: 7 } }
  ]
}), "utf8");
clearPlutoniumIndexCache();

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

async function openBestiaryTab(page) {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="plutonium-shelf"]').waitFor({ state: "visible", timeout: 15000 });
}

test("the shelf renders below the curated grid with the distinct Plutonium pill and all fixture rows (windowed fetch)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openBestiaryTab(page);

  const pill = page.locator('[data-testid="plutonium-shelf-pill"]');
  assert.equal((await pill.textContent())?.trim(), "Plutonium");

  await page.locator('[data-testid="plutonium-row"]').first().waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="plutonium-row"]').count(), 4, "all four fixture creatures on page one");

  // The read-only rule: merely rendering the shelf added NOTHING curated.
  assert.deepEqual(listBestiaryEntries(), [], "browsing the source layer must never write to the curated store");
  await page.close();
});

test("text search narrows the shelf server-side", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openBestiaryTab(page);
  await page.locator('[data-testid="plutonium-row"]').first().waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="plutonium-search-input"]').fill("goblin");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="plutonium-row"]').length === 1,
    { timeout: 15000 }
  );
  const row = page.locator('[data-testid="plutonium-row"]');
  assert.equal(await row.getAttribute("data-name"), "Cave Goblin");
  assert.equal(await row.getAttribute("data-source"), "ToB");
  await page.close();
});

test("'Add to shelf' lands a REAL accepted curated entry (stats + provenance note), the curated grid shows it with the Plutonium pill, and the shelf row flips to 'on shelf'", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openBestiaryTab(page);
  const guardRow = page.locator('[data-testid="plutonium-row"][data-name="Guard"]');
  await guardRow.waitFor({ state: "visible", timeout: 15000 });

  await guardRow.locator('[data-testid="plutonium-row-add-btn"]').click();

  // The add triggers a full Bestiary re-render -- wait for the curated card.
  const card = page.locator('[data-testid="library-creature-card"]');
  await card.waitFor({ state: "visible", timeout: 15000 });
  assert.equal((await card.locator('[data-testid="library-creature-card-name"]').textContent())?.trim(), "Guard");
  assert.equal((await card.locator('[data-testid="library-creature-card-source"]').textContent())?.trim(), "Plutonium", "the curated card carries the DISTINCT pill, not 'Mine'");

  // Store-level truth, not just pixels.
  const entries = listBestiaryEntries();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.status, "accepted");
  assert.equal(entry.rawFields.name, "Guard");
  assert.equal(entry.rawFields.ac, 16);
  assert.equal(entry.rawFields.hp, 11);
  assert.equal(entry.rawFields.challengeRating, "1/8");
  assert.equal(entry.note, "MM p347 via Plutonium");
  assert.equal(entry.sourcePill, "plutonium");

  // The re-rendered shelf row now shows the quiet dedupe marker.
  const rerenderedRow = page.locator('[data-testid="plutonium-row"][data-name="Guard"]');
  await rerenderedRow.locator('[data-testid="plutonium-row-on-shelf"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await rerenderedRow.locator('[data-testid="plutonium-row-add-btn"]').count(), 0, "no second add button for an already-added creature");
  await page.close();
});

test("the add button's own copy documents that Foundry import stays a manual Plutonium act", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openBestiaryTab(page);
  const veteranRow = page.locator('[data-testid="plutonium-row"][data-name="Veteran"]');
  await veteranRow.waitFor({ state: "visible", timeout: 15000 });
  const title = await veteranRow.locator('[data-testid="plutonium-row-add-btn"]').getAttribute("title");
  assert.match(title ?? "", /manual Plutonium act/i);
  // And the shelf blurb states the same rule where the shelf starts.
  const shelfText = await page.locator('[data-testid="plutonium-shelf"]').textContent();
  assert.match(shelfText ?? "", /manual Plutonium act at prep time/i);
  await page.close();
});
