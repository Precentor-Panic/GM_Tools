// Phase 37 task 37.0 -- QE-first e2e contract, part 3: BROWSER-DRIVEN
// (Playwright), the Chronicle surface's own DOM contract (§8 of
// phase37-fixture.mjs) -- Composer controls including the ONE shared span
// input, the deferred lane, the timeline, and the shared proposal-card
// mounted on "What changed". Read phase37-fixture.mjs §5/§7/§8 FIRST.
//
// EXPECTED-RED reasons (confirmed by direct read of app-shell.js before
// writing these): `[data-testid="chronicle-surface-root"]` exists as a
// PLACEHOLDER ONLY (app-shell.js:938, copy-only, no `renderChronicleSurface`
// call anywhere -- confirmed by grep, only `renderLibrarySurface` is wired)
// -- every `chronicle-*` testid below besides the bare root itself is
// Playwright selector-not-found. `review-ui/public/proposal-card.js` does
// not exist anywhere in the tree (confirmed via `ls`).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-p37surface-");
const WORLD = "e2e-p37-chronicle-surface";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { writePending } = await import("../../../mutation-engine/pending-ledger.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p37s-ring", name: "Sella's brother's ring", type: "object", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "p37s-gorrim", name: "Gorrim the Smith", type: "person", importance: 0.6 } }
]);
writePending(WORLD, "p37s-ring", {
  causeTag: "Player named it, then nobody followed up. Let it move without them.",
  impactScore: 0.5, sourceBatchId: "manual", cycleDescriptor: "Wrap-up · session 11", status: "pending"
});
writePending(WORLD, "p37s-gorrim", {
  causeTag: "Still doesn't know who set the fire. Suspicion should harden or break.",
  impactScore: 0.4, sourceBatchId: "manual", cycleDescriptor: "Wrap-up · session 11", status: "pending"
});

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

test("Chronicle surface renders the deferred lane from the EXISTING pending-ledger, one row per queued intent, checkbox defaults to carried", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  const lane = page.locator('[data-testid="chronicle-deferred-lane"]');
  await lane.waitFor({ state: "visible", timeout: 10000 });

  const ringRow = page.locator('[data-testid="chronicle-intent-row"][data-entity-id="p37s-ring"]');
  const gorrimRow = page.locator('[data-testid="chronicle-intent-row"][data-entity-id="p37s-gorrim"]');
  await ringRow.waitFor({ state: "visible", timeout: 10000 });
  await gorrimRow.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await ringRow.getAttribute("data-carried"), "true", "a freshly-queued intent must default to carried, per the settled 'default scope = queued intents' decision");

  await ringRow.locator("input[type=checkbox]").click();
  assert.equal(await ringRow.getAttribute("data-carried"), "false", "unchecking must be purely local UI state, immediately reflected in data-carried");
});

// Cleanup pin (Russell's Phase-37 pass, 2026-08-11): selecting the branches
// scope with nothing picked used to reach the server and 400 ("requires a
// non-empty branchIds[]"). The Composer must deflect that run client-side:
// one merged "Somewhere in particular…" chip (no duplicate picker toggle),
// and a dimmed Run button + quiet hint until a branch is picked.
test("branches scope with no branch picked DEFLECTS the run with a quiet hint (never the server 400), and exactly ONE 'Somewhere in particular' control exists", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  const somewhereControls = page.locator('text="Somewhere in particular…"');
  assert.equal(await somewhereControls.count(), 1, "the duplicate picker toggle is retired -- ONE chip serves select+open");

  await page.locator('[data-testid="chronicle-scope-chip"][data-scope-kind="branches"]').click();
  const meta = page.locator('[data-testid="chronicle-run-meta"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="chronicle-run-meta"]')?.getAttribute("data-run-blocked") === "true", null, { timeout: 5000 });
  assert.match((await meta.textContent()) ?? "", /pick at least one/, "the hint explains what is missing");

  assert.equal(await page.locator('[data-testid="chronicle-run-btn"]').getAttribute("aria-disabled"), "true", "the Run button reads disabled");
  const failed = [];
  page.on("response", (r) => { if (r.url().includes("/api/chronicle/run") && r.status() >= 400) failed.push(r.status()); });
  // force:true bypasses Playwright's own actionability refusal (aria-disabled)
  // so the JS-side guard is what's actually exercised.
  await page.locator('[data-testid="chronicle-run-btn"]').click({ force: true });
  await page.waitForTimeout(800);
  assert.deepEqual(failed, [], "a blocked run must never reach the server");
  await page.close();
});

