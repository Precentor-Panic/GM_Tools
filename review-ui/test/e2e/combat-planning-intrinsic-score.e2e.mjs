// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 4: "Catalog score chips are
// intrinsic, never party-relative." EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- see
// combat-planning-live-recompute.e2e.mjs's header for the full shared DOM
// contract, and combat-planning-confidence-format.e2e.mjs's header for the
// `catalog-score-chip`/`catalog-score-value` contract this file reuses.
//
// Direct test of plans/phase-19-review.md §1's explicitly-resolved
// West-Marches-DM tension: "the catalog's per-row score chip
// (computeActionEconomyScore's output, plus the impact fingerprint) is a
// property of the monster alone -- it is never computed against any party
// and carries no such assumption to hide. Party-relative numbers
// (expectedScore, snowball delta) only ever appear once something is
// actually in the working roster." This test toggles roster attendance
// (which per combat-planning-live-recompute.e2e.mjs's own contract DOES
// change the score BAND's party-relative snowball figures) and asserts the
// CATALOG row's own score-value text is byte-identical before and after --
// proving the two kinds of number are genuinely, structurally independent,
// not just visually separated by coincidence.
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
  fullProfileRawFields,
  SOLID_DERIVED_SCORE
} from "./combat-planning-fixture.mjs";

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-intrinsic-");
const WORLD = "e2e-cp-intrinsic-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let bestiaryEntry, memberA, memberB;

before(async () => {
  bestiaryEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Intrinsic Score Goblin" }),
    derivedScore: SOLID_DERIVED_SCORE
  });
  memberA = await seedPartyMember(WORLD, { name: "Intrinsic PC A", combatRelevant: { class: "Fighter", level: 4, ac: 16, hp: 38, attackBonus: 6, damagePerRoundEstimate: 18 } });
  memberB = await seedPartyMember(WORLD, { name: "Intrinsic PC B", combatRelevant: { class: "Cleric", level: 4, ac: 15, hp: 34, attackBonus: 5, damagePerRoundEstimate: 8 } });

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

test("toggling roster attendance never changes a catalog row's own score chip", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const scoreValueEl = page.locator(
    `[data-testid="catalog-row"][data-entry-id="${bestiaryEntry.id}"] [data-testid="catalog-score-value"]`
  );
  await scoreValueEl.waitFor({ state: "visible", timeout: 15000 });
  const scoreBeforeToggle = (await scoreValueEl.textContent()).trim();
  assert.ok(scoreBeforeToggle.includes("14.2"), `sanity: fixture's known solid score value must render before any toggle; got "${scoreBeforeToggle}"`);

  // Prove the toggle genuinely reaches the server/recompute machinery at
  // all (otherwise "the catalog score didn't change" would be trivially,
  // uninterestingly true because nothing happened) -- establish a
  // suggestion first so a party-relative figure exists to change.
  await page.locator('[data-testid="difficulty-tier"][data-tier="medium"]').click();
  const snowballDamagePill = page.locator('[data-testid="snowball-pill-damage"]');
  await snowballDamagePill.waitFor({ state: "visible", timeout: 10000 });
  const snowballBefore = (await snowballDamagePill.textContent()).trim();

  const memberAChip = page.locator(`[data-testid="roster-chip"][data-member-id="${memberA.id}"]`);
  await memberAChip.locator('[data-testid="roster-chip-checkbox"]').uncheck();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      ({ selector, prev }) => document.querySelector(selector)?.textContent?.trim() !== prev,
      { selector: '[data-testid="snowball-pill-damage"]', prev: snowballBefore },
      { timeout: 10000 }
    );
  }, "setup precondition: unchecking the top-damage party member must genuinely change the party-relative snowball figure -- if this fails, the toggle isn't reaching the recompute machinery at all, which would make this test's main assertion meaningless");

  // THE ACTUAL ASSERTION: the catalog row's own score-value text is
  // byte-identical to before the toggle, proving it never took the roster
  // into account at all.
  const scoreAfterToggle = (await scoreValueEl.textContent()).trim();
  assert.equal(
    scoreAfterToggle,
    scoreBeforeToggle,
    `the catalog row's own score chip must be COMPLETELY UNAFFECTED by roster attendance changes -- it is an intrinsic property of the monster alone, never party-relative; got "${scoreBeforeToggle}" before and "${scoreAfterToggle}" after unchecking a party member (party-relative snowball DID correctly change, proving the toggle itself works)`
  );

  void memberB; // seeded to make this a real >=2-member roster, not a degenerate single-PC one
});
