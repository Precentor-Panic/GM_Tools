// Briefing surface (2026-08-26) -- the world-level front matter as an
// editable card grid under the shell's new "Briefing" nav. Asserted against
// the real DOM: nav + deep link, sanitised body render, click-to-edit title
// persisting through the route, add/reorder/delete.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupPhase30Env, cleanupScratchEnv, primeWorldSelection, DESKTOP_VIEWPORT } from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-briefing-");
process.env.GM_TOOLS_BRIEFING_DIR = `${scratchDir}/briefing`;
const WORLD = "e2e-briefing-world";
process.env.WF_DEFAULT_WORLD = WORLD;
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
after(async () => { await browser?.close(); await new Promise((resolve) => server.close(resolve)); cleanupScratchEnv(scratchDir); });

const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: WORLD, ...body }) }).then((r) => r.json());
const list = () => fetch(`${base}/api/session-planner/briefing?world=${WORLD}`).then((r) => r.json()).then((b) => b.cards);

test("Briefing nav + deep link render the cards; body HTML is sanitised; edits persist; add/reorder/delete work", async () => {
  await post("/api/session-planner/briefing", { title: "The Premise", eyebrow: "The con", body: "<p>A debt is <b>due</b>.</p><script>window.__pwned=1</script><img src=x onerror=\"window.__pwned=2\">", span: 2 });
  await post("/api/session-planner/briefing", { title: "Cast", body: "<table><tr><th>Who</th><td>Vane</td></tr></table>" });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="shell-nav-briefing"]').click();
  const root = page.locator('[data-testid="briefing-surface-root"]');
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="briefing-card"]').first().waitFor({ timeout: 15000 });
  assert.equal(await page.evaluate(() => location.hash), "#briefing");
  const cards = page.locator('[data-testid="briefing-card"]');
  assert.equal(await cards.count(), 2);
  assert.equal(await cards.nth(0).getAttribute("data-span"), "2");
  assert.equal(await cards.nth(0).locator("b").textContent(), "due");
  assert.equal(await cards.nth(0).locator("script, img").count(), 0, "script/img stripped");
  assert.equal(await page.evaluate(() => window.__pwned ?? null), null);
  assert.equal(await cards.nth(1).locator("table th").textContent(), "Who");

  // Click-to-edit the second card's title.
  await cards.nth(1).locator('[data-testid="briefing-card-title"]').click();
  const input = page.locator('[data-testid="briefing-card-title-input"]').first();
  await input.waitFor({ state: "visible" });
  await input.fill("Dramatis Personae");
  await input.evaluate((el) => el.blur());
  await page.waitForFunction(() => fetch(location.origin + "/api/session-planner/briefing?world=" + localStorage.getItem("gmReview.world")).then((r) => r.json()).then((b) => b.cards.some((c) => c.title === "Dramatis Personae")));

  // Reorder: move the second card up; then add and delete.
  await cards.nth(1).locator('[data-testid="briefing-card-up"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="briefing-card"] [data-testid="briefing-card-title"]')?.textContent === "Dramatis Personae");
  assert.deepEqual((await list()).map((c) => c.title), ["Dramatis Personae", "The Premise"]);

  await page.locator('[data-testid="briefing-add-btn"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="briefing-card"]').length === 3);
  page.once("dialog", (d) => d.accept());
  await page.locator('[data-testid="briefing-card"]').nth(2).locator('[data-testid="briefing-card-delete"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="briefing-card"]').length === 2);
  assert.equal((await list()).length, 2);

  // Deep link straight to the surface.
  await page.goto(`${base}/#briefing`);
  await page.locator('[data-testid="briefing-surface-root"] [data-testid="briefing-card"]').first().waitFor({ timeout: 15000 });
  await page.close();
});
