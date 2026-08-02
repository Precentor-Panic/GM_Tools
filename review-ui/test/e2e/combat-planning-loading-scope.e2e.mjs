// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 10: "The two LLM call sites, and only
// those two, show any loading affordance." EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- see
// combat-planning-live-recompute.e2e.mjs's header for the full shared DOM
// contract.
//
// Direct test of plans/phase-19-review.md §2's own explicit, load-bearing
// claim: "Everything else described in §1... is deterministic, local, and
// instant... only the ingestion screen and the optional theme box need any
// 'still working' / latency affordance... the rest of the builder should
// never show a loading state at all."
//
// ---------------------------------------------------------------------------
// "STILL WORKING" AFFORDANCE CONTRACT (graph-view.js's `withSlowNotice`
// pattern -- fires a status message ~1500ms into an in-flight request, see
// that file's own function for the exact timing):
// ---------------------------------------------------------------------------
//   - `[data-testid="still-working-indicator"]` -- rendered ONLY inside
//     `[data-testid="ingest-status"]` (the bestiary/party-roster ingest
//     submit action, task 19.1) and `[data-testid="theme-box-status"]` (the
//     theme-box submit action, task 19.5's `[data-testid="theme-text-input"]`
//     / `[data-testid="theme-submit-btn"]`) -- NEVER anywhere else in
//     `#view-combat-planning`.
//
// ---------------------------------------------------------------------------
// WHY EVERY NON-LLM INTERACTION BELOW IS ROUTE-INTERCEPTED AND ARTIFICIALLY
// DELAYED (not just clicked-and-immediately-checked):
// ---------------------------------------------------------------------------
// A trivial "no loading indicator appeared" assertion against an
// instantaneous local response would pass even if the implementation
// technically wired up a withSlowNotice-style timer that just never got the
// chance to fire -- that would NOT actually prove "the rest of the builder
// should never show a loading state AT ALL" (the design record's own
// wording), only "usually resolves fast enough that it doesn't matter."
// This file uses Playwright's page.route() to hold each of the four
// non-LLM-triggering requests in flight for LONGER than withSlowNotice's own
// ~1500ms threshold (via route.continue() after an artificial delay, never
// route.fulfill() -- these ARE real, deterministic, non-LLM requests against
// the real server per this suite's own themeText-blank contract, so letting
// them actually complete for real is both possible and correct, unlike the
// two genuinely LLM-backed requests below) before checking, DURING the
// delay window, that no loading indicator ever appeared anywhere in the
// view -- a real, non-trivial test of the "never, regardless of latency"
// claim.
//
// The two genuinely LLM-backed requests (ingest submit, non-blank
// theme-box submit) are FULLY MOCKED via route.fulfill() with an artificial
// delay -- this environment has no ANTHROPIC_API_KEY (see
// combat-planning-fixture.mjs's header for the full grounding), so this is
// the only way to exercise these two submit actions' loading affordance at
// all without live credentials, matching this project's established "unit
// test with the API call mocked" convention one layer up, at the HTTP
// boundary instead of the opts.client boundary (server.mjs has no
// opts.client injection hook of its own, see the fixture file's header).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupScratchEnv,
  cleanupScratchEnv,
  DESKTOP_VIEWPORT,
  primeWorldSelection,
  seedAcceptedBestiaryEntry,
  seedPartyMember,
  fullProfileRawFields
} from "./combat-planning-fixture.mjs";

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-loadscope-");
const WORLD = "e2e-cp-loadscope-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let catalogEntry, catalogAddEntry, member;

// Comfortably longer than withSlowNotice's own ~1500ms threshold.
const HOLD_MS = 2200;
const POLL_INTERVAL_MS = 150;

before(async () => {
  catalogEntry = await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Loading Scope Goblin" }) });
  // Task 20.4 gave the catalog row a binary Add/Remove toggle -- an entry
  // already present in the working roster (any origin) shows "Remove", not
  // "+Add". The "medium"-tier difficulty click below auto-picks catalogEntry
  // itself (confirmed directly: with only one light candidate available,
  // the greedy auto-fill happily takes 3 copies of it to reach target 16),
  // which would leave catalogEntry's OWN catalog row already showing
  // "Remove" by the time the "catalog add" step runs. A second, much
  // heavier entry the medium-tier auto-fill will never select (confirmed
  // directly: it's excluded from that same combination) keeps the "catalog
  // add" step targeting a row that's genuinely still in its "+Add" state.
  catalogAddEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Loading Scope Dragon", type: "dragon", challengeRating: "15", hp: 250, ac: 19, attacks: [{ name: "Bite", toHitBonus: 14, damageDice: "4d10+8", damageType: "slashing" }] })
  });
  member = await seedPartyMember(WORLD, { name: "Loading Scope PC", combatRelevant: { class: "Fighter", level: 5, ac: 16, hp: 40, damagePerRoundEstimate: 16 } });

  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

