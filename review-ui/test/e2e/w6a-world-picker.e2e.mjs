// W6a -- the attach-or-create world picker, driven in real headless Chromium.
//
// Friction source (one-shot log, 2026-08-14): "Gear menu: no way to point at
// an EXISTING Foundry world." Russell had a real Foundry world folder
// (kilmarn) with no World Fabric snapshot; the old create-only card gave no
// way to attach it (typing the name would have errored "already exists" only
// AFTER a snapshot existed -- before that it would create into the folder
// with zero indication that was the right move). The shared picker
// (world-picker.js) now lists every Data/worlds/* directory -- selectable
// (has a snapshot), attachable (no snapshot), or named-but-unusable -- in
// all three world-choosing surfaces: the zero-worlds planner landing, the
// gear panel's disconnected card, and the gear panel's switch-world list.
//
// Tests are ORDERED (same convention as create-world-routes.test.mjs): the
// file starts from the real friction shape (zero GM_Tools worlds, real
// Foundry folders on disk) and walks forward through attach -> create ->
// switch.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-w6a-picker-");

const { createReviewServer } = await import("../../server.mjs");
const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { writeFoundryIndexFixture } = await import("./phase35-fixture.mjs");

// The on-disk starting condition -- the EXACT kilmarn first-run: real
// Foundry world folders exist, NONE has a World Fabric snapshot yet.
mkdirSync(join(dataDir, "worlds", "kilmarn"), { recursive: true });
writeFileSync(join(dataDir, "worlds", "kilmarn", "world.json"), JSON.stringify({ id: "kilmarn", title: "Kilmarn" }), "utf8");
mkdirSync(join(dataDir, "worlds", "ravenholt"), { recursive: true });
mkdirSync(join(dataDir, "worlds", "bad name"), { recursive: true });

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

test("zero-worlds landing offers the existing Foundry folders to ATTACH (not just a blank create field), and attaching kilmarn selects it", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await page.goto(`${base}/#planner/plans`);
  const cta = page.locator('[data-testid="planner-create-world-cta"]');
  await cta.waitFor({ state: "visible", timeout: 15000 });

  // The picker lists all three folders with the right affordances.
  const kilmarnRow = cta.locator('[data-testid="world-picker-row"][data-world="kilmarn"]');
  await kilmarnRow.waitFor({ state: "visible", timeout: 10000 });
  await kilmarnRow.locator('[data-testid="world-picker-attach-btn"]').waitFor({ state: "visible", timeout: 5000 });
  assert.match(await kilmarnRow.locator('[data-testid="world-picker-badge"]').textContent(), /not attached/i);

  const badRow = cta.locator('[data-testid="world-picker-row"][data-world="bad name"]');
  assert.equal(await badRow.locator('[data-testid="world-picker-attach-btn"]').count(), 0, "an id-unsafe folder name must not offer Attach");
  assert.match(await badRow.locator('[data-testid="world-picker-badge"]').textContent(), /not usable/i);

  assert.equal(
    await cta.locator('[data-testid="world-picker-select-btn"]').count(), 0,
    "nothing has a snapshot yet -- no row may claim to be selectable"
  );

  // The create fallback is still right there.
  await cta.locator('[data-testid="world-picker-create-input"]').waitFor({ state: "visible", timeout: 5000 });

  // Attach kilmarn.
  await kilmarnRow.locator('[data-testid="world-picker-attach-btn"]').click();
  await page.waitForFunction(() => localStorage.getItem("gmReview.world") === "kilmarn", null, { timeout: 10000 });

  // The snapshot landed INSIDE the existing folder, and the shell moved on
  // from the zero-worlds landing to the real plans shelf.
  assert.equal(existsSync(snapshotFilePath(dataDir, "kilmarn")), true, "attach must bootstrap a snapshot into the existing folder");
  await page.locator('[data-testid="planner-plans-view"] .planner-plans-title').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="planner-create-world-cta"]').count(), 0, "the zero-worlds landing must be gone after attach");
  await page.close();
});

