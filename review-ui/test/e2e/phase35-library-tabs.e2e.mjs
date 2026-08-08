// Phase 35 task 35.0 -- QE-first e2e contract, part 1: Library tab shell +
// Bestiary + Hero's Hall. Read phase35-fixture.mjs FIRST (§10 UI/DOM
// contract this file locks in). Authored QE-first: every test below is RED
// against today's build (35.2 is what turns it green).
//
// EXPECTED-RED reasons (confirmed by direct read of app-shell.js before
// writing these): `[data-testid="library-surface-root"]` today is Phase 34's
// generic placeholder scaffold (`renderScaffoldSurface`, `SCAFFOLD_COPY.
// library`) -- it has NO `library-tabs`/`library-bestiary-root`/
// `library-hall-root`/creature-card/hero-card DOM of any kind (confirmed by
// grep: none of this file's testids appear anywhere in review-ui/public/).
// Every Playwright locator below is therefore a genuine selector-not-found/
// timeout, not a flake.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  writeFoundryIndexFixture,
  pullActorsViaRoute,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p35tabs-");
const WORLD = "e2e-p35-library-tabs";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
const { acceptPartyMember } = await import("../../../combat-planning/party-roster-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
writeFoundryIndexFixture(dataDir, WORLD);

let server, base, browser, pullResult;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  // Real pull via the REUSED, already-shipped route (phase35-fixture.mjs
  // §9) -- populates real bestiary/party-roster proposed candidates from
  // this file's own mock dnd5e-2014 index. Accept two of them for real
  // (Ogrekin Skirmisher + Kestrel Windrider) so the Library tabs have a mix
  // of proposed AND accepted content to render, matching how a real GM's
  // library actually looks after a first pull + a partial review pass.
  pullResult = await pullActorsViaRoute(base, WORLD);
  assert.equal(pullResult.bestiaryProposed.length, 2, "both monsters (Ogrekin Skirmisher CR5, Frostmaw the Undying CR12 legendary) must land as bestiary proposals");
  assert.equal(pullResult.partyProposed.length, 1, "Kestrel Windrider (the PC) must land as one party-roster proposal");

  const ogrekin = pullResult.bestiaryProposed.find((e) => e.rawFields.name === "Ogrekin Skirmisher");
  acceptBestiaryEntry(ogrekin.id);
  const kestrel = pullResult.partyProposed[0];
  acceptPartyMember(WORLD, kestrel.id);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// 1. LIBRARY TABS RENDER WITH COUNTS
// ---------------------------------------------------------------------------
test("Library renders 4 tabs (Bestiary / Hero's Hall / Reliquary / Stagecraft) each with a real mono count, bare #library defaults to Bestiary active", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-tabs"]').waitFor({ state: "visible", timeout: 15000 });

  const tabs = ["bestiary", "hall", "reliquary", "stagecraft"];
  for (const tab of tabs) {
    const row = page.locator(`[data-testid="library-tab"][data-tab="${tab}"]`);
    await row.waitFor({ state: "visible", timeout: 10000 });
    const countText = await row.locator('[data-testid="library-tab-count"]').textContent();
    assert.match(countText ?? "", /\d+/, `${tab} tab must show a real numeric count, got "${countText}"`);
  }

  assert.equal(
    await page.getAttribute('[data-testid="library-tab"][data-tab="bestiary"]', "data-active"),
    "true",
    "bare #library must default to the Bestiary tab active"
  );
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 10000 });

  // Bestiary's own count reflects BOTH proposed and accepted entries pulled
  // in before() -- 2 monsters total (1 accepted, 1 still proposed).
  const bestiaryCount = await page.locator('[data-testid="library-tab"][data-tab="bestiary"] [data-testid="library-tab-count"]').textContent();
  assert.match(bestiaryCount ?? "", /2/, `Bestiary tab count must reflect the 2 pulled monsters, got "${bestiaryCount}"`);

  await page.close();
});

test("clicking the Hall tab navigates to #library/hall and swaps the active surface (deep-link the reverse direction too)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-tabs"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="library-tab"][data-tab="hall"]').click();
  await page.waitForFunction(() => location.hash === "#library/hall", null, { timeout: 8000 });
  await page.locator('[data-testid="library-hall-root"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="library-bestiary-root"]').count(), 0, "Bestiary root must be gone once Hall is active");

  // Deep link, no prior click.
  const page2 = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page2, base, WORLD);
  await page2.goto(`${base}/#library/reliquary`);
  await page2.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(
    await page2.getAttribute('[data-testid="library-tab"][data-tab="reliquary"]', "data-active"),
    "true"
  );
  await page.close();
  await page2.close();
});

