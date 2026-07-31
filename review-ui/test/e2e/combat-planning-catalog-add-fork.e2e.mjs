// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 2: "Individual-vs-group add fork."
// EXPECTED TO FAIL right now with a Playwright selector-not-found/timeout
// error -- see combat-planning-live-recompute.e2e.mjs's header for the full
// shared DOM contract and the required (currently unshipped) encounter-
// suggest route extensions this whole suite depends on; this file's header
// covers only the add-fork mechanics specific to this scenario.
//
// ---------------------------------------------------------------------------
// THE FORK, RESOLVED PRECISELY (design record §1: "a +Add per row on repeat
// click creates individually-tracked combatants; once a row exists in the
// working roster, a +/- stepper appears for a shared-count group, mirroring
// D&D Beyond's individual-vs-mob fork" -- plans/phase-19-tasks.md task 19.0's
// own scenario 2 wording: "click +Add on the SAME catalog row twice: assert
// TWO individually-tracked combatant rows exist (not one row with count 2).
// Then click the +/- stepper on an ALREADY-PRESENT group: assert the count
// increments in place, no new row created."):
//
// These are TWO INDEPENDENT ORIGINS for a working-roster entry, not one
// button that changes behavior after its first click -- resolved this way
// specifically because the task's own wording requires `+Add` to keep
// creating NEW individual rows on a SECOND click on the SAME row (if the
// button instead swapped to a stepper after the first click, a second click
// couldn't be "+Add" at all):
//   - `[data-testid="catalog-add-btn"]` (a row's "+Add" button) NEVER
//     disappears and NEVER changes behavior -- EVERY click on it adds ONE
//     MORE `[data-testid="working-combatant-row"][data-entry-id="<id>"][data-origin="individual"][data-instance-id="<n>"]`
//     to the working roster, each with count exactly 1, uniquely
//     `data-instance-id`'d. Two clicks -> two rows. This is PART 1 below.
//   - A `[data-testid="working-combatant-row"][data-origin="group"]` row is
//     created ONLY by a difficulty-tier auto-suggestion (mirroring
//     suggestEncounter's own native `{entryId,count}` combination shape
//     1:1, per combat-planning-live-recompute.e2e.mjs's header) -- NEVER by
//     a catalog `+Add` click. Once such a group row exists for a given
//     entryId, that entryId's OWN catalog row ADDITIONALLY renders
//     `[data-testid="catalog-stepper"]` (alongside, not instead of,
//     `catalog-add-btn`) containing `[data-testid="catalog-stepper-minus"]`
//     / `[data-testid="catalog-stepper-count"]` / `[data-testid="catalog-stepper-plus"]`.
//     Clicking `catalog-stepper-plus`/`-minus` increments/decrements THAT
//     SAME group row's `[data-testid="working-combatant-count"]` IN PLACE
//     -- no new working-combatant-row is ever created by the stepper. This
//     is PART 2 below, deliberately set up via a difficulty-tier click (the
//     ONLY thing that creates a `data-origin="group"` row) rather than via
//     `+Add`, so the two halves never collide on the same row/entryId and
//     this test never has to arbitrate a merge between the two origins (out
//     of scope for this phase's contract -- not required by the design
//     record, and not invented here).
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

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-addfork-");
const WORLD = "e2e-cp-addfork-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let individualEntry, groupEntry;

before(async () => {
  individualEntry = await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Addfork Individual Kobold" }) });
  groupEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Addfork Group Wolf", hp: 11, ac: 13, attacks: [{ name: "Bite", toHitBonus: 4, damageDice: "2d4+2", damageType: "piercing" }] })
  });
  await seedPartyMember(WORLD, { name: "Addfork PC", combatRelevant: { class: "Ranger", level: 3, ac: 15, hp: 28, attackBonus: 5, damagePerRoundEstimate: 12 } });

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

