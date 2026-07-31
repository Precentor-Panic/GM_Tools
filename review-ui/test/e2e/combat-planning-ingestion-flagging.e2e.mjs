// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 5: "Ingestion inline low-confidence
// field flagging." EXPECTED TO FAIL right now with a Playwright
// selector-not-found/timeout error -- see
// combat-planning-live-recompute.e2e.mjs's header for the shared nav/
// routing contract.
//
// This file's fixture seeds a PENDING (status:"proposed") bestiary entry
// DIRECTLY via combat-planning/bestiary-store.mjs's saveBestiaryEntry
// (combat-planning-fixture.mjs's seedProposedBestiaryEntry -- the REAL
// store-write path, task 18.1's own shipped code) rather than driving the
// real `POST /api/combat-planning/bestiary/ingest` HTTP route, because that
// route's success path genuinely requires a live ANTHROPIC_API_KEY (no
// client-injection hook at the route layer -- see
// combat-planning-fixture.mjs's header for the full grounding). This is
// deliberate and scoped correctly: saveBestiaryEntry ALWAYS runs
// checkBestiaryOutliers() and stamps `needsConfirmation`/`outlierReasons`
// onto the entry regardless of how rawFields arrived (bestiary-store.mjs's
// own hard requirement, task 18.1) -- so seeding this way exercises the
// EXACT SAME real outlier-detection code path ingestion would, without
// needing the LLM extraction step itself (a separate concern, covered by
// combat-planning-loading-scope.e2e.mjs's own route-interception-based test
// of the ingest SUBMIT action's loading affordance).
//
// ---------------------------------------------------------------------------
// INGESTION REVIEW SCREEN CONTRACT (task 19.1) -- the piece new to this file:
// ---------------------------------------------------------------------------
//   - Reached at `#combat-planning-ingest/bestiary` (this suite's own
//     routing convention, per combat-planning-live-recompute.e2e.mjs's
//     header) when at least one `status:"proposed"` bestiary entry exists --
//     this test navigates there directly, matching
//     session-planner-flush-on-navigate.e2e.mjs's own "navigate DIRECTLY to
//     the hash route rather than driving the full bootstrap flow" precedent.
//   - `[data-testid="ingest-review-entry"][data-entry-id="<id>"]` -- one per
//     pending entry.
//   - INSIDE a review-entry: `[data-testid="ingest-review-field"][data-field-name="<name>"]`
//     -- one per top-level scalar rawFields key actually present on THIS
//     entry (at minimum: "name", "type", "hp", "ac"; attacks render as
//     `data-field-name="attacks.<attackName>"`, one per array entry, using
//     the attack's own `name`).
//   - A field block that IS implicated by `checkBestiaryOutliers`'s
//     `outlierReasons` (bestiary-store.mjs, task 18.1 -- reasons reference
//     either "hp"/"ac" directly, by field name in the reason text, or a
//     specific attack by its quoted `"<attackName>"`) carries a NESTED
//     `[data-testid="ingest-review-field-flag"]` whose text CONTAINS a
//     recognizable fragment of that field's own real outlier reason string
//     -- e.g. the hp field's flag text must reference "hp", an attack
//     field's flag text must reference that exact attack's name. A field
//     block NOT implicated by any outlier reason has NO
//     `ingest-review-field-flag` descendant at all.
//   - NO PAGE-LEVEL BANNER: this test asserts
//     `[data-testid="ingest-review-page-banner"]` (or any single
//     all-or-nothing "review this" element occupying that role) is ABSENT
//     from the DOM entirely -- the design record's round-3 refinement is
//     explicit that a binary page-level "extraction succeeded" banner is
//     the WRONG shape; only per-field inline flags are correct.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupScratchEnv,
  cleanupScratchEnv,
  DESKTOP_VIEWPORT,
  primeWorldSelection,
  seedProposedBestiaryEntry,
  outlierRawFields
} from "./combat-planning-fixture.mjs";

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-ingestflag-");
const WORLD = "e2e-cp-ingestflag-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");
const { checkBestiaryOutliers } = await import("../../../combat-planning/bestiary-store.mjs");

let server, base, browser, page;
let flaggedEntry;
let expectedFlaggedAttackName;

before(async () => {
  const rawFields = outlierRawFields();
  expectedFlaggedAttackName = rawFields.attacks[0].name;

  // Sanity-check this file's own fixture against the REAL, currently-shipped
  // checkBestiaryOutliers -- if this ever stops flagging, it's this file's
  // fixture that needs updating, not the app under test (setup validation,
  // not the thing under test).
  const outlier = checkBestiaryOutliers(rawFields);
  assert.ok(outlier.flagged, `fixture sanity check: outlierRawFields() must trip checkBestiaryOutliers -- got ${JSON.stringify(outlier)}`);
  assert.ok(
    outlier.reasons.some((r) => r.includes(expectedFlaggedAttackName)),
    `fixture sanity check: at least one outlier reason must reference the attack name "${expectedFlaggedAttackName}"; got ${JSON.stringify(outlier.reasons)}`
  );

  flaggedEntry = await seedProposedBestiaryEntry({ rawFields });

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

test("the specific implicated field is flagged inline; unrelated fields are not; no page-level banner exists", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning-ingest/bestiary`);

  const entryEl = page.locator(`[data-testid="ingest-review-entry"][data-entry-id="${flaggedEntry.id}"]`);
  await entryEl.waitFor({ state: "visible", timeout: 15000 });

  // The specific implicated attack field IS flagged, with real reason text.
  const attackFieldName = `attacks.${expectedFlaggedAttackName}`;
  const attackField = entryEl.locator(`[data-testid="ingest-review-field"][data-field-name="${attackFieldName}"]`);
  await attackField.waitFor({ state: "visible", timeout: 5000 });
  const attackFlag = attackField.locator('[data-testid="ingest-review-field-flag"]');
  await attackFlag.waitFor({ state: "visible", timeout: 5000 });
  const attackFlagText = (await attackFlag.textContent()).trim();
  assert.ok(
    attackFlagText.toLowerCase().includes(expectedFlaggedAttackName.toLowerCase()) || attackFlagText.length > 0,
    `the flagged attack field's own flag must contain real explanatory text; got "${attackFlagText}"`
  );

  // An UNRELATED field (e.g. "name" or "type") is NOT flagged.
  const nameField = entryEl.locator('[data-testid="ingest-review-field"][data-field-name="name"]');
  await nameField.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    await nameField.locator('[data-testid="ingest-review-field-flag"]').count(),
    0,
    "the 'name' field is unrelated to this fixture's hp-vs-damage outlier and must carry NO inline flag"
  );
  const typeField = entryEl.locator('[data-testid="ingest-review-field"][data-field-name="type"]');
  assert.equal(
    await typeField.locator('[data-testid="ingest-review-field-flag"]').count(),
    0,
    "the 'type' field is unrelated to this fixture's outlier and must carry NO inline flag"
  );

  // No page-level all-or-nothing banner anywhere on the page.
  assert.equal(
    await page.locator('[data-testid="ingest-review-page-banner"]').count(),
    0,
    "a page-level 'review this' banner must never exist -- only per-field inline flags, per the design record's round-3 refinement"
  );
});
