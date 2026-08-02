// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI existed. REQUIRED SCENARIO 2: "Individual-vs-group add fork."
// REWRITTEN for Phase 20 task 20.4 (real removal + correct control
// placement, plans/phase-20-tasks.md): the project owner's exact fix spec
// deliberately supersedes this file's own original Phase 19 contract --
// `[data-testid="catalog-add-btn"]` no longer "NEVER disappears and NEVER
// changes behavior"; it is now one half of a simple binary Add/Remove
// toggle (renderCatalogRow), and the +/- stepper that used to live inline
// in the catalog row (`[data-testid="catalog-stepper"]`) has moved into the
// working roster (`[data-testid="working-roster-stepper"]`) alongside a new
// explicit `[data-testid="working-roster-remove-btn"]` [x] control present
// on every row regardless of origin. This file is rewritten to match that
// new contract rather than left disagreeing with the shipped code -- see
// combat-planning-live-recompute.e2e.mjs's own header for the fuller
// picture of what changed and why (task 20.4's root-cause writeup: the
// stepper only ever decremented, never removed a row, and individual-origin
// combatants had no removal control anywhere at all).
//
// ---------------------------------------------------------------------------
// THE FORK, AS IT NOW WORKS (task 20.4):
// ---------------------------------------------------------------------------
//   - A catalog row shows `[data-testid="catalog-add-btn"]` ("+ Add") when
//     `entry.id` has NO row of either origin in the working roster yet, or
//     `[data-testid="catalog-remove-btn"]` ("Remove") once it has ANY row
//     (group or individual). Clicking Add pushes ONE new
//     `[data-testid="working-combatant-row"][data-origin="individual"]`
//     (count 1, a unique `data-instance-id`). Clicking Remove clears EVERY
//     row (group and individual alike) for that entryId in one shot and
//     flips the catalog row back to Add. This deliberately means a SECOND
//     individual instance of the SAME entry is no longer stackable via the
//     catalog once the first exists (a real, intentional capability
//     reduction -- a DM wanting N identical monsters now uses a
//     difficulty-tier auto-suggestion's own group-row stepper instead,
//     which already supports an arbitrary count). PART 1 below exercises
//     this with two DIFFERENT entries specifically to prove removal is
//     scoped to the ROW that was removed, not every individual row in the
//     roster.
//   - A `data-origin="group"` row is still created ONLY by a difficulty-tier
//     auto-suggestion (mirroring suggestEncounter's own native
//     `{entryId,count}` combination shape 1:1), never by `+Add`. Its +/-
//     stepper now lives in the WORKING ROSTER, not the catalog:
//     `[data-testid="working-roster-stepper"]` containing
//     `[data-testid="working-roster-stepper-minus"]` /
//     `[data-testid="working-roster-stepper-plus"]`, adjusting that same
//     row's `[data-testid="working-combatant-count"]` in place. Unlike
//     Phase 19's catalog stepper (which clamped at a minimum of 1 and could
//     never remove the row), `-` at count 1 now removes the row entirely.
//     PART 2 below exercises both the in-place increment AND the
//     remove-at-zero behavior.
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
let individualEntryA, individualEntryB, groupEntry;

before(async () => {
  individualEntryA = await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Addfork Individual Kobold A" }) });
  individualEntryB = await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Addfork Individual Kobold B" }) });
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

test("PART 1 -- catalog Add/Remove toggle: adding one entry via the catalog creates its individual row and flips ITS OWN row to Remove, leaving an independently-added second entry's row (and Add/Remove state) untouched", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const rowA = page.locator(`[data-testid="catalog-row"][data-entry-id="${individualEntryA.id}"]`);
  const rowB = page.locator(`[data-testid="catalog-row"][data-entry-id="${individualEntryB.id}"]`);
  await rowA.waitFor({ state: "visible", timeout: 15000 });
  await rowB.waitFor({ state: "visible", timeout: 15000 });

  // Both start as "+ Add" (neither is in the working roster yet).
  await rowA.locator('[data-testid="catalog-add-btn"]').waitFor({ state: "visible", timeout: 5000 });
  await rowB.locator('[data-testid="catalog-add-btn"]').waitFor({ state: "visible", timeout: 5000 });

  // --- Add entry A ---
  await rowA.locator('[data-testid="catalog-add-btn"]').click();
  const workingRowA = page.locator(`[data-testid="working-combatant-row"][data-entry-id="${individualEntryA.id}"][data-origin="individual"]`);
  await workingRowA.waitFor({ state: "visible", timeout: 10000 });
  await assert.doesNotReject(
    async () => rowA.locator('[data-testid="catalog-remove-btn"]').waitFor({ state: "visible", timeout: 5000 }),
    "entry A's catalog row must flip to 'Remove' once it has a row in the working roster"
  );
  assert.equal(await rowA.locator('[data-testid="catalog-add-btn"]').count(), 0, "entry A's catalog row must no longer show '+ Add' while it's in the roster");

  // Entry B is untouched by entry A's add.
  assert.equal(await rowB.locator('[data-testid="catalog-add-btn"]').count(), 1, "entry B's catalog row must still show '+ Add' -- unaffected by entry A's own add");

  // --- Add entry B too (two separate +Add clicks on two DIFFERENT catalog rows -> two independently-tracked individual rows) ---
  await rowB.locator('[data-testid="catalog-add-btn"]').click();
  const workingRowB = page.locator(`[data-testid="working-combatant-row"][data-entry-id="${individualEntryB.id}"][data-origin="individual"]`);
  await workingRowB.waitFor({ state: "visible", timeout: 10000 });
  await rowB.locator('[data-testid="catalog-remove-btn"]').waitFor({ state: "visible", timeout: 5000 });

  assert.notEqual(
    await workingRowA.getAttribute("data-instance-id"),
    await workingRowB.getAttribute("data-instance-id"),
    "the two independently-added individual rows must carry distinct data-instance-id values"
  );

  // --- Remove entry A's row via the working roster's own [x] -- must clear
  //     ONLY entry A (both from the roster and back to "+ Add" on the
  //     catalog), leaving entry B's row and Remove-state fully untouched. ---
  await workingRowA.locator('[data-testid="working-roster-remove-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (entryId) => document.querySelectorAll(`[data-testid="working-combatant-row"][data-entry-id="${entryId}"]`).length === 0,
      individualEntryA.id,
      { timeout: 10000 }
    );
  }, "removing entry A's row via its own [x] must clear it from the working roster");

  await assert.doesNotReject(
    async () => rowA.locator('[data-testid="catalog-add-btn"]').waitFor({ state: "visible", timeout: 5000 }),
    "entry A's catalog row must flip back to '+ Add' once its last row is removed from the working roster"
  );

  // Entry B's own row and Remove-state must be completely untouched.
  assert.equal(await workingRowB.count(), 1, "entry B's individual row must be untouched by entry A's removal");
  assert.equal(await rowB.locator('[data-testid="catalog-remove-btn"]').count(), 1, "entry B's catalog row must still show 'Remove' -- unaffected by entry A's removal");
});

