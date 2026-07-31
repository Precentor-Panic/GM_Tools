// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 3: "Confidence-encoded score format,
// three states in the same layout slot." EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- see
// combat-planning-live-recompute.e2e.mjs's header for the full shared DOM
// contract.
//
// See combat-planning-fixture.mjs's header ("SCORE-CONFIDENCE derivedScore
// SHAPE") for why this test seeds `derivedScore` directly via
// saveBestiaryEntry (bypassing the still-unresolved "combat system profile"
// SCORING-COMPUTATION question entirely -- Phase 18 never actually computes
// or persists this field in production, see that header for the full
// grounding) -- this file is a pure DISPLAY-CONTRACT spec: given each of the
// three `derivedScore` shapes below, what must the catalog row render, and
// where.
//
// ---------------------------------------------------------------------------
// PER-ROW SCORE-CHIP CONTRACT (task 19.5, design record's confidence-
// encoding requirement + its round-3 refinement that a banded/fuzzy range
// must carry its "why fuzzy" note ATTACHED, not hover-only):
// ---------------------------------------------------------------------------
//   - `[data-testid="catalog-score-chip"][data-confidence-state="solid"|"banded"|"unscored"]`
//     -- ONE consistent wrapping slot/DOM position per row, regardless of
//     state (this is what PART 2 below measures via real bounding boxes,
//     this project's established real-measurement convention -- see
//     rubber-band-listener-leak.e2e.mjs's own `.boundingBox()` use).
//   - state "solid" (derivedScore = {scored:true, confidence:"solid",
//     value:14.2, ...}): `[data-testid="catalog-score-value"]` renders the
//     plain decimal (e.g. "14.2"), no dashed/outlined styling.
//   - state "banded" (derivedScore = {scored:true, confidence:"banded",
//     rangeLow:10, rangeHigh:16, fuzzyNote:"..."}):
//     `[data-testid="catalog-score-range"]` renders a banded-range string
//     (containing both `rangeLow` and `rangeHigh`, e.g. "10-16" or
//     "Moderate (10-16 est.)" -- exact prose not asserted, only that both
//     numbers appear) in a visually distinct dashed/outlined treatment
//     (asserted via a real computed-style check, not just presence), PLUS
//     `[data-testid="catalog-score-fuzzy-note"]` rendered INLINE, in the
//     DOM, unconditionally visible (not `display:none` pending a `:hover`)
//     -- this test asserts its computed `display` is not `"none"` without
//     any hover simulation, directly proving "attached, not hover-only."
//   - state "unscored" (derivedScore = null, OR {scored:false,
//     confidence:"unscored", reason:"..."}): `[data-testid="catalog-score-unscored-pill"]`
//     containing the literal text "Unscored" and "reference only" (design
//     record's own exact copy: "Unscored -- reference only").
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupScratchEnv,
  cleanupScratchEnv,
  DESKTOP_VIEWPORT,
  primeWorldSelection,
  seedAcceptedBestiaryEntry,
  fullProfileRawFields,
  SOLID_DERIVED_SCORE,
  BANDED_DERIVED_SCORE,
  UNSCORED_DERIVED_SCORE
} from "./combat-planning-fixture.mjs";

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-confidence-");
const WORLD = "e2e-cp-confidence-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let solidEntry, bandedEntry, unscoredEntry;

before(async () => {
  solidEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Confidence Solid Goblin" }),
    derivedScore: SOLID_DERIVED_SCORE
  });
  bandedEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Confidence Banded Homebrew Beast" }),
    derivedScore: BANDED_DERIVED_SCORE
  });
  unscoredEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Confidence Unscored Reference Note" }),
    derivedScore: UNSCORED_DERIVED_SCORE
  });

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

