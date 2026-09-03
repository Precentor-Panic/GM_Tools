// Rules oracle tab (B4/G11): deterministic search renders cited cards from
// both backends; the GM-only ask panel degrades honestly keyless (this
// process sets no API key — the offline path IS the path under test); a
// no-source question says so instead of inventing. Synthetic backends only.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { setupPhase30Env, cleanupScratchEnv, primeWorldSelection, DESKTOP_VIEWPORT } from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-rules-tab-");
const WORLD = "e2e-rules-tab-world";
process.env.WF_DEFAULT_WORLD = WORLD;
delete process.env.ANTHROPIC_API_KEY;

const plutoniumData = join(dataDir, "modules", "plutonium", "data");
mkdirSync(plutoniumData, { recursive: true });
writeFileSync(join(plutoniumData, "actions.json"), JSON.stringify({
  action: [{ name: "Shove", source: "TSTB", page: 12, entries: ["Knock a creature prone or push it 5 feet away."] }]
}));
const shelf = join(scratchDir, "rules-library");
mkdirSync(join(shelf, "5e"), { recursive: true });
writeFileSync(join(shelf, "5e", "tst.txt"), "[[tst p.3]]\nShoving is resolved as a contested Athletics check.\n");
process.env.GM_TOOLS_RULES_DIR = shelf;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

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

test("search renders cited cards from both backends; keyless ask is honest; no-source questions say so", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/rules`);
  await page.locator('[data-testid="rules-search-input"]').waitFor({ state: "visible", timeout: 15000 });

  // Deterministic search: one structured card + one book card, both cited.
  await page.locator('[data-testid="rules-search-input"]').fill("shov");
  await page.locator('[data-testid="rules-search-btn"]').click();
  await page.locator('[data-testid="rules-result"]').first().waitFor({ state: "visible", timeout: 10000 });
  const results = page.locator('[data-testid="rules-result"]');
  assert.equal(await results.count(), 2);
  const allText = await page.locator('[data-testid="rules-results"]').textContent();
  assert.match(allText, /\(TSTB p\.12\)/, "structured citation pill");
  assert.match(allText, /\(TST p\.3\)/, "book citation pill");
  assert.match(allText, /PDF pages/, "the citation-convention note renders");

  // Keyless ask: honest offline note, citations still shown, no post button.
  await page.locator('[data-testid="rules-ask-input"]').fill("How does shoving work?");
  await page.locator('[data-testid="rules-ask-btn"]').click();
  await page.locator('[data-testid="rules-answer"]').waitFor({ state: "visible", timeout: 15000 });
  assert.match(await page.locator('[data-testid="rules-answer"]').textContent(), /Offline — no ANTHROPIC_API_KEY/);
  assert.equal(await page.locator('[data-testid="rules-post-ruling-btn"]').count(), 0, "no post button offline");

  // A question nothing matches: the honest empty answer, never invention.
  await page.locator('[data-testid="rules-ask-input"]').fill("What is the airspeed of an unladen swallow?");
  await page.locator('[data-testid="rules-ask-btn"]').click();
  await page.locator('[data-testid="rules-answer-none"]').waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});
