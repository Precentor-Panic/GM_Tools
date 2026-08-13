// QA fix-wave W1, Fix 4: accepting a "✦ develop this place" offline
// suggestion used to write the disclaimer boilerplate ("(Offline pass — no
// model configured…) … set ANTHROPIC_API_KEY…") into the entity's REAL
// description. This suite proves the fix end to end, unmocked, against the
// REAL offline-degrade route (this process never sets ANTHROPIC_API_KEY,
// matching this project's standing "no live API calls in tests" rule --
// this environment IS the keyless default the fix targets) -- a keyless
// develop-place accept must result in a description containing the GM's
// own vision-derived text, and must NOT contain "Offline pass" or
// "ANTHROPIC_API_KEY" anywhere.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupScratchEnv, cleanupScratchEnv, DESKTOP_VIEWPORT } from "./fixture.mjs";

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-qa-w1-fix4-develop-place-");
const WORLD = "e2e-qa-w1-fix4-develop-place-world";
process.env.WF_DEFAULT_WORLD = WORLD;
delete process.env.ANTHROPIC_API_KEY;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "fix4-place", name: "The Hollow Bell Tower", type: "place", importance: 0.5 } }
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

async function primeWorldSelection(page) {
  await page.goto(`${base}/#graph`);
  await page.evaluate((w) => localStorage.setItem("gmReview.world", w), WORLD);
}

test("keyless: accepting a real (unmocked) offline develop-place suggestion persists a clean description -- no disclaimer text, and a visible offline chrome note on the card", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page);
  await page.goto(`${base}/#world/fix4-place`);

  const detail = page.locator('[data-testid="world-detail"][data-entity-id="fix4-place"]');
  await detail.waitFor({ state: "visible", timeout: 15000 });

  await detail.locator('[data-testid="wv-develop-place-link"]').click();
  const input = detail.locator('[data-testid="wv-develop-place-input"]');
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill("the bell has not rung in years, but the rope still sways");
  await detail.locator('[data-testid="wv-develop-place-go-btn"]').click();

  const suggestionCard = detail.locator('[data-testid="wv-develop-place-suggestion"]');
  await suggestionCard.waitFor({ state: "visible", timeout: 10000 });

  // The offline note is real, visible CHROME -- proves the route really did
  // degrade offline (not silently mocked/skipped) and that the frontend
  // renders the disclaimer OUTSIDE the suggestion text.
  await suggestionCard.locator('[data-testid="wv-develop-place-offline-note"]').waitFor({ state: "visible", timeout: 5000 });

  const suggestionText = await suggestionCard.locator(".wv-develop-place-suggestion-text").textContent();
  assert.doesNotMatch(suggestionText, /Offline pass/i, "the suggestion BODY itself must never carry the disclaimer");
  assert.doesNotMatch(suggestionText, /ANTHROPIC_API_KEY/, "the suggestion BODY itself must never instruct the GM to configure anything");
  assert.match(suggestionText, /bell has not rung|rope still sways/i, "the body must be usable-as-is, derived from the GM's own vision line");

  await suggestionCard.locator('[data-testid="wv-develop-place-accept-btn"]').click();
  await page.waitForTimeout(400);

  const graph = await page.evaluate(async ({ base, world }) => {
    const res = await fetch(`${base}/api/graph?world=${encodeURIComponent(world)}&filter=all`);
    return res.json();
  }, { base, world: WORLD });
  const persisted = graph.nodes.find((n) => n.id === "fix4-place");
  assert.ok(persisted.description, "the description must actually have been persisted");
  assert.doesNotMatch(persisted.description, /Offline pass/i, "the PERSISTED description must never contain the disclaimer verbatim");
  assert.doesNotMatch(persisted.description, /ANTHROPIC_API_KEY/, "the PERSISTED description must never instruct the GM to configure anything");
  assert.match(persisted.description, /bell has not rung|rope still sways/i, "the persisted description must contain the GM's own vision-derived text");

  await page.close();
});
