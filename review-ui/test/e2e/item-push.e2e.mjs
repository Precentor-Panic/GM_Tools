// "Aureus to the Table" workstream B2 task G8 -- real headless-Chromium
// verification of the Reliquary/Bestiary Foundry-PUSH UI (foundry-item-
// push-ops.mjs's producer lib + the three new routes), against a FIXTURE
// Plutonium module data dir (never the real install) and a fake, in-process
// Foundry-side watcher (setInterval on the real ops/results files under
// WF_DATA_DIR -- mirrors foundry-push-routes.test.mjs's own route-level
// fake-watcher convention, and phase36-fixture.mjs's armFakeFoundryWatcher
// for the single-op case; this file's own RECURRING watcher below handles
// the lostech flow's two SEQUENTIAL writeFoundryOps calls, which a one-shot
// timer can't answer).
//
// Flow under test:
//   1. Add "Bag of Holding" from the Reliquary's "Available via Plutonium"
//      shelf (G6) onto the curated shelf.
//   2. Open its "lostech…" toggle, set scarcity overrides (usesValue/usesMax,
//      recharges left unchecked -- the default), save.
//   3. Click "Push to Foundry" -- the ops file carries import_via_plutonium
//      THEN update_item (in that order), and the row's button is replaced by
//      the quiet "in Foundry" pill once both ops confirm.
//   4. A separate, hand-authored item (no Plutonium provenance) pushes a
//      single create_item op.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-item-push-");
const WORLD = "e2e-item-push";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { listItems } = await import("../../../combat-planning/item-store.mjs");
const { clearPlutoniumFamilyCache } = await import("../../../combat-planning/plutonium-source.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

// --- the fixture Plutonium module dir (5etools item shape, miniaturized) ---
const pluginDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(pluginDataDir, { recursive: true });
const BAG_OF_HOLDING = { name: "Bag of Holding", source: "DMG", page: 153, type: "AT", rarity: "uncommon", reqAttune: true, wondrous: true, weight: 15, value: 400000 };
writeFileSync(join(pluginDataDir, "items.json"), JSON.stringify({ item: [BAG_OF_HOLDING] }), "utf8");
writeFileSync(join(pluginDataDir, "items-base.json"), JSON.stringify({ baseitem: [] }), "utf8");
clearPlutoniumFamilyCache();

function opsPathFor(world) {
  return join(dataDir, "worlds", world, "world-fabric-foundry-ops.json");
}
function resultsPathFor(world) {
  return join(dataDir, "worlds", world, "world-fabric-foundry-results.json");
}

/**
 * A RECURRING fake Foundry-side watcher (setInterval) -- needed because the
 * lostech flow makes TWO SEQUENTIAL writeFoundryOps calls (the update op
 * doesn't exist on disk until the import op's own result has already been
 * consumed), which a one-shot timer (armFakeFoundryWatcher) can't answer.
 * Captures every ops batch it sees, in order, into `captured`.
 */
function armRecurringWatcher(world, respond) {
  const opsPath = opsPathFor(world);
  const resultsPath = resultsPathFor(world);
  const captured = [];
  const interval = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try {
      ops = JSON.parse(readFileSync(opsPath, "utf8"));
    } catch {
      return; // mid-write -- try again next tick
    }
    if (!Array.isArray(ops) || !ops.length) return;
    captured.push(...ops);
    mkdirSync(join(dataDir, "worlds", world), { recursive: true });
    writeFileSync(resultsPath, JSON.stringify(respond(ops)), "utf8");
    writeFileSync(opsPath, "[]", "utf8");
  }, 25);
  return { interval, captured };
}

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

