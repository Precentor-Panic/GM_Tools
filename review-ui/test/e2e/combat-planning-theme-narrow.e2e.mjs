// Phase 20 task 20.5 -- "Narrow by theme" doesn't work when actually used.
//
// ---------------------------------------------------------------------------
// ROOT CAUSE, CONFIRMED BY REAL REPRODUCTION (not guessed):
// ---------------------------------------------------------------------------
// review-ui/server.mjs's POST /api/combat-planning/encounter-suggest, when
// `themeText` is non-blank, used to call `loadSnapshot(dir, w)`
// UNCONDITIONALLY to build the theme-proposal's scene-grounding context --
// but `loadSnapshot` THROWS ("No World Fabric snapshot found for world
// ...") the instant that world has never had a WF snapshot exported. Combat
// Planning's own bestiary/party-roster stores are DELIBERATELY NOT
// graph-backed (design record §1a, confirmed by
// combat-planning-fixture.mjs's own primeWorldSelection header: "this suite
// has no snapshot file for GET /api/worlds to discover at all"), and
// review-ui/public/combat-planning-view.js's onThemeSubmit never sends a
// sceneEntityId at all (Encounter Builder has no scene concept anywhere in
// this view) -- so narrowing by theme threw a hard, opaque error for any
// world without a live/ever-exported WF snapshot: exactly the real "just
// using Encounter Builder standalone" case, well before proposeThematicTags
// was ever reached. Confirmed via a direct reproduction script hitting the
// real (unmocked) route against a world with no snapshot file (400,
// "No World Fabric snapshot found..."), and confirmed the SAME request
// against a world WITH a snapshot instead reaches the real LLM call
// boundary (502, no API key configured in this environment -- the expected,
// environment-specific failure every other themeText test in this suite
// already asserts). Fixed by only loading the snapshot when one actually
// exists on disk, degrading to an ungrounded scene context otherwise --
// see review-ui/test/combat-planning-routes.test.mjs for the route-level
// regression test proving this exact fix (a themed request against a
// snapshot-less world no longer 400s).
//
// ---------------------------------------------------------------------------
// THIS FILE'S OWN JOB: prove the UI actually APPLIES a narrowed response
// ---------------------------------------------------------------------------
// The route-level fix above proves the request no longer breaks before
// reaching the LLM call. This file proves the OTHER half of task 20.5's own
// instructions -- "does the UI correctly apply/render the narrowed result"
// -- by fully mocking a themed encounter-suggest response (this project's
// established page.route()-based convention for this view's two genuinely
// LLM-backed submit actions, see combat-planning-loading-scope.e2e.mjs's own
// header for the full grounding on why: no ANTHROPIC_API_KEY in this build
// environment) that narrows the pool down to ONE specific monster, then
// asserting the rendered working roster reflects EXACTLY that narrowed
// result -- not merely that a request was sent.
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

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-theme-narrow-");
const WORLD = "e2e-cp-theme-narrow-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let wideEntry, narrowEntry;

before(async () => {
  // Two accepted catalog entries -- the mocked themed response below
  // narrows the pool down to ONLY narrowEntry, deliberately excluding
  // wideEntry, so a real assertion on the RENDERED result (not just "a
  // request happened") is possible.
  wideEntry = await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Theme Narrow Excluded Bandit" }) });
  narrowEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({ name: "Theme Narrow Included Wight", type: "undead", hp: 45, ac: 14 })
  });
  await seedPartyMember(WORLD, { name: "Theme Narrow PC", combatRelevant: { class: "Cleric", level: 6, ac: 17, hp: 48, damagePerRoundEstimate: 14 } });

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

test("typing a theme and submitting renders the ACTUAL narrowed pool the mocked response returned, not just fires a request", async () => {
  await primeWorldSelection(page, base, WORLD);

  // Only intercept+fulfill the THEMED call (a request body carrying a
  // non-empty themeText), matching combat-planning-loading-scope.e2e.mjs's
  // own established convention exactly -- anything else hitting this route
  // falls through to the real server so this test fails loudly, not
  // silently, if the implementation calls encounter-suggest unexpectedly.
  let themedRequestBody = null;
  await page.route("**/api/combat-planning/encounter-suggest", async (route) => {
    const body = route.request().postDataJSON();
    if (!body?.themeText || !body.themeText.trim()) {
      return route.continue();
    }
    themedRequestBody = body;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        suggestion: {
          combination: [{ entryId: narrowEntry.id, count: 2 }],
          expectedScore: 12.5,
          burstCeiling: 0,
          snowballDelta: {
            topDamageContributorId: "x", topDamageContributorDelta: 0,
            topEffectiveHpContributorId: "x", topEffectiveHpContributorDelta: 0
          },
          asymmetricRiskFlag: false
        }
      })
    });
  });

  await page.goto(`${base}/#combat-planning`);
  const themeInput = page.locator('[data-testid="theme-text-input"]');
  await themeInput.waitFor({ state: "visible", timeout: 15000 });
  await themeInput.fill("undead crypt");
  await page.locator('[data-testid="theme-submit-btn"]').click();

  const narrowRow = page.locator(`[data-testid="working-combatant-row"][data-entry-id="${narrowEntry.id}"]`);
  await assert.doesNotReject(
    async () => narrowRow.waitFor({ state: "visible", timeout: 10000 }),
    "the working roster must render the narrowed entry the mocked themed response returned"
  );

  assert.equal(
    (await narrowRow.locator('[data-testid="working-combatant-count"]').textContent()).trim(),
    "2",
    "the rendered row must reflect the mocked response's own count, not a fabricated/default one"
  );

  assert.equal(
    await page.locator(`[data-testid="working-combatant-row"][data-entry-id="${wideEntry.id}"]`).count(),
    0,
    "the entry the mocked response DELIBERATELY excluded from the narrowed pool must not appear in the rendered working roster"
  );

  assert.equal(await page.locator('[data-testid="working-combatant-row"]').count(), 1, "the working roster must show EXACTLY the narrowed combination, nothing extra left over from before the theme submit");

  assert.ok(themedRequestBody, "the themed request must actually have been sent");
  assert.equal(themedRequestBody.themeText, "undead crypt", "the request body must carry the exact typed theme text");

  await page.unroute("**/api/combat-planning/encounter-suggest");
});