test("PART 1 -- repeated +Add clicks on the same catalog row create separate individually-tracked rows, never one row with an incremented count", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const catalogRow = page.locator(`[data-testid="catalog-row"][data-entry-id="${individualEntry.id}"]`);
  await catalogRow.waitFor({ state: "visible", timeout: 15000 });
  const addBtn = catalogRow.locator('[data-testid="catalog-add-btn"]');

  await addBtn.click();
  const firstIndividualRow = page.locator(
    `[data-testid="working-combatant-row"][data-entry-id="${individualEntry.id}"][data-origin="individual"]`
  );
  await firstIndividualRow.first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await firstIndividualRow.count(), 1, "exactly one individually-tracked row after the first +Add click");

  await addBtn.click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (entryId) =>
        document.querySelectorAll(
          `[data-testid="working-combatant-row"][data-entry-id="${entryId}"][data-origin="individual"]`
        ).length === 2,
      individualEntry.id,
      { timeout: 10000 }
    );
  }, "a second +Add click on the SAME catalog row must produce a SECOND, separate individually-tracked working-combatant-row -- not increment the first row's own count");

  const individualRows = page.locator(
    `[data-testid="working-combatant-row"][data-entry-id="${individualEntry.id}"][data-origin="individual"]`
  );
  const instanceIds = await individualRows.evaluateAll((els) => els.map((el) => el.getAttribute("data-instance-id")));
  assert.equal(new Set(instanceIds).size, 2, `the two individual rows must carry two DISTINCT data-instance-id values; got ${JSON.stringify(instanceIds)}`);

  // Sanity: no stray group-origin row was created by these two +Add clicks.
  assert.equal(
    await page.locator(`[data-testid="working-combatant-row"][data-entry-id="${individualEntry.id}"][data-origin="group"]`).count(),
    0,
    "+Add must never create a data-origin=\"group\" row -- that origin is exclusively created by a difficulty-tier auto-suggestion"
  );
});

test("PART 2 -- the +/- stepper on an already-present GROUP row increments its count in place, never creating a new row", async () => {
  // Establishes a data-origin="group" row for groupEntry the ONLY way this
  // contract creates one: a difficulty-tier auto-suggestion. Uses a low
  // target so the greedy auto-fill (encounter-heuristic.mjs's
  // buildCombination) is very likely to pick groupEntry at all -- if it
  // doesn't for some reason, this test's own first assertion (waiting for
  // the stepper to exist) fails clearly rather than silently passing on the
  // wrong row.
  await page.locator('[data-testid="difficulty-tier"][data-tier="easy"]').click();

  const catalogRow = page.locator(`[data-testid="catalog-row"][data-entry-id="${groupEntry.id}"]`);
  const stepper = catalogRow.locator('[data-testid="catalog-stepper"]');
  await assert.doesNotReject(
    async () => stepper.waitFor({ state: "visible", timeout: 10000 }),
    "setup precondition: the Easy-tier auto-suggestion is expected to include groupEntry (a light, single-attack wolf) as a data-origin=\"group\" working-combatant-row, which must render a +/- stepper on its own catalog row -- if this fails, the fixture's target monster wasn't auto-picked, not a bug in the stepper mechanism itself"
  );

  const groupRow = page.locator(`[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"][data-origin="group"]`);
  await groupRow.waitFor({ state: "visible", timeout: 5000 });
  const countBefore = Number((await groupRow.locator('[data-testid="working-combatant-count"]').textContent()).trim());
  assert.ok(Number.isFinite(countBefore) && countBefore >= 1, `working-combatant-count must render a real positive integer; got ${countBefore}`);

  const rowCountBefore = await page.locator(`[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"]`).count();

  await stepper.locator('[data-testid="catalog-stepper-plus"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      ({ selector, prev }) => Number(document.querySelector(selector)?.textContent?.trim()) === prev + 1,
      { selector: `[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"][data-origin="group"] [data-testid="working-combatant-count"]`, prev: countBefore },
      { timeout: 10000 }
    );
  }, `clicking the stepper's + button must increment the SAME group row's count from ${countBefore} to ${countBefore + 1} in place`);

  const rowCountAfter = await page.locator(`[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"]`).count();
  assert.equal(
    rowCountAfter,
    rowCountBefore,
    `the stepper must never create a NEW working-combatant-row -- row count for this entryId must stay exactly ${rowCountBefore} (was ${rowCountBefore}, now ${rowCountAfter})`
  );
});