test("add from Plutonium shelf -> set lostech overrides -> push -> 'in Foundry' pill; ops carry import_via_plutonium THEN update_item", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);

  // 1. Add "Bag of Holding" from the Plutonium shelf onto the curated shelf.
  const shelfRow = page.locator('[data-testid="plutonium-item-row"][data-name="Bag of Holding"]');
  await shelfRow.waitFor({ state: "visible", timeout: 15000 });
  await shelfRow.locator('[data-testid="plutonium-item-row-add-btn"]').click();
  const curatedRow = page.locator('[data-testid="tagged-shelf-row"]', { hasText: "Bag of Holding" });
  await curatedRow.waitFor({ state: "visible", timeout: 15000 });

  // 2. Open the lostech editor, set scarcity overrides (recharges left OFF -- the default).
  await curatedRow.locator('[data-testid="tagged-shelf-row-lostech-toggle"]').click();
  const panel = curatedRow.locator('[data-testid="tagged-shelf-row-lostech-panel"]');
  await panel.waitFor({ state: "visible", timeout: 15000 });
  await panel.locator('[data-testid="tagged-shelf-row-lostech-usesValue"]').fill("1");
  await panel.locator('[data-testid="tagged-shelf-row-lostech-usesMax"]').fill("1");
  const rechargeCheckbox = panel.locator('[data-testid="tagged-shelf-row-lostech-recharges"]');
  assert.equal(await rechargeCheckbox.isChecked(), false, "recharges defaults OFF -- the lostech default is scarcity");
  await panel.locator('[data-testid="tagged-shelf-row-lostech-save-btn"]').click();
  await page.locator('[data-testid="undo-toast"]').filter({ hasText: "Lostech overrides saved" }).waitFor({ state: "visible", timeout: 15000 });

  const item = listItems(WORLD).find((i) => i.name === "Bag of Holding");
  assert.deepEqual(item.pushOverrides, { usesValue: 1, usesMax: 1, recharges: false });

  // 3. Arm the recurring watcher, then push.
  const { interval, captured } = armRecurringWatcher(WORLD, (ops) => ops.map((op) => op.kind === "import_via_plutonium"
    ? { opId: op.opId, ok: true, foundryUuid: "Item.e2e-bag1" }
    : { opId: op.opId, ok: true, foundryUuid: op.data.itemUuid }
  ));

  const pushRow = page.locator('[data-testid="tagged-shelf-row"]', { hasText: "Bag of Holding" });
  await pushRow.locator('[data-testid="tagged-shelf-row-push-btn"]').click();
  await page.locator('[data-testid="undo-toast"]').filter({ hasText: "pushed to Foundry" }).waitFor({ state: "visible", timeout: 15000 });
  clearInterval(interval);

  assert.equal(captured.length, 2, "two SEQUENTIAL ops batches -- import, then the scarcity update");
  assert.equal(captured[0].kind, "import_via_plutonium");
  assert.deepEqual(captured[0].data.entry, BAG_OF_HOLDING, "the FULL raw 5etools record, verbatim");
  assert.equal(captured[1].kind, "update_item");
  assert.equal(captured[1].data.itemUuid, "Item.e2e-bag1");
  assert.deepEqual(captured[1].data.patch, { "system.uses": { value: 1, max: 1, recovery: [] } });

  // The "in Foundry" pill replaces the push button on re-render.
  const rerenderedRow = page.locator('[data-testid="tagged-shelf-row"]', { hasText: "Bag of Holding" });
  await rerenderedRow.locator('[data-testid="tagged-shelf-row-in-foundry-badge"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await rerenderedRow.locator('[data-testid="tagged-shelf-row-push-btn"]').count(), 0);

  const stored = listItems(WORLD).find((i) => i.name === "Bag of Holding");
  assert.equal(stored.foundryItemRef, "Item.e2e-bag1");

  await page.close();
});

test("a hand-authored item (no Plutonium provenance) pushes a single create_item op", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openReliquaryTab(page);

  await page.locator('[data-testid="library-hand-add-toggle"]').first().click();
  const form = page.locator('[data-testid="library-reliquary-hand-add"] [data-testid="library-hand-add-form"]');
  await form.waitFor({ state: "visible", timeout: 15000 });
  await form.locator('[data-testid="library-hand-add-name"]').fill("Rusty Key");
  await form.locator('[data-testid="library-hand-add-description"]').fill("Opens something, probably.");
  await form.locator('[data-testid="library-hand-add-submit-btn"]').click();

  const curatedRow = page.locator('[data-testid="tagged-shelf-row"]', { hasText: "Rusty Key" });
  await curatedRow.waitFor({ state: "visible", timeout: 15000 });

  const { interval, captured } = armRecurringWatcher(WORLD, (ops) => ops.map((op) => ({ opId: op.opId, ok: true, foundryUuid: "Item.e2e-key1" })));
  await curatedRow.locator('[data-testid="tagged-shelf-row-push-btn"]').click();
  await page.locator('[data-testid="undo-toast"]').filter({ hasText: "pushed to Foundry" }).waitFor({ state: "visible", timeout: 15000 });
  clearInterval(interval);

  assert.equal(captured.length, 1, "a single op -- no lostech overrides were set on this row");
  assert.equal(captured[0].kind, "create_item");
  assert.equal(captured[0].data.name, "Rusty Key");
  assert.equal(captured[0].data.type, "loot");
  assert.equal(captured[0].data.system.description.value, "<p>Opens something, probably.</p>");

  const rerenderedRow = page.locator('[data-testid="tagged-shelf-row"]', { hasText: "Rusty Key" });
  await rerenderedRow.locator('[data-testid="tagged-shelf-row-in-foundry-badge"]').waitFor({ state: "visible", timeout: 15000 });

  await page.close();
});