test("PART 1 -- each of the three derivedScore states renders its own correct content in catalog-score-chip", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const solidChip = page.locator(`[data-testid="catalog-row"][data-entry-id="${solidEntry.id}"] [data-testid="catalog-score-chip"]`);
  await solidChip.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await solidChip.getAttribute("data-confidence-state"), "solid");
  const solidValueText = (await solidChip.locator('[data-testid="catalog-score-value"]').textContent()).trim();
  assert.ok(solidValueText.includes("14.2"), `solid chip must render the plain decimal value; got "${solidValueText}"`);

  const bandedChip = page.locator(`[data-testid="catalog-row"][data-entry-id="${bandedEntry.id}"] [data-testid="catalog-score-chip"]`);
  assert.equal(await bandedChip.getAttribute("data-confidence-state"), "banded");
  const bandedRangeText = (await bandedChip.locator('[data-testid="catalog-score-range"]').textContent()).trim();
  assert.ok(bandedRangeText.includes("10") && bandedRangeText.includes("16"), `banded chip must render both range bounds; got "${bandedRangeText}"`);
  const fuzzyNoteEl = bandedChip.locator('[data-testid="catalog-score-fuzzy-note"]');
  await fuzzyNoteEl.waitFor({ state: "attached", timeout: 5000 });
  const fuzzyNoteDisplay = await fuzzyNoteEl.evaluate((el) => getComputedStyle(el).display);
  assert.notEqual(fuzzyNoteDisplay, "none", "the 'why fuzzy' note must be unconditionally rendered/visible (display !== none) with NO hover simulation performed -- a hover-to-discover tooltip fails this assertion");
  const fuzzyNoteText = (await fuzzyNoteEl.textContent()).trim();
  assert.ok(fuzzyNoteText.length > 0, "the fuzzy note must contain real explanatory text, not be empty");

  const unscoredChip = page.locator(`[data-testid="catalog-row"][data-entry-id="${unscoredEntry.id}"] [data-testid="catalog-score-chip"]`);
  assert.equal(await unscoredChip.getAttribute("data-confidence-state"), "unscored");
  const unscoredPillText = (await unscoredChip.locator('[data-testid="catalog-score-unscored-pill"]').textContent()).trim();
  assert.ok(unscoredPillText.includes("Unscored") && unscoredPillText.toLowerCase().includes("reference only"), `unscored chip must render the design record's exact copy "Unscored -- reference only"; got "${unscoredPillText}"`);
});

test("PART 2 -- all three confidence states occupy the IDENTICAL layout slot (real bounding-box comparison, not just presence)", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const chipSelector = (entryId) => `[data-testid="catalog-row"][data-entry-id="${entryId}"] [data-testid="catalog-score-chip"]`;
  const solidChip = page.locator(chipSelector(solidEntry.id));
  await solidChip.waitFor({ state: "visible", timeout: 15000 });
  const bandedChip = page.locator(chipSelector(bandedEntry.id));
  const unscoredChip = page.locator(chipSelector(unscoredEntry.id));

  const [solidBox, bandedBox, unscoredBox] = await Promise.all([
    solidChip.boundingBox(),
    bandedChip.boundingBox(),
    unscoredChip.boundingBox()
  ]);

  for (const [label, box] of [["solid", solidBox], ["banded", bandedBox], ["unscored", unscoredBox]]) {
    assert.ok(box, `${label} chip must have a real, measurable bounding box (must not be display:none/collapsed)`);
  }

  // Rows are siblings in the same catalog list/grid, each with a fixed-width
  // score-chip column -- so the chip SLOT's width/height must be identical
  // across all three states even though their x/y naturally differ (each
  // row sits at a different vertical position). A tolerance of 1px absorbs
  // sub-pixel layout rounding, never a real size difference.
  const TOLERANCE_PX = 1;
  assert.ok(
    Math.abs(solidBox.width - bandedBox.width) <= TOLERANCE_PX && Math.abs(solidBox.width - unscoredBox.width) <= TOLERANCE_PX,
    `catalog-score-chip width must be identical across all three confidence states (within ${TOLERANCE_PX}px); got solid=${solidBox.width}, banded=${bandedBox.width}, unscored=${unscoredBox.width}`
  );
  assert.ok(
    Math.abs(solidBox.height - bandedBox.height) <= TOLERANCE_PX && Math.abs(solidBox.height - unscoredBox.height) <= TOLERANCE_PX,
    `catalog-score-chip height must be identical across all three confidence states (within ${TOLERANCE_PX}px); got solid=${solidBox.height}, banded=${bandedBox.height}, unscored=${unscoredBox.height}`
  );
  // Same horizontal offset (x) too -- proves it's the same COLUMN, not just
  // coincidentally-equal-sized elements floating at different horizontal
  // positions in an otherwise inconsistent layout.
  assert.ok(
    Math.abs(solidBox.x - bandedBox.x) <= TOLERANCE_PX && Math.abs(solidBox.x - unscoredBox.x) <= TOLERANCE_PX,
    `catalog-score-chip horizontal position (x) must be identical across all three confidence states (same column, within ${TOLERANCE_PX}px); got solid=${solidBox.x}, banded=${bandedBox.x}, unscored=${unscoredBox.x}`
  );
});