test("gear panel (disconnected card) mounts the same picker: kilmarn now reads as a current GM_Tools world, ravenholt attachable, create fallback works", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await page.goto(`${base}/#graph`);
  await page.evaluate(() => localStorage.setItem("gmReview.world", "kilmarn"));
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').click();
  const panel = page.locator('[data-testid="conn-panel"]');
  await panel.waitFor({ state: "visible", timeout: 15000 });

  // No foundry-index for kilmarn -> disconnected card -> picker mounted there.
  const disconnected = panel.locator('[data-testid="conn-foundry-disconnected"]');
  await disconnected.waitFor({ state: "visible", timeout: 10000 });

  const kilmarnRow = disconnected.locator('[data-testid="world-picker-row"][data-world="kilmarn"]');
  await kilmarnRow.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await kilmarnRow.locator('[data-testid="world-picker-badge"]').textContent(), /GM_Tools world/i);
  await kilmarnRow.locator('[data-testid="world-picker-current"]').waitFor({ state: "visible", timeout: 5000 });

  const ravenholtRow = disconnected.locator('[data-testid="world-picker-row"][data-world="ravenholt"]');
  await ravenholtRow.locator('[data-testid="world-picker-attach-btn"]').waitFor({ state: "visible", timeout: 5000 });

  // Create fallback from the same surface.
  await disconnected.locator('[data-testid="world-picker-create-input"]').fill("fresh-world");
  await disconnected.locator('[data-testid="world-picker-create-btn"]').click();
  await page.waitForFunction(() => localStorage.getItem("gmReview.world") === "fresh-world", null, { timeout: 10000 });
  assert.equal(existsSync(snapshotFilePath(dataDir, "fresh-world")), true);
  await page.close();
});

test("typing an EXISTING GM_Tools world id into the create fallback gets a clean 'select it from the list' message, never a raw 500/409 dump", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await page.goto(`${base}/#graph`);
  await page.evaluate(() => localStorage.setItem("gmReview.world", "fresh-world"));
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').click();
  const disconnected = page.locator('[data-testid="conn-panel"] [data-testid="conn-foundry-disconnected"]');
  await disconnected.waitFor({ state: "visible", timeout: 15000 });

  // The exact confusion from the friction log: typing kilmarn's name into
  // the create blank. It's attached now, so the answer is "select it above".
  await disconnected.locator('[data-testid="world-picker-create-input"]').fill("kilmarn");
  await disconnected.locator('[data-testid="world-picker-create-btn"]').click();
  const status = disconnected.locator('[data-testid="world-picker-create-status"]');
  await page.waitForFunction(
    () => /select it from the list/i.test(document.querySelector('[data-testid="world-picker-create-status"]')?.textContent || ""),
    null, { timeout: 10000 }
  );
  assert.match(await status.textContent(), /already a GM_Tools world/i);
  // Still selectable in place: kilmarn's row above offers Select (it isn't current).
  await disconnected.locator('[data-testid="world-picker-row"][data-world="kilmarn"] [data-testid="world-picker-select-btn"]').waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

test("connected card's switch-world list is the SAME picker (one world surface): select an existing world, attachable folders offered there too", async () => {
  // Give kilmarn a real foundry-index so the connection reads live/stale ->
  // the CONNECTED card renders, whose "switch world" opens the list.
  writeFoundryIndexFixture(dataDir, "kilmarn");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await page.goto(`${base}/#graph`);
  await page.evaluate(() => localStorage.setItem("gmReview.world", "kilmarn"));
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').click();
  const panel = page.locator('[data-testid="conn-panel"]');
  await panel.waitFor({ state: "visible", timeout: 15000 });

  await panel.locator('[data-testid="conn-switch-world"]').click();
  const list = panel.locator('[data-testid="conn-world-switch-list"]');
  await list.waitFor({ state: "visible", timeout: 10000 });

  // The same shared picker rows: fresh-world selectable, ravenholt attachable.
  await list.locator('[data-testid="world-picker-row"][data-world="ravenholt"] [data-testid="world-picker-attach-btn"]').waitFor({ state: "visible", timeout: 10000 });
  const freshRow = list.locator('[data-testid="world-picker-row"][data-world="fresh-world"]');
  await freshRow.locator('[data-testid="world-picker-select-btn"]').click();
  await page.waitForFunction(() => localStorage.getItem("gmReview.world") === "fresh-world", null, { timeout: 10000 });
  await page.close();
});
