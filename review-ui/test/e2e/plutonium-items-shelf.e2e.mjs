// "Aureus to the Table" task G6 -- real headless-Chromium verification of
// the Reliquary's own "Available via Plutonium" items shelf (G4's
// generalized `items` family + G5's routes + G6's shelf UI), against a
// FIXTURE module data dir (never the real Plutonium install). Mirrors
// test/e2e/w4-plutonium-shelf.e2e.mjs (the Bestiary tab's sibling shelf)
// one-for-one, adapted to items/Reliquary specifics (world-scoped write,
// type/rarity/source filters, toast feedback instead of inline-only text).
//
// Flow under test:
//   1. The Reliquary tab renders the read-only shelf below the curated list,
//      distinct Plutonium pill, windowed rows.
//   2. Text search narrows it (server-side).
//   3. Per-item "Add to shelf" lands a REAL accepted curated Reliquary item
//      (store-asserted, WORLD-SCOPED) with the "SOURCE pPAGE via Plutonium"
//      sourceText, a success toast fires, and the curated list re-renders
//      showing it -- while the source layer itself stays read-only.
//   4. Re-adding the SAME item -> 409, an "already on the shelf" toast, and
//      the re-rendered shelf row shows "on shelf" instead of the add button.
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

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-plutonium-items-");
const WORLD = "e2e-plutonium-items";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { listItems } = await import("../../../combat-planning/item-store.mjs");
const { clearPlutoniumFamilyCache } = await import("../../../combat-planning/plutonium-source.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

// --- the fixture Plutonium module dir (5etools item shapes, miniaturized) ---
const pluginDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(pluginDataDir, { recursive: true });
writeFileSync(join(pluginDataDir, "items.json"), JSON.stringify({
  item: [
    { name: "Potion of Healing", source: "DMG", page: 187, srd: true, type: "P", rarity: "common", weight: 0.5, value: 5000 },
    { name: "Bag of Holding", source: "DMG", page: 153, type: "AT", rarity: "uncommon", reqAttune: true, wondrous: true, weight: 15, value: 400000 },
    { name: "+1 All-Purpose Tool", source: "TCE", page: 119, type: "SCF", rarity: "uncommon", reqAttune: "by an artificer", wondrous: true }
  ]
}), "utf8");
writeFileSync(join(pluginDataDir, "items-base.json"), JSON.stringify({
  baseitem: [
    { name: "Longsword", source: "PHB", page: 149, srd: true, type: "M", rarity: "none", weight: 3, value: 1500 }
  ]
}), "utf8");
clearPlutoniumFamilyCache();

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

async function openReliquaryTab(page) {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="plutonium-items-shelf"]').waitFor({ state: "visible", timeout: 15000 });
}

test("the items shelf renders below the curated Reliquary list with the distinct Plutonium pill and all fixture rows", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);

  const pill = page.locator('[data-testid="plutonium-items-shelf-pill"]');
  assert.equal((await pill.textContent())?.trim(), "Plutonium");

  await page.locator('[data-testid="plutonium-item-row"]').first().waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="plutonium-item-row"]').count(), 4, "all four fixture items on page one");

  // The read-only rule: merely rendering the shelf added NOTHING curated.
  assert.deepEqual(listItems(WORLD), [], "browsing the source layer must never write to the curated item store");
  await page.close();
});

test("text search narrows the shelf server-side", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);
  await page.locator('[data-testid="plutonium-item-row"]').first().waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="plutonium-items-search-input"]').fill("longsword");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="plutonium-item-row"]').length === 1,
    { timeout: 15000 }
  );
  const row = page.locator('[data-testid="plutonium-item-row"]');
  assert.equal(await row.getAttribute("data-name"), "Longsword");
  assert.equal(await row.getAttribute("data-source"), "PHB");
  await page.close();
});

test("'Add to shelf' lands a REAL accepted, world-scoped curated item (sourceText provenance), fires a toast, curated list refreshes, and the re-rendered row shows the dedupe marker", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);
  const potionRow = page.locator('[data-testid="plutonium-item-row"][data-name="Potion of Healing"]');
  await potionRow.waitFor({ state: "visible", timeout: 15000 });

  await potionRow.locator('[data-testid="plutonium-item-row-add-btn"]').click();

  // Success toast, then the add triggers a full Reliquary re-render -- wait
  // for the curated row to appear.
  await page.locator('[data-testid="undo-toast"]').filter({ hasText: "added to the Reliquary" }).waitFor({ state: "visible", timeout: 15000 });
  const curatedRow = page.locator('[data-testid="tagged-shelf-row"]', { hasText: "Potion of Healing" });
  await curatedRow.waitFor({ state: "visible", timeout: 15000 });

  // Store-level truth, not just pixels.
  const items = listItems(WORLD);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.status, "accepted");
  assert.equal(item.name, "Potion of Healing");
  assert.equal(item.world, WORLD);
  assert.equal(item.sourceText, "DMG p187 via Plutonium");

  // The re-rendered shelf row now shows the quiet dedupe marker.
  const rerenderedRow = page.locator('[data-testid="plutonium-item-row"][data-name="Potion of Healing"]');
  await rerenderedRow.locator('[data-testid="plutonium-item-row-on-shelf"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await rerenderedRow.locator('[data-testid="plutonium-item-row-add-btn"]').count(), 0, "no second add button for an already-added item");

  await page.close();
});

test("re-add 409: a stale add button (already added server-side behind its back) surfaces the server's 409 as an 'already on the shelf' toast, no duplicate written", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);
  const toolRow = page.locator('[data-testid="plutonium-item-row"][data-name="+1 All-Purpose Tool"]');
  await toolRow.waitFor({ state: "visible", timeout: 15000 });
  const addBtn = toolRow.locator('[data-testid="plutonium-item-row-add-btn"]');
  await addBtn.waitFor({ state: "visible", timeout: 15000 });

  // Simulate a concurrent add landing first (a second tab, or a retry) --
  // real server call, bypassing this page entirely, so the page's own add
  // button is now genuinely STALE relative to server truth.
  const direct = await fetch(`${base}/api/combat-planning/items/add-from-plutonium`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "+1 All-Purpose Tool", source: "TCE" })
  });
  assert.equal(direct.status, 200);

  // Clicking the still-stale button fires the SAME route, which now 409s.
  await addBtn.click();
  await page.locator('[data-testid="undo-toast"]').filter({ hasText: "already on the shelf" }).waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="plutonium-item-row"][data-name="+1 All-Purpose Tool"] [data-testid="plutonium-item-row-add-btn"]')?.textContent === "already on shelf",
    { timeout: 15000 }
  );

  const matches = listItems(WORLD).filter((i) => i.name === "+1 All-Purpose Tool");
  assert.equal(matches.length, 1, "the 409 guard prevented a duplicate write");
  await page.close();
});

test("the shelf's own copy states the honest Reliquary-vs-Foundry-push framing", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);
  const shelfText = await page.locator('[data-testid="plutonium-items-shelf"]').textContent();
  assert.match(shelfText ?? "", /adds it to the Reliquary/i);
  assert.match(shelfText ?? "", /Foundry item is separate/i);
  await page.close();
});