// ---------------------------------------------------------------------------
// 2. BESTIARY -- habitat tree + creature card + stat rail + rating stepper + note + source pills
// ---------------------------------------------------------------------------
test("Bestiary: habitat tree renders the fixed all/unplaced buckets, creature cards show name/rating/source pill, selecting one opens the stat rail", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });

  await page.locator('[data-testid="library-habitat-tree"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="library-habitat-row"][data-habitat-id="all"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="library-habitat-row"][data-habitat-id="unplaced"]').waitFor({ state: "visible", timeout: 5000 });

  const cards = page.locator('[data-testid="library-creature-card"]');
  assert.equal(await cards.count(), 2, "both pulled monsters must render as creature cards under the default (all) habitat");

  const ogrekinCard = page.locator('[data-testid="library-creature-card"]').filter({ hasText: "Ogrekin Skirmisher" });
  await ogrekinCard.locator('[data-testid="library-creature-card-name"]').waitFor({ state: "visible", timeout: 5000 });
  const rating = await ogrekinCard.locator('[data-testid="library-creature-card-rating"]').textContent();
  assert.match(rating ?? "", /5/, `Ogrekin Skirmisher's card rating must show its real CR (5), got "${rating}"`);
  const sourcePill = await ogrekinCard.locator('[data-testid="library-creature-card-source"]').textContent();
  assert.match((sourcePill ?? "").toLowerCase(), /foundry/, `a Foundry-pulled entry's source pill must read "foundry", got "${sourcePill}"`);

  await ogrekinCard.click();
  const rail = page.locator('[data-testid="library-stat-rail"]');
  await rail.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await rail.getAttribute("data-entry-id"), await ogrekinCard.getAttribute("data-entry-id"));

  await page.close();
});

test("Bestiary stat rail: rating stepper up/down and the GM note persist across a reload", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const ogrekinCard = page.locator('[data-testid="library-creature-card"]').filter({ hasText: "Ogrekin Skirmisher" });
  await ogrekinCard.click();
  await page.locator('[data-testid="library-stat-rail"]').waitFor({ state: "visible", timeout: 10000 });

  const before = await page.locator('[data-testid="library-rating-stepper-value"]').textContent();
  await page.locator('[data-testid="library-rating-stepper-up"]').click();
  await page.waitForFunction(
    (prev) => document.querySelector('[data-testid="library-rating-stepper-value"]')?.textContent !== prev,
    before,
    { timeout: 8000 }
  );

  const note = page.locator('[data-testid="library-gm-note"]');
  await note.click();
  await note.fill("Reskin as a causeway blockade sergeant next time.");
  await note.evaluate((el) => el.blur());

  await page.reload();
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  const reopenedCard = page.locator('[data-testid="library-creature-card"]').filter({ hasText: "Ogrekin Skirmisher" });
  await reopenedCard.click();
  await page.locator('[data-testid="library-stat-rail"]').waitFor({ state: "visible", timeout: 10000 });
  const noteAfterReload = await page.locator('[data-testid="library-gm-note"]').textContent();
  assert.match(noteAfterReload ?? "", /causeway blockade sergeant/, "the GM note must survive a reload (real persistence, not client-only state)");

  await page.close();
});

// ---------------------------------------------------------------------------
// 3. HERO'S HALL -- hero cards, ONE-CLICK always-visible conditions, resources, expertise marker
// ---------------------------------------------------------------------------
test("Hero's Hall: hero card renders with an ALWAYS-VISIBLE (no extra disclosure click) conditions toggle, resources, and an expertise marker on a proficient-2 skill", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/hall`);
  await page.locator('[data-testid="library-hall-root"]').waitFor({ state: "visible", timeout: 15000 });

  const card = page.locator('[data-testid="library-hero-card"]').filter({ hasText: "Kestrel Windrider" });
  await card.waitFor({ state: "visible", timeout: 10000 });

  // The whole point of the locked decision: conditions must be visible and
  // interactable WITHOUT any prior "show details" click -- assert it is
  // already visible the instant the card itself is visible.
  const conditionsToggle = card.locator('[data-testid="library-hero-conditions-toggle"]');
  await conditionsToggle.waitFor({ state: "visible", timeout: 3000 });

  await card.locator('[data-testid="library-hero-resources"]').waitFor({ state: "visible", timeout: 5000 });

  // Kestrel's fixture skills have TWO proficient-2 (expertise) entries
  // (Perception, Survival per the mapper's own proficient===2 filter) --
  // at least one expertise marker must render.
  const expertiseMarkers = card.locator('[data-testid="library-hero-expertise-marker"]');
  assert.ok(await expertiseMarkers.count() >= 1, "at least one expertise (✦) marker must render for Kestrel's proficient-2 skills");

  await page.close();
});

test("Hero's Hall: clicking the conditions toggle edits it in place with no navigation and the change persists", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/hall`);
  await page.locator('[data-testid="library-hall-root"]').waitFor({ state: "visible", timeout: 15000 });

  const card = page.locator('[data-testid="library-hero-card"]').filter({ hasText: "Kestrel Windrider" });
  const toggle = card.locator('[data-testid="library-hero-conditions-toggle"]');
  await toggle.click();
  await toggle.fill("one level of exhaustion");
  await toggle.evaluate((el) => el.blur());

  await page.reload();
  await page.locator('[data-testid="library-hall-root"]').waitFor({ state: "visible", timeout: 15000 });
  const reopenedCard = page.locator('[data-testid="library-hero-card"]').filter({ hasText: "Kestrel Windrider" });
  const textAfterReload = await reopenedCard.locator('[data-testid="library-hero-conditions-toggle"]').textContent();
  assert.match(textAfterReload ?? "", /exhaustion/, "conditions edit must persist across a reload");

  await page.close();
});
