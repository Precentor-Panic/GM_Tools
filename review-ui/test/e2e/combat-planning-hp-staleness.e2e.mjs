// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 8: "HP-staleness visual threshold."
// EXPECTED TO FAIL right now with a Playwright selector-not-found/timeout
// error -- see combat-planning-live-recompute.e2e.mjs's header for the
// shared nav/routing contract.
//
// ---------------------------------------------------------------------------
// HP-STALENESS CONTRACT (task 19.3/19.6, design record §1's round-3
// refinement: "the 'synced Nm ago' indicator on each roster chip must be
// more than a small gray label a DM's eye slides past -- it color-shifts
// (gray -> amber) past a staleness threshold, not relying on the DM to read
// and interpret a timestamp mid-prep." Task 19.6: HP staleness is tracked
// against the WORKING SESSION, not the persisted PartyMember record --
// combat-planning/party-roster-store.mjs's PartyMember has no "last HP
// sync" field of its own (confirmed by reading the module fresh), so the
// reference point this contract specifies is: staleness = now minus
// (a session-local last-resynced-at timestamp, if task 19.6's Resync button
// was ever used THIS session) OR, absent that, the member's own real
// `createdAt` (from savePartyMember, task 18.2) as the natural
// "since-ingested" fallback reference point):
// ---------------------------------------------------------------------------
//   - `[data-testid="roster-chip"][data-member-id="<id>"]` contains
//     `[data-testid="roster-chip-hp-staleness"]`, always present, always
//     with SOME rendered text (e.g. "synced just now" / "synced 2d ago").
//   - STALE_THRESHOLD: this test's fixture seeds one member with a
//     `createdAt` 48 HOURS in the past (via savePartyMember's own
//     injectable `opts.now`, combat-planning-fixture.mjs's
//     `seedPartyMember(world, fields, {now: hoursAgoIso(48)})` -- no real
//     clock mocking needed) and a second member created "now" (no
//     override) -- 48h is comfortably past any reasonable
//     "this campaign session was a while ago" cutoff, so this test asserts
//     the RELATIVE difference between the two rather than pinning an exact
//     threshold constant (a real implementation-time decision this contract
//     deliberately leaves open, matching plans/phase-18-review.md §4's own
//     "real implementation-time decisions, not designed to that level of
//     precision here" precedent for numeric knobs).
//   - The STALE member's `roster-chip-hp-staleness` element carries an
//     ADDITIONAL CSS class (this test asserts BOTH the class-list AND a
//     real computed-style property actually differ between the two chips --
//     task 19.0's own instruction: "confirm via a real class/style
//     assertion, not just checking the timestamp text exists"). The exact
//     class name/color is 19.3's own implementation choice; this test only
//     requires that SOME class present on the stale chip is ABSENT from the
//     fresh chip, AND that `getComputedStyle(...).color` genuinely differs
//     between the two (a real amber-vs-gray visual shift, not merely a
//     class attribute that happens not to be wired to any CSS rule).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupScratchEnv,
  cleanupScratchEnv,
  DESKTOP_VIEWPORT,
  primeWorldSelection,
  seedPartyMember,
  hoursAgoIso
} from "./combat-planning-fixture.mjs";

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-hpstale-");
const WORLD = "e2e-cp-hpstale-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let staleMember, freshMember;

before(async () => {
  staleMember = await seedPartyMember(
    WORLD,
    { name: "HP Staleness Old PC", combatRelevant: { class: "Fighter", level: 5, ac: 17, hp: 40, damagePerRoundEstimate: 15 } },
    { now: hoursAgoIso(48) }
  );
  freshMember = await seedPartyMember(WORLD, { name: "HP Staleness Fresh PC", combatRelevant: { class: "Rogue", level: 5, ac: 15, hp: 32, damagePerRoundEstimate: 18 } });

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

test("a roster chip whose HP was last confirmed 48h ago renders a genuinely different class AND computed style than a freshly-ingested one", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const staleIndicator = page.locator(`[data-testid="roster-chip"][data-member-id="${staleMember.id}"] [data-testid="roster-chip-hp-staleness"]`);
  const freshIndicator = page.locator(`[data-testid="roster-chip"][data-member-id="${freshMember.id}"] [data-testid="roster-chip-hp-staleness"]`);
  await staleIndicator.waitFor({ state: "visible", timeout: 15000 });
  await freshIndicator.waitFor({ state: "visible", timeout: 5000 });

  // Both must render SOME real text (sanity -- not the actual assertion).
  const staleText = (await staleIndicator.textContent()).trim();
  const freshText = (await freshIndicator.textContent()).trim();
  assert.ok(staleText.length > 0 && freshText.length > 0, `both hp-staleness indicators must render real text; got stale="${staleText}" fresh="${freshText}"`);

  // Class assertion: the stale chip must carry at least one class the fresh
  // chip does NOT.
  const staleClasses = new Set(((await staleIndicator.getAttribute("class")) || "").split(/\s+/).filter(Boolean));
  const freshClasses = new Set(((await freshIndicator.getAttribute("class")) || "").split(/\s+/).filter(Boolean));
  const staleOnlyClasses = [...staleClasses].filter((c) => !freshClasses.has(c));
  assert.ok(
    staleOnlyClasses.length > 0,
    `the 48h-stale chip must carry at least one CSS class the freshly-ingested chip does not (a real gray->amber-style threshold shift) -- stale classes: ${JSON.stringify([...staleClasses])}, fresh classes: ${JSON.stringify([...freshClasses])}`
  );

  // Real computed-style assertion (task 19.0's own explicit instruction:
  // "not just checking the timestamp text exists") -- the two indicators'
  // rendered color must genuinely differ, proving the class difference
  // above is actually wired to a visual change, not a dead attribute.
  const [staleColor, freshColor] = await Promise.all([
    staleIndicator.evaluate((el) => getComputedStyle(el).color),
    freshIndicator.evaluate((el) => getComputedStyle(el).color)
  ]);
  assert.notEqual(
    staleColor,
    freshColor,
    `the stale and fresh hp-staleness indicators must render with genuinely DIFFERENT computed color (a real gray->amber visual shift) -- both rendered "${staleColor}", meaning the staleness class exists but has no real visual effect`
  );
});