test("PART 2 -- the working roster's own +/- stepper on an already-present GROUP row increments/decrements its count in place, never creating a new row, and removes the row entirely once it reaches zero rather than leaving a zero-count ghost", async () => {
  // Establishes a data-origin="group" row for groupEntry the ONLY way this
  // contract creates one: a difficulty-tier auto-suggestion. Uses a low
  // target so the greedy auto-fill (encounter-heuristic.mjs's
  // buildCombination) is very likely to pick groupEntry at all -- if it
  // doesn't for some reason, this test's own first assertion (waiting for
  // the group row to exist) fails clearly rather than silently passing on
  // the wrong row.
  await page.locator('[data-testid="difficulty-tier"][data-tier="easy"]').click();

  const groupRow = page.locator(`[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"][data-origin="group"]`);
  await assert.doesNotReject(
    async () => groupRow.waitFor({ state: "visible", timeout: 10000 }),
    "setup precondition: the Easy-tier auto-suggestion is expected to include groupEntry (a light, single-attack wolf) as a data-origin=\"group\" working-combatant-row -- if this fails, the fixture's target monster wasn't auto-picked, not a bug in the stepper mechanism itself"
  );

  // The stepper now lives in the WORKING ROSTER, never the catalog row.
  const catalogRow = page.locator(`[data-testid="catalog-row"][data-entry-id="${groupEntry.id}"]`);
  assert.equal(await catalogRow.locator('[data-testid="catalog-stepper"]').count(), 0, "no stepper of any kind belongs in the catalog row anymore (task 20.4)");
  await catalogRow.locator('[data-testid="catalog-remove-btn"]').waitFor({ state: "visible", timeout: 5000 });

  const stepper = groupRow.locator('[data-testid="working-roster-stepper"]');
  await stepper.waitFor({ state: "visible", timeout: 5000 });
  const countBefore = Number((await groupRow.locator('[data-testid="working-combatant-count"]').textContent()).trim());
  assert.ok(Number.isFinite(countBefore) && countBefore >= 1, `working-combatant-count must render a real positive integer; got ${countBefore}`);

  // --- + increments in place, no new row ---
  const rowCountBefore = await page.locator(`[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"]`).count();
  await stepper.locator('[data-testid="working-roster-stepper-plus"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      ({ selector, prev }) => Number(document.querySelector(selector)?.textContent?.trim()) === prev + 1,
      { selector: `[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"][data-origin="group"] [data-testid="working-combatant-count"]`, prev: countBefore },
      { timeout: 10000 }
    );
  }, `clicking the stepper's + button must increment the SAME group row's count from ${countBefore} to ${countBefore + 1} in place`);
  const rowCountAfterPlus = await page.locator(`[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"]`).count();
  assert.equal(rowCountAfterPlus, rowCountBefore, "the stepper must never create a NEW working-combatant-row");

  // --- drive count back down to 1 with repeated '-' clicks, then one more
  //     '-' at count 1 must remove the row entirely (task 20.4's real gap
  //     #1: the old catalog stepper could only ever clamp at 1, never
  //     remove) ---
  let currentCount = countBefore + 1;
  while (currentCount > 1) {
    const prev = currentCount;
    await stepper.locator('[data-testid="working-roster-stepper-minus"]').click();
    await assert.doesNotReject(async () => {
      await page.waitForFunction(
        ({ selector, prevVal }) => Number(document.querySelector(selector)?.textContent?.trim()) === prevVal - 1,
        { selector: `[data-testid="working-combatant-row"][data-entry-id="${groupEntry.id}"][data-origin="group"] [data-testid="working-combatant-count"]`, prevVal: prev },
        { timeout: 10000 }
      );
    }, `clicking '-' must decrement the count from ${prev} to ${prev - 1}`);
    currentCount -= 1;
  }

  await stepper.locator('[data-testid="working-roster-stepper-minus"]').click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (entryId) => document.querySelectorAll(`[data-testid="working-combatant-row"][data-entry-id="${entryId}"][data-origin="group"]`).length === 0,
      groupEntry.id,
      { timeout: 10000 }
    );
  }, "'-' at count 1 must remove the group row entirely, not leave a zero-count ghost row");

  await assert.doesNotReject(
    async () => catalogRow.locator('[data-testid="catalog-add-btn"]').waitFor({ state: "visible", timeout: 5000 }),
    "the catalog row must flip back to '+ Add' once the group row it tracked is fully removed"
  );
});