test("the Composer has EXACTLY ONE span/duration control, shared byte-identically between Composer and Timeline modes -- no second duration input anywhere in the surface", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="chronicle-composer"]').waitFor({ state: "visible", timeout: 10000 });
  const seasonChip = page.locator('[data-testid="chronicle-span-chip"][data-span-id="season"]');
  await seasonChip.waitFor({ state: "visible", timeout: 5000 });
  await seasonChip.click();

  await page.locator('[data-testid="chronicle-adv-mode-btn"][data-mode="timeline"]').click();
  await page.locator('[data-testid="chronicle-timeline"]').waitFor({ state: "visible", timeout: 10000 });
  const timelineSeasonChip = page.locator('[data-testid="chronicle-span-chip"][data-span-id="season"]');
  await timelineSeasonChip.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    await timelineSeasonChip.getAttribute("aria-pressed"),
    "true",
    "the span picked in Composer mode must still read as selected (aria-pressed=true) after switching to Timeline mode -- one shared state, not two independent controls"
  );
  const timelineWeekChip = page.locator('[data-testid="chronicle-span-chip"][data-span-id="week"]');
  assert.equal(
    await timelineWeekChip.getAttribute("aria-pressed"),
    "false",
    "only the ONE actually-picked span may read as selected -- every other chip must be aria-pressed=false"
  );

  // Structural single-source guard: no numeric override input anywhere in
  // the whole Chronicle surface (the span is chip-based, per the prototype
  // -- a raw number field would be a second, independently-typeable
  // duration input, exactly what §2's single-source rule forbids).
  const numericInputs = await page.locator('[data-testid="chronicle-surface-root"] input[type="number"]').count();
  assert.equal(numericInputs, 0, "no numeric duration/elapsedSessions override input may exist anywhere in the Chronicle surface");
});

test("the fortune track renders all 5 stops in both Composer and Timeline modes", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="chronicle-fortune-track"]').waitFor({ state: "visible", timeout: 10000 });
  const stopCount = await page.locator('[data-testid="chronicle-fortune-stop"]').count();
  assert.equal(stopCount, 5, `expected 5 fortune stops, got ${stopCount}`);

  await page.locator('[data-testid="chronicle-adv-mode-btn"][data-mode="timeline"]').click();
  await page.locator('[data-testid="chronicle-timeline"]').waitFor({ state: "visible", timeout: 10000 });
  const stopCountTimeline = await page.locator('[data-testid="chronicle-fortune-stop"]').count();
  assert.equal(stopCountTimeline, 5, "the fortune track renders identically in Timeline mode -- one component, two hosts");
});

test("running the Composer produces proposals rendered as the SHARED proposal-card component (data-type/data-risk present), and the history rail gains a matching entry", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="chronicle-scope-chip"][data-scope-kind="queued-intents"]').click();
  await page.locator('[data-testid="chronicle-span-chip"][data-span-id="week"]').click();
  await page.locator('[data-testid="chronicle-run-btn"]').click();

  const proposals = page.locator('[data-testid="chronicle-proposals"]');
  await proposals.waitFor({ state: "visible", timeout: 20000 });
  const card = page.locator('[data-testid="proposal-card"]').first();
  await card.waitFor({ state: "visible", timeout: 10000 });
  const risk = await card.getAttribute("data-risk");
  const type = await card.getAttribute("data-type");
  assert.ok(["safe", "look", "contradict"].includes(risk), `data-risk must be one of the 3 triage buckets, got "${risk}"`);
  assert.ok(typeof type === "string" && type.length > 0, "data-type must be a real entity type, not empty");

  const historyEntry = page.locator('[data-testid="chronicle-history-entry"]').first();
  await historyEntry.waitFor({ state: "visible", timeout: 10000 });
});
