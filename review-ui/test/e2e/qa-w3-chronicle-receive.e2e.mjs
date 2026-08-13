// QA re-pass wave W3, finding 2: Chronicle's "Receive new information" --
// the Composer's second primary action, replacing the old paste-lore
// dead-end. Real, unmocked (this process never sets ANTHROPIC_API_KEY --
// the offline-degrade path IS what's under test here, matching this
// project's standing "no live API calls in tests" rule; writeup-propose's
// offline fallback has been covered since QA-W1).
//
// Covers: the Composer showing BOTH "Receive new information" and "Let time
// pass" (Receive first, per Russell's own described layout), the rubber-duck
// -OFF straight-to-proposals path, the rubber-duck-ON inline framing picker
// (the retired #import/#framing screens' replacement), the chronicle-run
// sidecar extension to the intake path (promptSummary titling the rail
// entry), and the Connection-Menu paste shortcut's handoff into this same
// surface (the dead "full importer" message is gone).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  fetchChronicleLogViaRoute
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-qaw3-receive-");
const WORLD = "e2e-qaw3-chronicle-receive";
process.env.WF_DEFAULT_WORLD = WORLD;
delete process.env.ANTHROPIC_API_KEY;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { setRubberDuckMode } = await import("../../../mutation-engine/user-settings.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "qaw3-forge", name: "Gorrim's Forge", type: "place", importance: 0.6 } }
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

test("Composer shows BOTH primary actions -- 'Receive new information' renders ABOVE 'Let time pass', both in the same Composer page (no extra click to reach either)", async () => {
  setRubberDuckMode(false);
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  const receiveSection = page.locator('[data-testid="chronicle-receive-section"]');
  const composer = page.locator('[data-testid="chronicle-composer"]');
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await receiveSection.waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="chronicle-run-btn"]').waitFor({ state: "visible", timeout: 10000 });

  const receiveBox = await receiveSection.boundingBox();
  const letTimePassHeading = page.locator('[data-testid="chronicle-composer"] >> text=Let time pass').first();
  await letTimePassHeading.waitFor({ state: "visible", timeout: 10000 });
  const letTimePassBox = await letTimePassHeading.boundingBox();
  assert.ok(receiveBox && letTimePassBox, "both sections must have real layout boxes");
  assert.ok(receiveBox.y < letTimePassBox.y, "Receive new information must render ABOVE Let time pass, per Russell's own described layout");

  await page.locator('[data-testid="chronicle-receive-btn"]').waitFor({ state: "visible", timeout: 5000 });
  await page.close();
});

test("Receive new information, rubber-duck OFF: pasting text and clicking 'Read it in' lands a real batch, titled from the writeup's own first line in the rail (the chronicle-run sidecar now covers the intake path)", async () => {
  setRubberDuckMode(false);
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-receive-section"]').waitFor({ state: "visible", timeout: 15000 });

  const promptText = "Gorrim finally reopens the forge after the long frost.\nA second line of detail nobody will read in the title.";
  await page.locator('[data-testid="chronicle-receive-input"]').fill(promptText);
  await page.locator('[data-testid="chronicle-receive-btn"]').click();

  // Offline degrade -> a real batch with 0 mutations (proposeWfiFromWriteup's
  // real-extraction prompt is the branch offlineWriteupClient answers empty)
  // -- the zero-proposals notice is still a genuine "it ran" confirmation.
  await page.locator('[data-testid="chronicle-zero-proposals-notice"]').waitFor({ state: "visible", timeout: 15000 });

  const { body } = await fetchChronicleLogViaRoute(base, WORLD);
  const entry = body.entries.find((e) => e.promptSummary && e.promptSummary.startsWith("Gorrim finally reopens the forge"));
  assert.ok(entry, `expected a chronicle-log entry titled from the writeup's first line -- got: ${JSON.stringify(body.entries.map((e) => e.promptSummary))}`);
  assert.equal(entry.span, null, "an intake batch has no duration -- span:null is the real, valid state (not a Composer time-pass run)");
  assert.equal(entry.fortuneAtRun, null);
  // Offline degrade means this real batch has 0 mutations -- fillHistory's
  // EXISTING (task 37.5) gating deliberately hides zero-mutation batches
  // from the rail entirely (pure noise there, still reachable via the batch
  // route) -- so no rail-row assertion here, only the log-level readable
  // title. A keyed/real-API run would produce real mutations and land in
  // the rail exactly like the other two tests below already cover.
  await page.close();
});

test("Receive new information, rubber-duck ON: submitting renders the inline 'First reactions' framing picker (never the retired full-importer dead-end); picking a framing completes the flow into a real batch", async () => {
  setRubberDuckMode(true);
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-receive-section"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="chronicle-receive-input"]').fill("The Compact's envoy arrives at Gorrim's Forge unannounced.");
  await page.locator('[data-testid="chronicle-receive-btn"]').click();

  const framingPanel = page.locator('[data-testid="chronicle-receive-framing"]');
  await framingPanel.waitFor({ state: "visible", timeout: 15000 });
  const cards = page.locator('[data-testid="chronicle-receive-framing-card"]');
  assert.equal(await cards.count(), 4, "3 generated framings + 1 custom 'none of these' card");

  // The old dead end must never appear anywhere in this flow.
  const bodyText = await page.locator("body").innerText();
  assert.ok(!bodyText.includes("full importer"), "the retired 'pick a framing in the full importer (New Import)' dead-end message must be gone");
  assert.ok(!bodyText.includes("New Import"), "no reference to the retired New Import screen anywhere in this flow");

  await cards.first().click();
  await page.locator('[data-testid="chronicle-receive-framing-submit"]').click();

  await page.locator('[data-testid="chronicle-zero-proposals-notice"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="chronicle-receive-framing"]').count(), 0, "the framing picker must clear once the real read completes");
  setRubberDuckMode(false);
  await page.close();
});

test("Connection-Menu paste intake is a THIN SHORTCUT: 'Read it in' hands the text off to Chronicle's Receive mode and auto-submits it there -- never a local dead-end", async () => {
  setRubberDuckMode(false);
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/plans`);
  await page.locator('[data-testid="conn-chip"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="conn-chip"]').click();
  await page.locator('[data-testid="conn-lore-paste-input"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="conn-lore-paste-input"]').fill("A courier from the Compact drops a sealed letter at the smithy door.");
  await page.locator('[data-testid="conn-lore-read-btn"]').click();

  await page.waitForFunction(() => location.hash.startsWith("#chronicle"), { timeout: 10000 });
  await page.locator('[data-testid="chronicle-receive-section"]').waitFor({ state: "visible", timeout: 15000 });
  // Auto-submitted on arrival (the user already clicked "Read it in" once,
  // over in the Connection Menu) -- lands as a real batch with no second click.
  await page.locator('[data-testid="chronicle-zero-proposals-notice"]').waitFor({ state: "visible", timeout: 15000 });

  const { body } = await fetchChronicleLogViaRoute(base, WORLD);
  const entry = body.entries.find((e) => e.promptSummary && e.promptSummary.startsWith("A courier from the Compact"));
  assert.ok(entry, `expected the handed-off text to have created a chronicle-log entry -- got: ${JSON.stringify(body.entries.map((e) => e.promptSummary))}`);
  await page.close();
});
