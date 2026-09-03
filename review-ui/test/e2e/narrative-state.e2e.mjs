// Narrative-state ("Layer 2") entity panel: reveal select, stance select,
// GM-only truth textarea, clock set/tick, and the append-only reveal
// history — set truth → reload → persists; tick a clock; reveal change
// appends a transition. Real server + real store (scratch dirs), no mocks.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-narrative-state-");
const WORLD = "e2e-narrative-state-world";
process.env.WF_DEFAULT_WORLD = WORLD;
delete process.env.ANTHROPIC_API_KEY;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "ns-marek", name: "Marek", type: "person", importance: 0.6 } }
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

async function openEntityPage(page) {
  await page.goto(`${base}/#graph`);
  await page.evaluate((w) => localStorage.setItem("gmReview.world", w), WORLD);
  await page.goto(`${base}/#entity/ns-marek`);
  await page.locator('[data-testid="narrative-state-save"]').waitFor({ state: "visible", timeout: 15000 });
}

test("no record => fully-open notice; create with truth+stance persists across a full reload", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openEntityPage(page);

  const body = page.locator("#entity-detail-narrative-state");
  assert.match(await body.textContent(), /fully open/i, "record-less entity says so instead of inventing a default");

  await page.locator('[data-testid="narrative-truth-input"]').fill("Marek is the Copper Hand's informant.");
  await page.locator('[data-testid="narrative-stance-select"]').selectOption("concealing");
  await page.locator('[data-testid="narrative-state-save"]').click();
  await page.locator("#entity-detail-narrative-state details").waitFor({ state: "visible", timeout: 5000 });

  // Full page reload — the record must come back from the store, not memory.
  await page.reload();
  await page.locator('[data-testid="narrative-state-save"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(
    await page.locator('[data-testid="narrative-truth-input"]').inputValue(),
    "Marek is the Copper Hand's informant."
  );
  assert.equal(await page.locator('[data-testid="narrative-stance-select"]').inputValue(), "concealing");
  assert.match(await body.textContent(), /Reveal: unrevealed/, "truth-first creation defaulted to unrevealed");
  await page.close();
});

test("reveal change appends a transition; clock set + tick round-trips", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openEntityPage(page);

  await page.locator('[data-testid="narrative-reveal-select"]').selectOption("hinted");
  await page.locator('[data-testid="narrative-state-save"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#entity-detail-narrative-state")?.textContent.includes("Reveal: hinted")
  , undefined, { timeout: 5000 });
  const summary = page.locator("#entity-detail-narrative-state details summary");
  assert.match(await summary.textContent(), /Reveal history \(2\)/, "creation + hinted = two transitions");

  await page.locator('[data-testid="narrative-clock-set"]').click();
  await page.locator('[data-testid="narrative-clock-tick"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="narrative-clock-tick"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#entity-detail-narrative-state")?.textContent.includes("clock 1/6")
  , undefined, { timeout: 5000 });
  await page.close();
});