/** Polls repeatedly during a delay window, asserting the indicator never appears even transiently. */
async function assertIndicatorNeverAppearsFor(pg, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const count = await pg.locator('[data-testid="still-working-indicator"]').count();
    assert.equal(count, 0, `[still-working-indicator] must never appear anywhere in the view during "${label}" -- it is not one of the two LLM call sites`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

test("difficulty-click, catalog add/remove, knob change, and attendance toggle NEVER show the loading indicator, even when artificially delayed past the withSlowNotice threshold", async () => {
  await primeWorldSelection(page, base, WORLD);

  // Hold EVERY encounter-suggest request in flight for HOLD_MS before
  // letting it continue to the real server -- these are all themeText-blank
  // (per this suite's own contract), genuinely non-LLM, so letting them
  // actually complete afterward is correct, not just tolerated.
  await page.route("**/api/combat-planning/encounter-suggest", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });

  await page.goto(`${base}/#combat-planning`);
  await page.locator('[data-testid="score-band"]').waitFor({ state: "visible", timeout: 5000 });

  // --- difficulty click ---
  const difficultyClickDone = page.locator('[data-testid="difficulty-tier"][data-tier="medium"]').click();
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "difficulty-tier click");
  await difficultyClickDone;
  await page.locator('[data-testid="expected-score-value"]').waitFor({ state: "visible", timeout: 5000 });

  // --- catalog add --- (catalogAddEntry, NOT catalogEntry -- see the
  // fixture-setup comment above for why catalogEntry itself is already
  // "Remove"-state by this point)
  const catalogRow = page.locator(`[data-testid="catalog-row"][data-entry-id="${catalogAddEntry.id}"]`);
  await catalogRow.waitFor({ state: "visible", timeout: 5000 });
  const addClickDone = catalogRow.locator('[data-testid="catalog-add-btn"]').click();
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "catalog +Add click");
  await addClickDone;

  // --- knob change ---
  await page.locator('[data-testid="adjust-panel-toggle"]').click();
  const scalingKnob = page.locator('[data-testid="knob-scaling-slider"]');
  await scalingKnob.waitFor({ state: "visible", timeout: 5000 });
  const knobChangeDone = scalingKnob.fill("1.5");
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "Adjust-panel knob change");
  await knobChangeDone;

  // --- attendance toggle ---
  const checkbox = page.locator(`[data-testid="roster-chip"][data-member-id="${member.id}"] [data-testid="roster-chip-checkbox"]`);
  const toggleDone = checkbox.uncheck();
  await assertIndicatorNeverAppearsFor(page, HOLD_MS, "roster attendance toggle");
  await toggleDone;

  await page.unroute("**/api/combat-planning/encounter-suggest");
});

test("ingestion submit shows the loading indicator (LLM call site #1, fully mocked -- no live API key needed)", async () => {
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const p = await context.newPage();
  await primeWorldSelection(p, base, WORLD);

  await p.route("**/api/combat-planning/bestiary/ingest", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entry: {
          id: "loading-scope-fake-entry",
          rawFields: { name: "Loading Scope Fixture Monster", type: "beast", hp: 10, ac: 12, attacks: [] },
          derivedScore: null,
          needsConfirmation: false,
          outlierReasons: [],
          status: "proposed",
          createdAt: new Date().toISOString()
        }
      })
    });
  });

  await p.goto(`${base}/#combat-planning-ingest/bestiary`);
  const textInput = p.locator('[data-testid="ingest-text-input"]');
  await textInput.waitFor({ state: "visible", timeout: 15000 });
  await textInput.fill("Loading Scope Fixture Monster\nHP 10, AC 12");

  const submitPromise = p.locator('[data-testid="ingest-submit-btn"]').click();

  await assert.doesNotReject(async () => {
    await p.locator('[data-testid="ingest-status"] [data-testid="still-working-indicator"]').waitFor({ state: "visible", timeout: HOLD_MS + 3000 });
  }, "the still-working-indicator must appear inside ingest-status while the (mocked, artificially-delayed) bestiary ingest request is in flight");

  await submitPromise;
  await context.close();
});

test("theme-box submit shows the loading indicator (LLM call site #2, fully mocked -- no live API key needed)", async () => {
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const p = await context.newPage();
  await primeWorldSelection(p, base, WORLD);

  // Only intercept+fulfill the THEMED call (a request body carrying a
  // non-empty themeText) -- anything else hitting this route (there should
  // be none in this test, since it never clicks a difficulty tier first)
  // falls through to route.continue() so this test fails loudly rather than
  // silently if the implementation calls encounter-suggest at some
  // unexpected other point.
  await p.route("**/api/combat-planning/encounter-suggest", async (route) => {
    const body = route.request().postDataJSON();
    if (!body?.themeText || !body.themeText.trim()) {
      return route.continue();
    }
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestion: {
          combination: [],
          expectedScore: 5,
          burstCeiling: 0,
          snowballDelta: { topDamageContributorId: "x", topDamageContributorDelta: 0, topEffectiveHpContributorId: "x", topEffectiveHpContributorDelta: 0 },
          asymmetricRiskFlag: false
        }
      })
    });
  });

  await p.goto(`${base}/#combat-planning`);
  const themeInput = p.locator('[data-testid="theme-text-input"]');
  await themeInput.waitFor({ state: "visible", timeout: 15000 });
  await themeInput.fill("undead crypt");

  const submitPromise = p.locator('[data-testid="theme-submit-btn"]').click();

  await assert.doesNotReject(async () => {
    await p.locator('[data-testid="theme-box-status"] [data-testid="still-working-indicator"]').waitFor({ state: "visible", timeout: HOLD_MS + 3000 });
  }, "the still-working-indicator must appear inside theme-box-status while the (mocked, artificially-delayed) themed encounter-suggest request is in flight");

  await submitPromise;
  await context.close();
});
